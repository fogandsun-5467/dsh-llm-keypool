import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/route-pool.js'
import { statusSnapshot } from '../lib/runtime.js'
import { createFakeCtx, requestErrorPayload, requestPayload } from './helpers/fake-ctx.mjs'

/** Keep every test on a private (absent) GUI config file unless it opts in. */
const privateDir = mkdtempSync(join(tmpdir(), 'dsh-keypool-route-pool-'))
process.env.DSH_KEYPOOL_CONFIG = join(privateDir, 'absent.json')

test('reads the pool from the GUI-managed config file instead of the row config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-keypool-gui-'))
  const previous = process.env.DSH_KEYPOOL_CONFIG
  process.env.DSH_KEYPOOL_CONFIG = join(dir, 'route-pool.json')
  try {
    writeFileSync(process.env.DSH_KEYPOOL_CONFIG, JSON.stringify({
      pools: [{
        name: 'gui',
        routes: [
          { provider: 'vendor-a', model: 'model-1' },
          { provider: 'vendor-b', model: 'model-2' },
        ],
      }],
      cooldownMs: 600000,
      maxSwitchesPerTurn: 3,
    }), 'utf8')
    const { ctx, dispatch } = createFakeCtx()
    // The row itself carries no pools: only the GUI file has one.
    apply(ctx, { pools: [] })
    const ask = (provider, model) => dispatch('agent/request', requestPayload(), async () => ({ provider, model }))
    const bad = (provider) => dispatch('agent/request-error', requestErrorPayload({ provider, failure: QUOTA }), async () => TERMINAL)

    assert.deepEqual(await bad('vendor-a'), { kind: 'retry' })
    assert.deepEqual(await ask('vendor-a', 'model-1'), { provider: 'vendor-b', model: 'model-2' })
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
})

const POOL_CONFIG = {
  pools: [
    {
      model: 'deepseek-flash',
      routes: [{ provider: 'route-a' }, { provider: 'route-b' }, { provider: 'route-c' }],
    },
  ],
  cooldownMs: 600000,
  maxSwitchesPerTurn: 3,
}

const TERMINAL = Symbol('terminal')
const QUOTA = { code: 'QUOTA', message: 'insufficient quota: current quota exhausted' }

function setup(overrides = {}) {
  const { ctx, dispatch, disposeAll, logs } = createFakeCtx()
  apply(ctx, { ...POOL_CONFIG, ...overrides })
  return { ctx, dispatch, disposeAll, logs }
}

const resolved = (provider, extra = {}) => ({
  provider,
  model: 'deepseek-flash',
  reasoningEffort: 'high',
  maxTokens: 4096,
  ...extra,
})

async function request(dispatch, provider = 'route-a') {
  return dispatch('agent/request', requestPayload(), async () => resolved(provider))
}

async function fail(dispatch, provider = 'route-a', failure = QUOTA, turn = 1, agent = undefined) {
  const payload = requestErrorPayload({ provider, failure, turn, ...(agent === undefined ? {} : { agent }) })
  return dispatch('agent/request-error', payload, async () => TERMINAL)
}

test('keeps the selected route while it is healthy', async () => {
  const { dispatch } = setup()
  const result = await request(dispatch)
  assert.equal(result.provider, 'route-a')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.maxTokens, 4096)
})

test('a quota failure cools the route, asks for a retry, and the retry reroutes', async () => {
  const { dispatch } = setup()
  assert.deepEqual(await fail(dispatch), { kind: 'retry' })
  const result = await request(dispatch, 'route-a')
  assert.equal(result.provider, 'route-b')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.reasoningEffort, 'high')
})

test('walks past a second cooling route to the third one', async () => {
  const { dispatch } = setup()
  assert.deepEqual(await fail(dispatch, 'route-a'), { kind: 'retry' })
  assert.deepEqual(await fail(dispatch, 'route-b'), { kind: 'retry' })
  assert.equal((await request(dispatch, 'route-b')).provider, 'route-c')
})

test('gives up when every other route is cooling down', async () => {
  const { dispatch } = setup()
  await fail(dispatch, 'route-a')
  await fail(dispatch, 'route-b')
  // route-c is the only healthy route; its failure has no alternative left.
  const result = await fail(dispatch, 'route-c')
  assert.equal(result, TERMINAL)
})

test('applies a per-route model override while keeping other fields', async () => {
  const { dispatch } = setup({
    pools: [
      {
        model: 'deepseek-flash',
        routes: [{ provider: 'route-a' }, { provider: 'route-b', model: 'deepseek-flash-2' }],
      },
    ],
  })
  await fail(dispatch, 'route-a')
  const result = await request(dispatch, 'route-a')
  assert.equal(result.provider, 'route-b')
  assert.equal(result.model, 'deepseek-flash-2')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.maxTokens, 4096)
})

test('ignores non-quota failures', async () => {
  const { dispatch } = setup()
  const result = await fail(dispatch, 'route-a', { code: 'INVALID_REQUEST', message: 'bad tool schema' })
  assert.equal(result, TERMINAL)
  // No cooldown was recorded, so the route stays selected.
  assert.equal((await request(dispatch, 'route-a')).provider, 'route-a')
})

test('recognizes Chinese quota wording', async () => {
  const { dispatch } = setup()
  const result = await fail(dispatch, 'route-a', { code: 'PI_AI_ERROR', message: '账号余额不足' })
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal((await request(dispatch, 'route-a')).provider, 'route-b')
})

test('lets a cooling route recover after the cooldown expires', async () => {
  const { dispatch } = setup({ cooldownMs: 20 })
  await fail(dispatch, 'route-a')
  assert.equal((await request(dispatch, 'route-a')).provider, 'route-b')
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal((await request(dispatch, 'route-a')).provider, 'route-a')
})

test('respects maxSwitchesPerTurn', async () => {
  const { dispatch } = setup({ maxSwitchesPerTurn: 1 })
  const agent = { id: 'budget-agent' }
  assert.deepEqual(await fail(dispatch, 'route-a', QUOTA, 1, agent), { kind: 'retry' })
  // Budget is exhausted: the next failure is passed downstream and route-b is
  // not cooled, so a request still lands on it.
  assert.equal(await fail(dispatch, 'route-b', QUOTA, 1, agent), TERMINAL)
  assert.equal((await request(dispatch, 'route-b')).provider, 'route-b')
})

test('leaves providers outside the pool untouched', async () => {
  const { dispatch } = setup()
  assert.equal(await fail(dispatch, 'somewhere-else'), TERMINAL)
  assert.equal((await request(dispatch, 'somewhere-else')).provider, 'somewhere-else')
})

test('rewrite wins over a later-registered model-selection listener', async () => {
  const { ctx, dispatch } = setup()
  await fail(dispatch, 'route-a')
  // Emulates the host's installModelSelection listener: it runs after next()
  // and re-applies the session's selected route.
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    return { ...config, provider: 'route-a', model: 'deepseek-flash' }
  })
  const result = await dispatch('agent/request', requestPayload(), async () => resolved('route-a'))
  assert.equal(result.provider, 'route-b')
})

test('disposed plugin no longer rewrites requests', async () => {
  const { dispatch, disposeAll } = setup()
  await fail(dispatch, 'route-a')
  disposeAll()
  assert.equal((await request(dispatch, 'route-a')).provider, 'route-a')
})

test('fails over across vendors and model families from one hand-picked pool', async () => {
  const { ctx, dispatch } = createFakeCtx()
  apply(ctx, {
    pools: [
      {
        name: 'manual-pool',
        routes: [
          { provider: 'vendor-a', model: 'model-1' },
          { provider: 'vendor-b', model: 'model-2' },
          { provider: 'vendor-c', model: 'model-3' },
        ],
      },
    ],
    cooldownMs: 600000,
    maxSwitchesPerTurn: 5,
  })
  const ask = (provider, model) =>
    dispatch('agent/request', requestPayload(), async () => ({ provider, model, reasoningEffort: 'high', maxTokens: 2048 }))
  const bad = (provider) =>
    dispatch('agent/request-error', requestErrorPayload({ provider, failure: QUOTA }), async () => TERMINAL)

  assert.deepEqual(await bad('vendor-a'), { kind: 'retry' })
  const second = await ask('vendor-a', 'model-1')
  assert.deepEqual(second, { provider: 'vendor-b', model: 'model-2', reasoningEffort: 'high', maxTokens: 2048 })

  assert.deepEqual(await bad('vendor-b'), { kind: 'retry' })
  const third = await ask('vendor-b', 'model-2')
  assert.equal(third.provider, 'vendor-c')
  assert.equal(third.model, 'model-3')

  // Every other pool route is cooling: the third failure is left to fail.
  assert.equal(await bad('vendor-c'), TERMINAL)
})

test('only rewrites a route whose provider AND model are in the pool', async () => {
  const { ctx, dispatch } = createFakeCtx()
  apply(ctx, {
    pools: [{ routes: [{ provider: 'vendor-a', model: 'model-1' }, { provider: 'vendor-b', model: 'model-2' }] }],
    cooldownMs: 600000,
  })
  const ask = (provider, model) =>
    dispatch('agent/request', requestPayload(), async () => ({ provider, model }))
  const bad = (provider) =>
    dispatch('agent/request-error', requestErrorPayload({ provider, failure: QUOTA }), async () => TERMINAL)

  await bad('vendor-a')
  // vendor-a/model-2 is not in the pool even though vendor-a is: no rewrite.
  assert.deepEqual(await ask('vendor-a', 'model-2'), { provider: 'vendor-a', model: 'model-2' })
  // vendor-a/model-1 is in the pool and cooling: rewrite to vendor-b/model-2.
  assert.deepEqual(await ask('vendor-a', 'model-1'), { provider: 'vendor-b', model: 'model-2' })
})

test('panel-written codes make AUTH a failover trigger, and only when present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-keypool-auth-'))
  const previous = process.env.DSH_KEYPOOL_CONFIG
  const file = join(dir, 'route-pool.json')
  process.env.DSH_KEYPOOL_CONFIG = file
  const AUTH = { code: 'AUTH', message: '401: invalid token' }
  const withCodes = (codes) => writeFileSync(file, JSON.stringify({ ...POOL_CONFIG, codes }), 'utf8')
  try {
    const { ctx, dispatch } = createFakeCtx()
    // The row carries nothing: pool + codes come from the GUI file.
    apply(ctx, { pools: [] })
    withCodes(['AUTH'])
    assert.deepEqual(await fail(dispatch, 'route-a', AUTH), { kind: 'retry' })

    // Without AUTH in the codes the same failure is left to the kernel.
    const second = createFakeCtx()
    apply(second.ctx, { pools: [] })
    withCodes(['QUOTA', 'ACCOUNT_QUOTA'])
    assert.equal(await fail(second.dispatch, 'route-a', AUTH), TERMINAL)

    // Row codes apply when the file does not override them.
    const third = createFakeCtx()
    apply(third.ctx, { ...POOL_CONFIG, codes: ['AUTH'] })
    writeFileSync(file, JSON.stringify(POOL_CONFIG), 'utf8')
    assert.deepEqual(await fail(third.dispatch, 'route-a', AUTH), { kind: 'retry' })
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
})

test('warns and stays inactive on an empty pool config', async () => {
  const { ctx, dispatch, logs } = createFakeCtx()
  apply(ctx, { pools: [] })
  assert.ok(logs.some((entry) => entry.level === 'warn' && String(entry.args[0]).includes('llm-route-pool')))
  assert.equal((await request(dispatch, 'route-a')).provider, 'route-a')
})

test('RATE_LIMIT is a default trigger with a short transient cooldown', async () => {
  const { ctx, dispatch } = createFakeCtx()
  apply(ctx, { pools: POOL_CONFIG.pools, cooldownMs: 600000 })
  const rateLimited = { code: 'RATE_LIMIT', message: '429: Rate limit exceeded for api_key' }
  assert.deepEqual(await fail(dispatch, 'route-a', rateLimited), { kind: 'retry' })
  // The provider is cooled briefly (not the full 10 minutes) and the next
  // request is routed to the next pool route.
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'route-a')
  assert.ok(cooling, 'route-a should be cooling')
  assert.ok(cooling.remainingMs <= 61_000, `expected <= 61s, got ${cooling.remainingMs}`)
  const next = await request(dispatch, 'route-a')
  assert.equal(next.provider, 'route-b')
})

test('a quota failure cools the provider until the quota window resets', async () => {
  const { dispatch } = setup({
    quota: { exhausted: () => false, cooldownMs: () => 5 * 60 * 60_000 },
  })
  assert.deepEqual(await fail(dispatch, 'route-a'), { kind: 'retry' })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'route-a')
  assert.ok(cooling, 'route-a should be cooling')
  assert.ok(cooling.remainingMs > 4 * 60 * 60_000, `expected ~5h of cooldown, got ${cooling.remainingMs}`)
})

test('a quota hook never shortens the cooldown of a quota failure', async () => {
  const { dispatch } = setup({
    cooldownMs: 600000,
    quota: { exhausted: () => false, cooldownMs: () => 60_000 },
  })
  assert.deepEqual(await fail(dispatch, 'route-a'), { kind: 'retry' })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'route-a')
  assert.ok(cooling, 'route-a should be cooling')
  assert.ok(cooling.remainingMs > 9 * 60_000, `expected the full 10min cooldown, got ${cooling.remainingMs}`)
})

test('RATE_LIMIT keeps its short transient cooldown even with a quota hook', async () => {
  const { dispatch } = setup({
    quota: { exhausted: () => false, cooldownMs: () => 5 * 60 * 60_000 },
  })
  assert.deepEqual(await fail(dispatch, 'route-a', { code: 'RATE_LIMIT', message: 'rate limited' }), { kind: 'retry' })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'route-a')
  assert.ok(cooling, 'route-a should be cooling')
  assert.ok(cooling.remainingMs <= 61_000, `expected <= 61s, got ${cooling.remainingMs}`)
})

// ---- preferFirst: the pool order is the preference order -------------------

test('without preferFirst the healthy current route stays selected', async () => {
  const { dispatch } = setup()
  assert.equal((await request(dispatch, 'route-b')).provider, 'route-b')
})

test('preferFirst routes to the first healthy pool route even when the current one is healthy', async () => {
  const { dispatch } = setup({ preferFirst: true })
  const result = await request(dispatch, 'route-b')
  assert.equal(result.provider, 'route-a')
  assert.equal(result.model, 'deepseek-flash')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.maxTokens, 4096)
})

test('preferFirst skips a first route whose quota is exhausted', async () => {
  const { dispatch } = setup({
    preferFirst: true,
    quota: { exhausted: (provider) => provider === 'route-a', cooldownMs: () => 60_000 },
  })
  assert.equal((await request(dispatch, 'route-c')).provider, 'route-b')
})

test('preferFirst falls through to the next healthy route when the first one is cooling', async () => {
  const { dispatch } = setup({ preferFirst: true })
  await fail(dispatch, 'route-a')
  assert.equal((await request(dispatch, 'route-c')).provider, 'route-b')
})

test('preferFirst never moves a request onto another model', async () => {
  const { ctx, dispatch } = createFakeCtx()
  apply(ctx, {
    pools: [{
      routes: [
        { provider: 'route-a', model: 'deepseek-flash' },
        { provider: 'route-b', model: 'other-model' },
      ],
    }],
    preferFirst: true,
  })
  const ask = (provider, model) =>
    dispatch('agent/request', requestPayload(), async () => ({ provider, model }))
  // route-b serves another model: the pool order must not pull the request to it.
  assert.deepEqual(await ask('route-b', 'other-model'), { provider: 'route-b', model: 'other-model' })
})

test('preferFirst can come from the GUI-managed config file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-keypool-prefer-'))
  const previous = process.env.DSH_KEYPOOL_CONFIG
  process.env.DSH_KEYPOOL_CONFIG = join(dir, 'route-pool.json')
  try {
    writeFileSync(process.env.DSH_KEYPOOL_CONFIG, JSON.stringify({
      pools: [{
        name: 'gui',
        routes: [
          { provider: 'route-a', model: 'deepseek-flash' },
          { provider: 'route-b', model: 'deepseek-flash' },
        ],
      }],
      cooldownMs: 600000,
      maxSwitchesPerTurn: 3,
      preferFirst: true,
    }), 'utf8')
    const { ctx, dispatch } = createFakeCtx()
    // The row itself carries no pools and no flag: only the GUI file has them.
    apply(ctx, { pools: [] })
    const ask = (provider) =>
      dispatch('agent/request', requestPayload(), async () => resolved(provider))
    assert.equal((await ask('route-b')).provider, 'route-a')
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
})
