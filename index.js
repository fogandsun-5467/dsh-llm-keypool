/**
 * `@nethiel/dsh-llm-keypool` — the package's single Host entry: panel API plus
 * both failover behaviors.
 *
 * ## Why one row for everything
 *
 * DSH's client module system identifies a browser bundle by its **package
 * name** and treats more than one active Loader source for that package as a
 * composition error — the bundle then executes twice and throws
 * `duplicate factory registration`. The real-world symptom (0.1.0) was that
 * error repeating in `desktop-next.log` every few minutes.
 *
 * So the package is mounted through exactly **one** row (`llm-keypool`), and
 * that row applies the two behavior plugins in-process instead of exposing
 * them as extra `/route-pool` and `/key-rotate` Loader entries:
 *
 *  - `lib/route-pool.js`  — ordered route pool, quota failover (applied always;
 *    inert while the pool is empty)
 *  - `lib/key-rotate.js`  — credential rotation (only when configured, because
 *    it acts as soon as `activeRef` + `refs` are set)
 *
 * The panel half is this row's browser bundle; its loopback API lives here:
 *
 *  - `GET  /api/keypool/catalog`  every registered provider with its models
 *  - `GET  /api/keypool/config`   the GUI-managed pool file and the row fallback
 *  - `POST /api/keypool/config`   validate + atomically write the pool file
 *  - `GET  /api/keypool/status`   active route, cooling routes, recent switches
 *
 * Config shape (all optional):
 *
 * ```yaml
 * - id: llm-keypool
 *   name: '@nethiel/dsh-llm-keypool'
 *   config:
 *     routePool: { pools: [], cooldownMs: 600000, maxSwitchesPerTurn: 3, codes: [...], patterns: [...] }
 *     keyRotate: { enabled: false, activeRef: '', refs: [] }
 * ```
 *
 * A flat legacy shape (`pools`, `codes`, `activeRef`, `refs` at the top level)
 * is still honoured so configs written for 0.1.0 keep working.
 *
 * @module dsh-llm-keypool
 */
import {
  configFilePath,
  readStoredConfig,
  statusSnapshot,
  storedConfigError,
  writeStoredConfig,
} from './lib/runtime.js'
import { readNonNegativeInt, readPositiveInt, readStringArray, normalizeRoutePools } from './lib/shared.js'
import { apply as applyRoutePool } from './lib/route-pool.js'
import { apply as applyKeyRotate } from './lib/key-rotate.js'
import { createQuotaService, DEFAULT_CACHE_MS } from './lib/quota.js'

/** Cordis plugin name (matches the package name so the browser half attaches). */
export const name = '@nethiel/dsh-llm-keypool'

/**
 * The panel API needs the web server (and the live model catalog). Declaring
 * them as required inject makes Cordis activate this row *after* those services
 * are up: reading `ctx.get('webServer')` at apply time instead returns
 * `undefined` while the service fiber is still inactive, which silently skips
 * the routes and makes the panel see HTTP 404 (observed in 0.1.2).
 */
export const inject = ['webServer', 'llm']

const PREFIX = '/api/keypool/'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** @returns {boolean} whether the request comes from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Normalize one catalog model entry. */
const modelEntry = (model) => ({
  id: typeof model?.id === 'string' ? model.id : String(model),
  name: typeof model?.name === 'string' && model.name !== ''
    ? model.name
    : (typeof model?.id === 'string' ? model.id : String(model)),
})

/** @returns {boolean} a non-array object. */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Behavior options for `lib/route-pool.js`: the nested `routePool` object, or
 * the flat 0.1.0 layout as a fallback.
 * @param {Record<string, any>} config
 */
function routePoolOptions(config) {
  if (isPlainObject(config.routePool)) return config.routePool
  return {
    ...(Array.isArray(config.pools) ? { pools: config.pools } : {}),
    ...(config.codes === undefined ? {} : { codes: config.codes }),
    ...(config.patterns === undefined ? {} : { patterns: config.patterns }),
    ...(config.cooldownMs === undefined ? {} : { cooldownMs: config.cooldownMs }),
    ...(config.maxSwitchesPerTurn === undefined ? {} : { maxSwitchesPerTurn: config.maxSwitchesPerTurn }),
    ...(config.preferFirst === undefined ? {} : { preferFirst: config.preferFirst }),
    ...(config.dryRun === undefined ? {} : { dryRun: config.dryRun }),
  }
}

/**
 * Behavior options for `lib/key-rotate.js`: the nested `keyRotate` object, or
 * the flat 0.1.0 layout as a fallback.
 * @param {Record<string, any>} config
 */
function keyRotateOptions(config) {
  if (isPlainObject(config.keyRotate)) return config.keyRotate
  return {
    ...(config.activeRef === undefined ? {} : { activeRef: config.activeRef }),
    ...(config.refs === undefined ? {} : { refs: config.refs }),
    ...(config.maxSwitchesPerTurn === undefined ? {} : { maxSwitchesPerTurn: config.maxSwitchesPerTurn }),
    ...(config.watchProviders === undefined ? {} : { watchProviders: config.watchProviders }),
    ...(config.dryRun === undefined ? {} : { dryRun: config.dryRun }),
  }
}

/**
 * Behavior options for the quota reader: the nested `quota` object, or a flat
 * legacy layout as a fallback.
 * @param {Record<string, any>} config
 */
function quotaOptions(config) {
  if (isPlainObject(config.quota)) return config.quota
  return {
    ...(config.quotaProviders === undefined ? {} : { providers: config.quotaProviders }),
    ...(config.quotaCacheMs === undefined ? {} : { cacheMs: config.quotaCacheMs }),
    ...(config.quotaEnabled === undefined ? {} : { enabled: config.quotaEnabled }),
  }
}

/**
 * @param {any} ctx Cordis context.
 * @param {Record<string, any>} [config] this row's config.
 */
export function apply(ctx, config = {}) {
  const routePool = routePoolOptions(config)
  const rowCodes = readStringArray(routePool.codes)
  const rowFallback = {
    pools: Array.isArray(routePool.pools) ? routePool.pools : [],
    cooldownMs: readNonNegativeInt(routePool.cooldownMs, 10 * 60_000),
    maxSwitchesPerTurn: readPositiveInt(routePool.maxSwitchesPerTurn, 3),
    ...(rowCodes === undefined ? {} : { codes: rowCodes }),
    // Pool order as preference order (off unless the panel or the row says so).
    preferFirst: routePool.preferFirst === true,
  }

  // ---- quota reader -------------------------------------------------------
  // The pool knows *when* a provider ran out; the quota reader knows *how much
  // is left*, so the panel can show it and the pool can fail over early.
  const quota = quotaOptions(config)
  const quotaEnabled = quota.enabled !== false
  const quotaService = createQuotaService(ctx, {
    providers: isPlainObject(quota.providers) ? quota.providers : {},
    cacheMs: readNonNegativeInt(quota.cacheMs, DEFAULT_CACHE_MS),
  })

  /** The GUI-managed quota section, if the pool file has one. */
  const guiQuota = () => {
    const stored = readStoredConfig()
    return stored?.quota ?? { enabled: true, cacheMs: DEFAULT_CACHE_MS, providers: {} }
  }

  /** Every provider worth reading a quota for. */
  const quotaProviderIds = () => {
    const ids = new Set()
    const stored = readStoredConfig()
    for (const pool of stored?.pools ?? []) {
      for (const route of pool.routes ?? []) ids.add(route.provider)
    }
    for (const pool of normalizeRoutePools(rowFallback.pools)) {
      for (const route of pool.routes) ids.add(route.provider)
    }
    for (const providerId of Object.keys(guiQuota().providers ?? {})) ids.add(providerId)
    for (const providerId of Object.keys(isPlainObject(quota.providers) ? quota.providers : {})) ids.add(providerId)
    return [...ids]
  }

  /** @param {import('node:http').ServerResponse} res */
  const sendConfig = (res) => {
    const stored = readStoredConfig()
    sendJson(res, 200, {
      file: configFilePath(),
      stored: stored ?? null,
      storedError: stored === undefined ? (storedConfigError() ?? null) : null,
      row: rowFallback,
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}catalog`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      ;(async () => {
        const llm = ctx.get('llm')
        const providers = llm === undefined ? [] : llm.listProviders()
        const catalog = []
        for (const provider of providers) {
          let models = []
          try {
            if (llm !== undefined) models = await llm.listModels(provider.id)
          } catch {
            models = []
          }
          catalog.push({
            provider: provider.id,
            displayName: typeof provider.displayName === 'string' && provider.displayName !== ''
              ? provider.displayName
              : provider.id,
            models: Array.isArray(models) ? models.map(modelEntry) : [],
          })
        }
        sendJson(res, 200, { providers: catalog })
      })().catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }))
    },
  }), 'llm-keypool: catalog route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}config`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method === 'GET') return sendConfig(res)
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'GET or POST only' })
      ;(async () => {
        const raw = await readBody(req)
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          return sendJson(res, 400, { error: 'body is not valid JSON' })
        }
        try {
          const saved = writeStoredConfig(parsed)
          return sendJson(res, 200, { ok: true, saved, file: configFilePath() })
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }))
    },
  }), 'llm-keypool: config route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}status`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      sendJson(res, 200, statusSnapshot())
    },
  }), 'llm-keypool: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${PREFIX}quota`,
    handler: (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      ;(async () => {
        const gui = guiQuota()
        if (!quotaEnabled || gui.enabled === false) {
          return sendJson(res, 200, { enabled: false, updatedAt: Date.now(), providers: [] })
        }
        const refresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
        const snapshot = await quotaService.snapshot({
          force: refresh,
          providers: quotaProviderIds(),
          guiProviders: gui.providers ?? {},
        })
        sendJson(res, 200, {
          enabled: true,
          updatedAt: snapshot.updatedAt,
          providers: snapshot.providers,
        })
      })().catch((error) => sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }))
    },
  }), 'llm-keypool: quota route')

  // Keep the quota cache warm so the pool can fail over before the provider
  // starts rejecting requests. The reader's own TTL keeps the vendor calls
  // rare (one refresh per cache window).
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!quotaEnabled || guiQuota().enabled === false) return
      const providers = quotaProviderIds()
      if (providers.length === 0) return
      quotaService.snapshot({ providers, guiProviders: guiQuota().providers ?? {} })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`llm-keypool: quota refresh failed: ${message}`)
        })
    }, 60_000)
    // The refresher must not be the reason the host stays alive.
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'llm-keypool: quota refresher')

  // ---- behavior, applied in this fiber (one Loader source for the package) ----
  // A behavior-initialisation failure must never take the panel API down with it.
  try {
    applyRoutePool(ctx, {
      ...routePool,
      quota: {
        // The switch-over only follows the quota while the reader is enabled;
        // a disabled reader must never steer the pool.
        exhausted: (provider) => (quotaEnabled && guiQuota().enabled !== false ? quotaService.exhausted(provider) : false),
        // How long a spent provider must stay out. The reader answers with the
        // vendor's own reset time (the rest of the 5-hour token-plan window),
        // so a quota failure parks the provider for hours, not minutes.
        cooldownMs: async (provider) => {
          if (!quotaEnabled || guiQuota().enabled === false) return undefined
          const gui = guiQuota()
          // Refresh first: the cached reading may predate the failure.
          try {
            await quotaService.refresh(provider, { guiProviders: gui.providers ?? {} })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger.warn(`llm-keypool: quota refresh after failure failed: ${message}`)
          }
          return quotaService.cooldownMs(provider)
        },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.error(`llm-keypool: route-pool init failed: ${message}`)
  }

  const keyRotate = keyRotateOptions(config)
  const activeRef = typeof keyRotate.activeRef === 'string' ? keyRotate.activeRef : ''
  const refs = Array.isArray(keyRotate.refs) ? keyRotate.refs : []
  const keyRotateEnabled = keyRotate.enabled === true
    || (keyRotate.enabled === undefined && activeRef !== '' && refs.length > 0)
  if (keyRotateEnabled) {
    try {
      ctx.logger.info('llm-keypool: applying credential rotation (llm-key-rotate)')
      applyKeyRotate(ctx, { ...keyRotate, enabled: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.error(`llm-keypool: key-rotate init failed: ${message}`)
    }
  }
}
