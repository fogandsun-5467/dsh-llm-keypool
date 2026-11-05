import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'dsh-keypool-api-'))
process.env.DSH_KEYPOOL_CONFIG = join(dir, 'route-pool.json')

const { apply } = await import('../index.js')
const runtime = await import('../lib/runtime.js')

/** Fake Cordis context: records webServer routes and exposes services. */
function createCtx(services) {
  const routes = new Map()
  const logs = []
  const webServer = {
    register: ({ path, handler }) => {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }
  return {
    routes,
    logs,
    webServer,
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    },
    // `ctx.get` must answer for the services this plugin reads through it.
    get: (name) => (name === 'webServer' ? webServer : services[name]),
    effect: (fn) => { const dispose = fn(); return dispose },
    on: () => () => {},
  }
}

/** Fake request/response pair; body is delivered through the data/end events. */
function exchange(method, body = '') {
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    listeners: {},
    on(event, listener) { (this.listeners[event] ??= []).push(listener); return this },
    destroy() {},
  }
  if (method === 'POST') {
    req.on('data', (chunk) => { req.body = (req.body ?? '') + chunk })
  }
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(payload) { this.body = payload ?? '' },
  }
  const invoke = async (handler) => {
    const pending = handler(req, res)
    if (method === 'POST') {
      for (const listener of req.listeners.data ?? []) listener(Buffer.from(body))
      for (const listener of req.listeners.end ?? []) listener()
    }
    await pending
    // Give the async IIFE inside the handler a chance to finish.
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { status: res.status, headers: res.headers, body: res.body === '' ? undefined : JSON.parse(res.body) }
  }
  return { req, res, invoke }
}

const providerService = {
  listProviders: () => [
    { id: 'ustc-back', displayName: 'ustc-back' },
    { id: 'vendor-b', displayName: '供应商 B' },
  ],
  listModels: async (provider) => (provider === 'ustc-back'
    ? [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-chat' }]
    : [{ id: 'model-2', name: 'Model 2' }]),
}

test('registers the loopback routes', () => {
  const ctx = createCtx({ webServer: undefined, llm: providerService })
  apply(ctx, {})
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/api/keypool/catalog',
    '/api/keypool/config',
    '/api/keypool/quota',
    '/api/keypool/status',
  ])
})

test('catalog lists every provider with its models', async () => {
  const ctx = createCtx({ llm: providerService })
  apply(ctx, {})
  const { invoke } = exchange('GET')
  const result = await invoke(ctx.routes.get('/api/keypool/catalog'))
  assert.equal(result.status, 200)
  assert.equal(result.body.providers.length, 2)
  assert.deepEqual(result.body.providers[0], {
    provider: 'ustc-back',
    displayName: 'ustc-back',
    models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-chat', name: 'deepseek-chat' }],
  })
})

test('config GET falls back to the row config, POST writes the pool file', async () => {
  const ctx = createCtx({ llm: providerService })
  apply(ctx, { pools: [], cooldownMs: 600000, maxSwitchesPerTurn: 3 })

  const read = exchange('GET')
  const before = await read.invoke(ctx.routes.get('/api/keypool/config'))
  assert.equal(before.status, 200)
  assert.equal(before.body.stored, null)
  assert.equal(before.body.file, process.env.DSH_KEYPOOL_CONFIG)

  const payload = {
    pools: [{ name: '我的轮换池', routes: [{ provider: 'ustc-back', model: 'deepseek-flash' }, { provider: 'vendor-b', model: 'model-2' }] }],
    cooldownMs: 120000,
    maxSwitchesPerTurn: 2,
    codes: ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH'],
  }
  const write = exchange('POST', JSON.stringify(payload))
  const saved = await write.invoke(ctx.routes.get('/api/keypool/config'))
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.saved.pools[0].routes.length, 2)
  assert.deepEqual(saved.body.saved.codes, ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH'])
  assert.equal(runtime.readStoredConfig().cooldownMs, 120000)

  const after = await exchange('GET').invoke(ctx.routes.get('/api/keypool/config'))
  assert.equal(after.body.stored.pools[0].routes[1].model, 'model-2')
})

test('config POST rejects invalid pools with 400', async () => {
  const ctx = createCtx({ llm: providerService })
  apply(ctx, {})
  const result = await exchange('POST', JSON.stringify({ pools: [] })).invoke(ctx.routes.get('/api/keypool/config'))
  assert.equal(result.status, 400)
  assert.match(result.body.error, /at least one pool/)
})

test('status reports what the behavior row published', async () => {
  const ctx = createCtx({ llm: providerService })
  apply(ctx, {})
  runtime.noteActiveRoute('vendor-b', 'model-2')
  runtime.noteCooling('ustc-back', Date.now() + 60000)
  runtime.noteSwitch('ustc-back/deepseek-flash', 'vendor-b/model-2', 'QUOTA')
  const result = await exchange('GET').invoke(ctx.routes.get('/api/keypool/status'))
  assert.equal(result.status, 200)
  assert.equal(result.body.active.provider, 'vendor-b')
  assert.equal(result.body.cooling[0].provider, 'ustc-back')
  assert.equal(result.body.switches[0].to, 'vendor-b/model-2')
})

test('non-loopback requests are refused', async () => {
  const ctx = createCtx({ llm: providerService })
  apply(ctx, {})
  const { req, invoke } = exchange('GET')
  req.socket.remoteAddress = '10.1.2.3'
  const result = await invoke(ctx.routes.get('/api/keypool/status'))
  assert.equal(result.status, 403)
})

test('the single row carries the route-pool config under routePool', async () => {
  const ctx = createCtx({ llm: providerService })
  apply(ctx, {
    routePool: {
      pools: [{ name: 'nested', routes: [{ provider: 'ustc-back', model: 'deepseek-flash' }, { provider: 'vendor-b', model: 'model-2' }] }],
      cooldownMs: 1234,
      maxSwitchesPerTurn: 4,
    },
  })
  const read = await exchange('GET').invoke(ctx.routes.get('/api/keypool/config'))
  assert.equal(read.status, 200)
  assert.equal(read.body.row.pools[0].routes.length, 2)
  assert.equal(read.body.row.cooldownMs, 1234)
  assert.equal(read.body.row.maxSwitchesPerTurn, 4)
})
