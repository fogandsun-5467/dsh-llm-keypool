import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createQuotaService,
  detectAdapterKind,
  hostOf,
  parseDeepseekBalance,
  parseMinimaxRemains,
  providersFromDocument,
  resolveProviderSource,
  scanPiAiProviders,
} from '../lib/quota.js'
import { normalizeStoredConfig } from '../lib/runtime.js'
import { createFakeCtx, createFakeCredentials } from './helpers/fake-ctx.mjs'

/** A MiniMax coding-plan response with one model entry. */
const minimaxBody = {
  model_remains: [
    {
      start_time: 1,
      end_time: 2,
      remains_time: 14_200_000,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: 'general',
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 3,
      weekly_end_time: 4,
      weekly_remains_time: 115_000_000,
      current_interval_status: 1,
      current_interval_remaining_percent: 59,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 76,
      weekly_boost_permille: 0,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
}

test('parses the MiniMax coding-plan response', () => {
  const parsed = parseMinimaxRemains(minimaxBody)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.error, null)
  assert.equal(parsed.models.length, 1)
  const model = parsed.models[0]
  assert.equal(model.name, 'general')
  assert.equal(model.interval.percent, 59)
  assert.equal(model.interval.remainsMs, 14_200_000)
  assert.equal(model.weekly.percent, 76)
  assert.equal(model.weekly.remainsMs, 115_000_000)
})

test('reports a MiniMax business error instead of throwing', () => {
  const parsed = parseMinimaxRemains({ base_resp: { status_code: 1004, status_msg: 'cookie is missing' } })
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /1004/)
  assert.deepEqual(parsed.models, [])
})

test('parses a DeepSeek balance response', () => {
  const parsed = parseDeepseekBalance({
    balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.models[0].name, 'CNY')
  assert.equal(parsed.models[0].balance.total, 12.34)
})

test('detects the adapter kind from the host and the provider id', () => {
  assert.equal(hostOf('https://api.minimaxi.com/anthropic'), 'api.minimaxi.com')
  assert.equal(detectAdapterKind('https://api.minimaxi.com/anthropic'), 'minimax')
  assert.equal(detectAdapterKind('https://api.deepseek.com'), 'deepseek')
  assert.equal(detectAdapterKind(undefined, 'minimax-max'), 'minimax')
  assert.equal(detectAdapterKind(undefined, 'someone-else'), undefined)
})

test('the GUI layer wins over the row, the profile and the built-in table', () => {
  const source = resolveProviderSource('minimax-cn', [
    { 'minimax-cn': { apiKeyEnv: 'GUI_KEY' } },
    { 'minimax-cn': { apiKeyEnv: 'ROW_KEY' } },
    { 'minimax-cn': { apiKeyEnv: 'PROFILE_KEY', baseUrl: 'https://profile.example' } },
    { 'minimax-cn': { apiKeyEnv: 'BUILTIN_KEY', baseUrl: 'https://builtin.example' } },
  ])
  assert.equal(source.ref, 'GUI_KEY')
  assert.equal(source.baseUrl, 'https://profile.example')
})

test('reads provider profiles out of a parsed patch document', () => {
  const providers = providersFromDocument([
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: {
        providers: {
          'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' },
          'minimax-max': { apiKeyEnv: 'MINIMAX_MAX_API_KEY', baseURL: 'https://api.minimax.cn/anthropic' },
        },
      },
    },
  ])
  assert.equal(providers['minimax-cn'].ref, 'MINIMAX_CN_API_KEY')
  assert.equal(providers['minimax-max'].baseUrl, 'https://api.minimax.cn/anthropic')
})

test('the fallback scanner finds the provider profiles without the yaml package', () => {
  const text = [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      minimax-cn:',
    '        models:',
    '          - id: MiniMax-M3.1-Flash',
    '        apiKeyEnv: MINIMAX_CN_API_KEY',
    '      minimax-max:',
    '        apiKeyEnv: MINIMAX_MAX_API_KEY',
    '        baseURL: https://api.minimax.cn/anthropic',
    '',
  ].join('\n')
  const providers = scanPiAiProviders(text)
  assert.equal(providers['minimax-cn'].ref, 'MINIMAX_CN_API_KEY')
  assert.equal(providers['minimax-max'].baseUrl, 'https://api.minimax.cn/anthropic')
})

test('reads a provider quota over the credential service', async () => {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init?.headers?.authorization })
    return new Response(JSON.stringify(minimaxBody), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
      cacheMs: 60_000,
    })
    const entry = await service.read('vendor-a')
    assert.equal(entry.ok, true)
    assert.equal(entry.provider, 'vendor-a')
    assert.equal(entry.primary.interval.percent, 59)
    assert.equal(entry.primary.weekly.percent, 76)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
    // The credential value never leaves the module.
    assert.equal(entry.ref, 'MY_KEY')
    assert.equal(JSON.stringify(entry).includes('sk-test-value'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a failed quota read is reported as data, not as an exception', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
    })
    const entry = await service.read('vendor-a')
    assert.equal(entry.ok, false)
    assert.match(entry.error, /500/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an unknown provider is reported as unsupported instead of guessed', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }) }
  try {
    const { ctx } = createFakeCtx()
    const service = createQuotaService(ctx, {})
    const entry = await service.read('mystery-vendor')
    assert.equal(entry.ok, false)
    assert.match(entry.error, /额度接口/)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a provider with no quota left is reported as exhausted', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: 0,
      current_weekly_remaining_percent: 42,
      remains_time: 1000,
      weekly_remains_time: 2000,
    }],
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200 })
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
    })
    await service.read('vendor-a')
    assert.equal(service.exhausted('vendor-a'), true)
    assert.equal(service.exhausted('vendor-b'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the quota cache keeps the vendor call count low', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify(minimaxBody), { status: 200 }) }
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
      cacheMs: 60_000,
    })
    await service.read('vendor-a')
    await service.read('vendor-a')
    assert.equal(calls, 1)
    await service.read('vendor-a', { force: true })
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the stored config keeps a quota section', () => {
  const config = normalizeStoredConfig({
    pools: [{ name: 'p', routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }] }],
    quota: {
      enabled: false,
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
    },
  })
  assert.equal(config.quota.enabled, false)
  assert.equal(config.quota.providers['vendor-a'].apiKeyEnv, 'MY_KEY')
  assert.equal(config.quota.providers['vendor-a'].baseUrl, 'https://api.minimaxi.com')
})

test('a stored config without a quota section still normalizes', () => {
  const config = normalizeStoredConfig({
    pools: [{ name: 'p', routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }] }],
  })
  assert.equal(config.quota.enabled, true)
  assert.deepEqual(config.quota.providers, {})
})

test('a spent plan reports the vendor reset time and uses it as its cooldown', async () => {
  const originalFetch = globalThis.fetch
  const endTime = Date.now() + 60 * 60_000
  globalThis.fetch = async () => new Response(JSON.stringify({
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: 0,
      current_weekly_remaining_percent: 42,
      remains_time: 60 * 60_000,
      end_time: endTime,
      weekly_end_time: endTime + 24 * 60 * 60_000,
    }],
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200 })
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
    })
    await service.read('vendor-a')
    const state = service.state('vendor-a')
    assert.equal(state.exhausted, true)
    assert.equal(state.resetAt, endTime)
    const cooldown = service.cooldownMs('vendor-a')
    assert.ok(cooldown !== undefined && cooldown > 55 * 60_000, `expected ~1h cooldown, got ${cooldown}`)
    assert.ok(cooldown <= 60 * 60_000, `expected <= 1h, got ${cooldown}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a healthy plan has no quota cooldown', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(minimaxBody), { status: 200 })
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
    })
    await service.read('vendor-a')
    assert.equal(service.state('vendor-a').exhausted, false)
    assert.equal(service.cooldownMs('vendor-a'), undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a spent weekly window parks the provider until the weekly reset', async () => {
  const originalFetch = globalThis.fetch
  const weeklyEnd = Date.now() + 5 * 24 * 60 * 60_000
  globalThis.fetch = async () => new Response(JSON.stringify({
    model_remains: [{
      model_name: 'general',
      // The 5-hour window still has room, but the weekly one is spent.
      current_interval_remaining_percent: 100,
      current_weekly_remaining_percent: 0,
      remains_time: 60 * 60_000,
      end_time: Date.now() + 60 * 60_000,
      weekly_end_time: weeklyEnd,
    }],
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200 })
  try {
    const credentials = createFakeCredentials({ MY_KEY: 'sk-test-value' })
    const { ctx } = createFakeCtx({ services: { credentials } })
    const service = createQuotaService(ctx, {
      providers: { 'vendor-a': { apiKeyEnv: 'MY_KEY', baseUrl: 'https://api.minimaxi.com' } },
    })
    await service.read('vendor-a')
    const state = service.state('vendor-a')
    assert.equal(state.exhausted, true, 'a spent weekly window counts as exhausted')
    assert.equal(state.weeklyExhausted, true)
    assert.equal(state.intervalExhausted, false)
    assert.equal(state.resetAt, weeklyEnd, 'the weekly reset decides when the provider comes back')
    const cooldown = service.cooldownMs('vendor-a')
    assert.ok(cooldown > 4.9 * 24 * 60 * 60_000, `expected ~5 days, got ${cooldown}`)
    assert.ok(cooldown <= 8 * 24 * 60 * 60_000, `expected the weekly window to fit in the cap, got ${cooldown}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})
