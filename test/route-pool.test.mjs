import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/route-pool.js'
import { statusSnapshot } from '../lib/runtime.js'
import {
  createFakeAgent,
  createFakeCtx,
  inboxInsertedPayload,
  preStepPayload,
  requestErrorPayload,
  requestPayload,
} from './helpers/fake-ctx.mjs'

/** Keep every test on a private (absent) GUI config file unless it opts in. */
const privateDir = mkdtempSync(join(tmpdir(), 'dsh-keypool-route-pool-'))
process.env.DSH_KEYPOOL_CONFIG = join(privateDir, 'absent.json')

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

/** The route a request resolved to, as the host hands it to `agent/request`. */
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

/** Report a failed request to the pool, as the host does. */
async function fail(dispatch, overrides = {}) {
  const payload = requestErrorPayload({ provider: 'route-a', ...overrides })
  return dispatch('agent/request-error', payload, async () => TERMINAL)
}

/** An agent that currently sits on `provider`. */
const agentOn = (provider, extra = {}) =>
  createFakeAgent({ provider, model: 'deepseek-flash', ...extra })

test('the plugin never rewrites a request configuration', async () => {
  const { dispatch } = setup()
  await fail(dispatch, { provider: 'route-a' })
  // Since DSH 0.2.2 the host rejects a configuration whose provider/model
  // differ from the route the step fixed, so the pool must not touch it.
  const config = await dispatch('agent/request', requestPayload(), async () => resolved('route-a'))
  assert.deepEqual(config, resolved('route-a'))
})

test('a spent quota moves the turn to the next healthy route before it starts', async () => {
  const { dispatch } = setup({ quota: { exhausted: (provider) => provider === 'route-a' } })
  const agent = agentOn('route-a')
  // The message lands in the inbox while the driver is still asleep, so the
  // pool can still decide the route of the coming turn's first step.
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
  assert.deepEqual(agent.model.current(), { provider: 'route-b', model: 'deepseek-flash' })
})

test('a step that runs on a spent quota hands the next step to the next route', async () => {
  const { dispatch } = setup({ quota: { exhausted: (provider) => provider === 'route-a' } })
  const agent = agentOn('route-a')
  // The step fixed its route already: the host reports it in the payload and
  // rejects a configuration that differs from it. So the pool may only speak
  // for the *next* step.
  const decision = await dispatch(
    'agent/pre-step',
    preStepPayload(agent, { provider: 'route-a', model: 'deepseek-flash' }),
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
})

test('a failed request cools the provider and hands the next step a healthy route', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-a')
  // The step fixed route-a and the request failed with a spent quota.
  await dispatch(
    'agent/pre-step',
    preStepPayload(agent, { provider: 'route-a', model: 'deepseek-flash' }),
    async () => ({ kind: 'enter', messages: [] }),
  )
  const action = await fail(dispatch, { provider: 'route-a', agent })
  // The route of a step is fixed, so a retry would hit the same dead route
  // again. The pool lets the failure travel downstream and speaks for the
  // next step instead.
  assert.equal(action, TERMINAL)
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
})

test('the status shows the cooling provider, the switch and the failure', async () => {
  const { dispatch } = setup({
    pools: [{
      model: 'deepseek-flash',
      routes: [{ provider: 'status-a' }, { provider: 'status-b' }],
    }],
  })
  const agent = agentOn('status-a')
  await dispatch(
    'agent/pre-step',
    preStepPayload(agent, { provider: 'status-a', model: 'deepseek-flash' }),
    async () => ({ kind: 'enter', messages: [] }),
  )
  await fail(dispatch, { provider: 'status-a', agent })

  const status = statusSnapshot()
  const cooling = status.cooling.find((entry) => entry.provider === 'status-a')
  assert.ok(cooling, 'status-a should be cooling')
  assert.equal(status.lastFailure.provider, 'status-a')
  assert.ok(
    status.switches.some((entry) => entry.from === 'status-a/deepseek-flash' && entry.to === 'status-b/deepseek-flash'),
    'the switch should be reported',
  )
  assert.equal(status.active.provider, 'status-b')
})

test('leaves providers outside the pool untouched', async () => {
  const { dispatch } = setup()
  const agent = agentOn('somewhere-else')
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [])
  const action = await fail(dispatch, { provider: 'somewhere-else', agent })
  assert.equal(action, TERMINAL)
  assert.deepEqual(agent.selections, [])
})

test('ignores failures that are not a spent quota', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-a')
  const action = await fail(dispatch, {
    provider: 'route-a',
    agent,
    failure: { code: 'INVALID_REQUEST', message: 'bad tool schema' },
  })
  assert.equal(action, TERMINAL)
  assert.deepEqual(agent.selections, [])
})

test('recognizes Chinese quota wording', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-a')
  await fail(dispatch, {
    provider: 'route-a',
    agent,
    failure: { code: 'PI_AI_ERROR', message: '账号余额不足' },
  })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
})

test('walks past a second cooling route to the third one', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-a')
  await fail(dispatch, { provider: 'route-a', agent })
  await fail(dispatch, { provider: 'route-b', agent })
  assert.deepEqual(agent.selections, [
    { provider: 'route-b', model: 'deepseek-flash' },
    { provider: 'route-c', model: 'deepseek-flash' },
  ])
})

test('gives up when every other route is cooling down', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-a')
  await fail(dispatch, { provider: 'route-a', agent })
  await fail(dispatch, { provider: 'route-b', agent })
  const action = await fail(dispatch, { provider: 'route-c', agent })
  assert.equal(action, TERMINAL)
  assert.equal(agent.selections.length, 2)
})

test('applies the model of the route it moves to', async () => {
  const { dispatch } = setup({
    pools: [
      {
        model: 'deepseek-flash',
        routes: [{ provider: 'route-a' }, { provider: 'route-b', model: 'deepseek-flash-2' }],
      },
    ],
  })
  const agent = agentOn('route-a')
  await fail(dispatch, { provider: 'route-a', agent })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash-2' }])
})

test('leaves a route whose model is not in the pool untouched', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-a', { model: 'other-model' })
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [])
})

test('respects maxSwitchesPerTurn', async () => {
  const { dispatch } = setup({ maxSwitchesPerTurn: 1 })
  const agent = agentOn('route-a')
  await fail(dispatch, { provider: 'route-a', agent, turn: 1 })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
  // The budget of this turn is spent: the next failure is passed downstream.
  await fail(dispatch, { provider: 'route-b', agent, turn: 1 })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
})

test('a disposed plugin no longer selects a route', async () => {
  const { dispatch, disposeAll } = setup()
  const agent = agentOn('route-a')
  disposeAll()
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  await fail(dispatch, { provider: 'route-a', agent })
  assert.deepEqual(agent.selections, [])
})

test('warns and stays inactive on an empty pool config', async () => {
  const { ctx, dispatch, logs } = createFakeCtx()
  apply(ctx, { pools: [] })
  assert.ok(logs.some((entry) => entry.level === 'warn' && String(entry.args[0]).includes('llm-route-pool')))
  const agent = agentOn('route-a')
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [])
})

test('RATE_LIMIT cools the provider briefly instead of for the whole quota cooldown', async () => {
  const { dispatch } = setup({
    cooldownMs: 600000,
    pools: [{ model: 'deepseek-flash', routes: [{ provider: 'rate-a' }, { provider: 'rate-b' }] }],
  })
  const agent = agentOn('rate-a')
  await fail(dispatch, {
    provider: 'rate-a',
    agent,
    failure: { code: 'RATE_LIMIT', message: '429: Rate limit exceeded for api_key' },
  })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'rate-a')
  assert.ok(cooling, 'rate-a should be cooling')
  assert.ok(cooling.remainingMs <= 61_000, `expected <= 61s, got ${cooling.remainingMs}`)
})

test('a quota failure cools the provider until the quota window resets', async () => {
  const { dispatch } = setup({
    pools: [{ model: 'deepseek-flash', routes: [{ provider: 'window-a' }, { provider: 'window-b' }] }],
    quota: { exhausted: () => false, cooldownMs: () => 5 * 60 * 60_000 },
  })
  const agent = agentOn('window-a')
  await fail(dispatch, { provider: 'window-a', agent })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'window-a')
  assert.ok(cooling, 'window-a should be cooling')
  assert.ok(cooling.remainingMs > 4 * 60 * 60_000, `expected ~5h of cooldown, got ${cooling.remainingMs}`)
})

test('a quota hook never shortens the cooldown of a quota failure', async () => {
  const { dispatch } = setup({
    cooldownMs: 600000,
    pools: [{ model: 'deepseek-flash', routes: [{ provider: 'short-a' }, { provider: 'short-b' }] }],
    quota: { exhausted: () => false, cooldownMs: () => 60_000 },
  })
  const agent = agentOn('short-a')
  await fail(dispatch, { provider: 'short-a', agent })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'short-a')
  assert.ok(cooling, 'short-a should be cooling')
  assert.ok(cooling.remainingMs > 9 * 60_000, `expected the full 10min cooldown, got ${cooling.remainingMs}`)
})

// ---- preferFirst: the pool order is the preference order -------------------

test('without preferFirst the healthy current route stays selected', async () => {
  const { dispatch } = setup()
  const agent = agentOn('route-b')
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [])
})

test('preferFirst routes to the first healthy pool route even when the current one is healthy', async () => {
  const { dispatch } = setup({ preferFirst: true })
  const agent = agentOn('route-b')
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [{ provider: 'route-a', model: 'deepseek-flash' }])
})

test('preferFirst skips a first route whose quota is exhausted', async () => {
  const { dispatch } = setup({
    preferFirst: true,
    quota: { exhausted: (provider) => provider === 'route-a', cooldownMs: () => 60_000 },
  })
  const agent = agentOn('route-c')
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
})

test('preferFirst falls through to the next healthy route when the first one is cooling', async () => {
  const { dispatch } = setup({ preferFirst: true })
  const agent = agentOn('route-a')
  await fail(dispatch, { provider: 'route-a', agent })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
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
  const agent = createFakeAgent({ provider: 'route-b', model: 'other-model' })
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections, [])
})

test('a cooling route comes back into rotation after the cooldown expires', async () => {
  const { dispatch } = setup({ cooldownMs: 20, preferFirst: true })
  const agent = agentOn('route-a')
  await fail(dispatch, { provider: 'route-a', agent })
  assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
  await new Promise((resolve) => setTimeout(resolve, 35))
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
  assert.deepEqual(agent.selections[1], { provider: 'route-a', model: 'deepseek-flash' })
})

test('RATE_LIMIT keeps its short transient cooldown even with a quota hook', async () => {
  const { dispatch } = setup({
    pools: [{ model: 'deepseek-flash', routes: [{ provider: 'hook-a' }, { provider: 'hook-b' }] }],
    quota: { exhausted: () => false, cooldownMs: () => 5 * 60 * 60_000 },
  })
  const agent = agentOn('hook-a')
  await fail(dispatch, {
    provider: 'hook-a',
    agent,
    failure: { code: 'RATE_LIMIT', message: 'rate limited' },
  })
  const cooling = statusSnapshot().cooling.find((entry) => entry.provider === 'hook-a')
  assert.ok(cooling, 'hook-a should be cooling')
  assert.ok(cooling.remainingMs <= 61_000, `expected <= 61s, got ${cooling.remainingMs}`)
})

test('only switches a route whose provider AND model are in the pool', async () => {
  const { ctx, dispatch } = createFakeCtx()
  apply(ctx, {
    pools: [{ routes: [{ provider: 'vendor-a', model: 'model-1' }, { provider: 'vendor-b', model: 'model-2' }] }],
    cooldownMs: 600000,
  })
  const agent = agentOn('vendor-a', { model: 'model-1' })
  await fail(dispatch, { provider: 'vendor-a', agent })
  assert.deepEqual(agent.selections, [{ provider: 'vendor-b', model: 'model-2' }])

  // vendor-a/model-2 is not in the pool even though vendor-a is: the pool
  // leaves that route alone.
  const other = agentOn('vendor-a', { model: 'model-2' })
  await dispatch('agent/inbox/inserted', inboxInsertedPayload(other))
  assert.deepEqual(other.selections, [])
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
  const agent = agentOn('vendor-a', { model: 'model-1' })

  await fail(dispatch, { provider: 'vendor-a', agent })
  assert.deepEqual(agent.selections, [{ provider: 'vendor-b', model: 'model-2' }])

  await fail(dispatch, { provider: 'vendor-b', agent })
  assert.deepEqual(agent.selections[1], { provider: 'vendor-c', model: 'model-3' })

  // Every other pool route is cooling: the third failure is left to fail.
  const action = await fail(dispatch, { provider: 'vendor-c', agent })
  assert.equal(action, TERMINAL)
})

// ---- the GUI-managed config file -------------------------------------------

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
    const agent = agentOn('vendor-a', { model: 'model-1' })
    await fail(dispatch, { provider: 'vendor-a', agent })
    assert.deepEqual(agent.selections, [{ provider: 'vendor-b', model: 'model-2' }])
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
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
    const agent = agentOn('route-b')
    await dispatch('agent/inbox/inserted', inboxInsertedPayload(agent))
    assert.deepEqual(agent.selections, [{ provider: 'route-a', model: 'deepseek-flash' }])
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
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
    const agent = agentOn('route-a')
    await fail(dispatch, { provider: 'route-a', agent, failure: AUTH })
    assert.deepEqual(agent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])

    // Without AUTH in the codes the same failure is left to the kernel.
    const second = createFakeCtx()
    apply(second.ctx, { pools: [] })
    withCodes(['QUOTA', 'ACCOUNT_QUOTA'])
    const secondAgent = agentOn('route-a')
    const action = await fail(second.dispatch, { provider: 'route-a', agent: secondAgent, failure: AUTH })
    assert.equal(action, TERMINAL)
    assert.deepEqual(secondAgent.selections, [])

    // Row codes apply when the file does not override them.
    const third = createFakeCtx()
    apply(third.ctx, { ...POOL_CONFIG, codes: ['AUTH'] })
    writeFileSync(file, JSON.stringify(POOL_CONFIG), 'utf8')
    const thirdAgent = agentOn('route-a')
    await fail(third.dispatch, { provider: 'route-a', agent: thirdAgent, failure: AUTH })
    assert.deepEqual(thirdAgent.selections, [{ provider: 'route-b', model: 'deepseek-flash' }])
  } finally {
    process.env.DSH_KEYPOOL_CONFIG = previous
  }
})
