/**
 * dsh-llm-keypool — shared runtime state between the bundle's host rows.
 *
 * The UI row (`dsh-llm-keypool` package root) and the behavior rows
 * (`…/route-pool`, `…/key-rotate`) are separate Cordis entries in one process.
 * They agree through this module:
 *  - **pool config file**: the GUI writes `$DSH_HOME/keypool/route-pool.json`;
 *    `route-pool` reads it per request (mtime-cached) and falls back to its row
 *    config when the file is absent or invalid;
 *  - **live status**: the behavior row publishes active route / cooling routes /
 *    recent switches, which the UI row serves to the browser.
 *
 * Nothing here touches session state, credentials, or logs.
 *
 * @module dsh-llm-keypool/runtime
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { normalizeRoutePools, readPositiveInt, readNonNegativeInt, readString, readStringArray } from './shared.js'

/** Subdirectory and file name of the GUI-managed pool config. */
const CONFIG_DIR = 'keypool'
const CONFIG_FILE = 'route-pool.json'

/** @returns {string} absolute path of the GUI-managed pool config file. */
export function configFilePath() {
  const override = typeof process.env.DSH_KEYPOOL_CONFIG === 'string' ? process.env.DSH_KEYPOOL_CONFIG.trim() : ''
  if (override !== '') return override
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, CONFIG_DIR, CONFIG_FILE)
}

/**
 * Normalize one provider's quota overrides.
 * @param {unknown} raw
 * @returns {{ apiKeyEnv?: string, baseUrl?: string, path?: string, kind?: string }}
 */
export function normalizeQuotaProvider(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of ['apiKeyEnv', 'baseUrl', 'path', 'kind']) {
    const value = readString(raw[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Normalize the GUI-managed quota section.
 * @param {unknown} raw
 * @returns {{ enabled: boolean, cacheMs: number, providers: Record<string, object> }}
 */
export function normalizeQuotaConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: true, cacheMs: 5 * 60_000, providers: {} }
  }
  const providers = {}
  if (raw.providers !== null && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
    for (const [providerId, entry] of Object.entries(raw.providers)) {
      const normalized = normalizeQuotaProvider(entry)
      if (Object.keys(normalized).length > 0) providers[providerId] = normalized
    }
  }
  return {
    enabled: raw.enabled !== false,
    cacheMs: readNonNegativeInt(raw.cacheMs, 5 * 60_000),
    providers,
  }
}

/**
 * Normalize a GUI-written config document.
 * @param {unknown} raw
 * @returns {{ pools: ReturnType<typeof normalizeRoutePools>, cooldownMs: number, maxSwitchesPerTurn: number, preferFirst: boolean, codes?: string[], quota: ReturnType<typeof normalizeQuotaConfig> }}
 * @throws {Error} when the document is not an object with a usable pool list.
 */
export function normalizeStoredConfig(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('config must be a JSON object')
  const pools = normalizeRoutePools(raw.pools)
  if (pools.length === 0) throw new Error('config needs at least one pool with two or more (provider, model) routes')
  const codes = readStringArray(raw.codes)
  return {
    pools,
    cooldownMs: readNonNegativeInt(raw.cooldownMs, 10 * 60_000),
    maxSwitchesPerTurn: readPositiveInt(raw.maxSwitchesPerTurn, 3),
    // Optional: pool order as preference order. When true, the first healthy
    // route of the pool wins, even if the resolved route is healthy too. The
    // panel writes it when its "优先用第一个套餐" checkbox is used.
    preferFirst: raw.preferFirst === true,
    // Optional: replaces the row/default trigger codes when present. The panel
    // writes it when the "认证失败也切换" checkbox is used.
    ...(codes === undefined ? {} : { codes }),
    // Optional: the quota reader's settings and per-provider overrides.
    quota: normalizeQuotaConfig(raw.quota),
  }
}

/** @type {{ path: string, mtimeMs: number, value: ReturnType<typeof normalizeStoredConfig> | undefined, error: string | undefined }} */
const cache = { path: '', mtimeMs: -1, value: undefined, error: undefined }

/**
 * Read the GUI-managed config, cached by file mtime so per-request reads are
 * cheap. Returns undefined when the file is absent or invalid (the caller then
 * falls back to its row config).
 * @returns {ReturnType<typeof normalizeStoredConfig> | undefined}
 */
export function readStoredConfig() {
  const path = configFilePath()
  if (path !== cache.path) {
    cache.path = path
    cache.mtimeMs = -1
    cache.value = undefined
    cache.error = undefined
  }
  let mtimeMs
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    cache.value = undefined
    cache.error = undefined
    return undefined
  }
  if (mtimeMs === cache.mtimeMs) return cache.value
  cache.mtimeMs = mtimeMs
  try {
    // A hand-saved editor may prepend a UTF-8 BOM; JSON.parse would reject it.
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')
    const parsed = JSON.parse(text)
    cache.value = normalizeStoredConfig(parsed)
    cache.error = undefined
  } catch (error) {
    cache.value = undefined
    cache.error = error instanceof Error ? error.message : String(error)
  }
  return cache.value
}

/** Reason the last stored-config read failed, if it did (for the UI). */
export function storedConfigError() {
  readStoredConfig()
  return cache.error
}

/**
 * Write the GUI-managed config atomically and refresh the cache.
 * @param {unknown} raw
 * @returns {ReturnType<typeof normalizeStoredConfig>} the normalized document.
 * @throws {Error} when the document is invalid (nothing is written then).
 */
export function writeStoredConfig(raw) {
  const normalized = normalizeStoredConfig(raw)
  const path = configFilePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  cache.path = path
  cache.mtimeMs = statSync(path).mtimeMs
  cache.value = normalized
  cache.error = undefined
  return normalized
}

//#region live status

/** @type {{ startedAt: number, active: { provider: string, model: string, at: number } | undefined, cooling: Map<string, number>, switches: Array<{ at: number, from: string, to: string, reason: string }>, lastFailure: { at: number, provider: string, detail: string } | undefined }} */
const state = {
  startedAt: Date.now(),
  active: undefined,
  cooling: new Map(),
  switches: [],
  lastFailure: undefined,
}

const MAX_SWITCHES = 30

/** Publish the route a request resolved to (after any rewrite). */
export function noteActiveRoute(provider, model) {
  state.active = { provider: String(provider), model: String(model), at: Date.now() }
}

/** Publish that a provider is cooling until `untilMs`. */
export function noteCooling(provider, untilMs) {
  state.cooling.set(String(provider), Number(untilMs))
}

/** Remember one failover switch (newest last, capped). */
export function noteSwitch(from, to, reason) {
  state.switches.push({ at: Date.now(), from: String(from), to: String(to), reason: String(reason) })
  if (state.switches.length > MAX_SWITCHES) state.switches.splice(0, state.switches.length - MAX_SWITCHES)
}

/** Remember the last observed quota failure for the status panel. */
export function noteFailure(provider, detail) {
  state.lastFailure = { at: Date.now(), provider: String(provider), detail: String(detail) }
}

/** Detached snapshot for the status endpoint. */
export function statusSnapshot() {
  const now = Date.now()
  const cooling = []
  for (const [provider, until] of state.cooling) {
    if (until <= now) state.cooling.delete(provider)
    else cooling.push({ provider, untilMs: until, remainingMs: until - now })
  }
  return {
    startedAt: state.startedAt,
    now,
    active: state.active === undefined ? null : { ...state.active },
    cooling,
    switches: state.switches.map((entry) => ({ ...entry })).reverse(),
    lastFailure: state.lastFailure === undefined ? null : { ...state.lastFailure },
    configFile: configFilePath(),
  }
}

//#endregion
