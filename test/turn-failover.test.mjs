/**
 * The turn level failure this suite reproduces.
 *
 * A pool holds several routes. When the route a step runs on reports a spent
 * quota, the run must fail over to the next healthy route *inside the same
 * turn* — the pool exists to keep a run alive, not to make the next run
 * healthier.
 *
 * The unit tests in `route-pool.test.mjs` drive the waterfalls one by one and
 * therefore cannot see the consequence: a failed request makes the host end
 * the whole turn (`dsh-agent-loop/lib/index.js:938`, `:809-816`). These tests
 * drive the host loop instead (see `helpers/host-loop.mjs`), so they assert the
 * symptom the user reported — **the run dies even though the pool has a
 * healthy route**.
 *
 * A failure that only looks broken (a timeout, a dropped connection) is not a
 * verdict on its own: the pool asks the vendor for the truth first, because a
 * spent plan often hides behind a plain timeout while a plain timeout is
 * often just a hiccup.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/route-pool.js'
import { createFakeCtx } from './helpers/fake-ctx.mjs'
import { createHostAgent, runHostTurn } from './helpers/host-loop.mjs'

/** Keep every test on a private (absent) GUI config file. */
const privateDir = mkdtempSync(join(tmpdir(), 'dsh-keypool-turn-failover-'))
process.env.DSH_KEYPOOL_CONFIG = join(privateDir, 'absent.json')

const POOL_CONFIG = {
  pools: [
    {
      model: 'deepseek-flash',
      routes: [{ provider: 'route-a' }, { provider: 'route-b' }],
    },
  ],
}

/** The quota shape a vendor reports when the plan is spent. */
const SPENT_QUOTA = {
  code: 'QUOTA',
  message: 'insufficient quota: current quota exhausted',
}

/** The shape a vendor reports when a spent plan surfaces as a hang. */
const SPENT_QUOTA_AS_TIMEOUT = {
  code: 'TIMEOUT',
  message: 'request to provider timed out after 60000ms',
}

function setup(overrides = {}) {
  const { ctx, dispatch, disposeAll, logs } = createFakeCtx()
  apply(ctx, { ...POOL_CONFIG, ...overrides })
  return { ctx, dispatch, disposeAll, logs }
}

/**
 * A provider stub: the first route fails with `failure`, every other route
 * answers. The recorded calls are the requests the host really made.
 */
function providerStub(failure) {
  const calls = []
  return {
    calls,
    async llm({ provider }) {
      calls.push(provider)
      if (provider === 'route-a') {
        throw Object.assign(new Error(failure.message), { code: failure.code })
      }
      return { provider }
    },
  }
}

/**
 * A quota reader that answers with one verdict and records what it was asked.
 * @param {{ ok?: boolean, exhausted?: boolean, cooldownMs?: number }} verdict
 */
function vendorStub(verdict) {
  const asked = []
  return {
    asked,
    inspect: async (provider) => {
      asked.push(provider)
      return { ok: verdict.ok ?? true, exhausted: verdict.exhausted, cooldownMs: verdict.cooldownMs }
    },
  }
}

/** Run one turn and report whether it survived. */
async function runTurn(harness, agent, llm) {
  return runHostTurn({ harness, agent, llm }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
}

test('a spent quota fails the turn over to the next healthy route instead of ending the run', async () => {
  const { ctx, dispatch } = setup()
  const agent = createHostAgent({ provider: 'route-a', model: 'deepseek-flash' })
  const { calls, llm } = providerStub(SPENT_QUOTA)

  const outcome = await runTurn({ ctx, dispatch }, agent, llm)

  assert.ok(
    outcome.ok,
    `the run must survive a spent quota because the pool holds a healthy route, `
    + `but it died with: ${outcome.error?.message}`,
  )
  assert.deepEqual(
    calls,
    ['route-a', 'route-b'],
    'the failed request must be retried on the next healthy route of the pool',
  )
})

test('a spent quota that surfaces as a timeout still fails the turn over', async () => {
  const vendor = vendorStub({ exhausted: true, cooldownMs: 600000 })
  const { ctx, dispatch } = setup({ quota: { inspect: vendor.inspect } })
  const agent = createHostAgent({ provider: 'route-a', model: 'deepseek-flash' })
  const { calls, llm } = providerStub(SPENT_QUOTA_AS_TIMEOUT)

  const outcome = await runTurn({ ctx, dispatch }, agent, llm)

  assert.ok(
    outcome.ok,
    `a spent plan that hangs must not take the whole run down, `
    + `but it died with: ${outcome.error?.message}`,
  )
  assert.deepEqual(
    calls,
    ['route-a', 'route-b'],
    'the timed out request must be retried on the next healthy route of the pool',
  )
  assert.deepEqual(vendor.asked, ['route-a'], 'the vendor must be asked who spent the plan')
})

test('a timeout the vendor does not confirm repeats the same route instead of burning one', async () => {
  const vendor = vendorStub({ exhausted: false })
  const { ctx, dispatch } = setup({
    quota: { inspect: vendor.inspect },
    // The wait between two attempts is not what this test is about.
    retryDelayMs: 1,
    retryMaxDelayMs: 1,
  })
  const agent = createHostAgent({ provider: 'route-a', model: 'deepseek-flash' })
  const { calls, llm } = providerStub(SPENT_QUOTA_AS_TIMEOUT)

  const outcome = await runTurn({ ctx, dispatch }, agent, llm)

  assert.equal(
    outcome.ok,
    false,
    'a route that still has quota may really be a hiccup: the pool gives up after its own budget',
  )
  assert.deepEqual(
    calls,
    ['route-a', 'route-a', 'route-a'],
    'the pool repeats the same route and never spends a healthy one on a hiccup',
  )
  assert.deepEqual(vendor.asked, ['route-a'], 'the vendor is asked once, the answer is remembered')
})

test('the spent route stays cold for the following turn', async () => {
  const { ctx, dispatch } = setup()
  const agent = createHostAgent({ provider: 'route-a', model: 'deepseek-flash' })
  const { calls, llm } = providerStub(SPENT_QUOTA)

  await runTurn({ ctx, dispatch }, agent, llm)
  await runTurn({ ctx, dispatch }, agent, llm)

  assert.equal(
    calls.filter((provider) => provider === 'route-a').length,
    1,
    'the spent route must be used once and then stay cold',
  )
})
