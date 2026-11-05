/**
 * dsh-llm-keypool — provider quota reader.
 *
 * The pool already knows *when* a provider ran out of quota (the request
 * failed). This module answers the question that comes *before* that: how much
 * quota is left right now, so the panel can show it and the pool can fail over
 * before the provider starts rejecting requests.
 *
 * ## Rules this module keeps
 *
 *  - credential **values** never leave this module: only the *reference* name
 *    (for example `MINIMAX_CN_API_KEY`) is returned or logged;
 *  - a quota read never throws into the request path — every failure is
 *    returned as data (`ok: false` plus a human-readable message);
 *  - an unknown provider is reported as *unsupported* instead of guessed.
 *
 * ## Where a provider's credential and endpoint come from
 *
 * In priority order (first hit wins per field):
 *
 *  1. the GUI-managed config file — `quota.providers` in
 *     `$DSH_HOME/keypool/route-pool.json` (the panel writes it);
 *  2. this row's `quota.providers` config in `cordis.patch.yml`;
 *  3. the DSH profile's own `llm-pi-ai` provider profiles (`apiKeyEnv`,
 *     `baseURL`), discovered from the profile's `cordis.patch.yml`;
 *  4. a small built-in table for the providers pi-ai ships by default.
 *
 * @module dsh-llm-keypool/quota
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readNonNegativeInt, readPositiveInt, readString } from './shared.js'

/** MiniMax coding-plan endpoint (works on the CN hosts). */
export const MINIMAX_REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains'

/** How long a reading stays fresh. */
export const DEFAULT_CACHE_MS = 5 * 60_000

/** Per-request timeout for the vendor endpoint. */
export const DEFAULT_TIMEOUT_MS = 8_000

/**
 * Upper bound for a quota-driven cooldown. A spent 5-hour window is back in
 * hours, a spent weekly window only in days, so the cap has to cover a whole
 * week (plus a day of slack for a sloppy vendor clock).
 */
export const MAX_QUOTA_COOLDOWN_MS = 8 * 24 * 60 * 60_000

/** DeepSeek balance endpoint. */
export const DEEPSEEK_BALANCE_PATH = '/user/balance'

/**
 * Providers pi-ai ships by default. The credential reference and the host are
 * the same ones pi-ai itself uses, so a stock profile works without any
 * configuration.
 */
const BUILTIN_PROVIDERS = {
  minimax: { ref: 'MINIMAX_API_KEY', baseUrl: 'https://api.minimax.io' },
  'minimax-cn': { ref: 'MINIMAX_CN_API_KEY', baseUrl: 'https://api.minimaxi.com' },
}

/** @returns {boolean} a non-array object. */
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {unknown} value
 * @returns {number | undefined} a finite number.
 */
const readNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * The host part of a base URL, lower-cased, without a trailing slash.
 * @param {string | undefined} baseUrl
 * @returns {string}
 */
export function hostOf(baseUrl) {
  if (typeof baseUrl !== 'string') return ''
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Which adapter handles a provider.
 *
 * `minimax` — the coding-plan endpoint (`/v1/api/openplatform/coding_plan/remains`).
 * `deepseek` — the balance endpoint (`/user/balance`).
 *
 * @param {string | undefined} baseUrl
 * @param {string} [providerId]
 * @returns {'minimax' | 'deepseek' | undefined}
 */
export function detectAdapterKind(baseUrl, providerId = '') {
  const host = hostOf(baseUrl)
  if (host.includes('minimax')) return 'minimax'
  if (host.includes('deepseek')) return 'deepseek'
  const id = providerId.toLowerCase()
  if (id.startsWith('minimax')) return 'minimax'
  if (id.startsWith('deepseek')) return 'deepseek'
  return undefined
}

/**
 * Normalize one `model_remains` entry of the MiniMax coding-plan response.
 *
 * The reliable readouts for a token plan are the remaining percentages and the
 * remaining time; the count fields are only filled for per-request plans.
 *
 * @param {Record<string, unknown>} entry
 * @returns {{ name: string, interval: object, weekly: object }}
 */
function normalizeMinimaxEntry(entry) {
  const number = (key) => readNumber(entry[key])
  return {
    name: readString(entry.model_name) ?? 'general',
    interval: {
      percent: number('current_interval_remaining_percent'),
      remainsMs: number('remains_time'),
      status: number('current_interval_status'),
      totalCount: number('current_interval_total_count'),
      usageCount: number('current_interval_usage_count'),
      startTime: number('start_time'),
      endTime: number('end_time'),
    },
    weekly: {
      percent: number('current_weekly_remaining_percent'),
      remainsMs: number('weekly_remains_time'),
      status: number('current_weekly_status'),
      totalCount: number('current_weekly_total_count'),
      usageCount: number('current_weekly_usage_count'),
      startTime: number('weekly_start_time'),
      endTime: number('weekly_end_time'),
    },
  }
}

/**
 * Parse a MiniMax coding-plan response.
 *
 * @param {unknown} body parsed JSON body.
 * @returns {{ ok: boolean, error: string | null, models: Array<object> }}
 */
export function parseMinimaxRemains(body) {
  if (!isPlainObject(body)) return { ok: false, error: '响应不是 JSON 对象', models: [] }
  const base = body.base_resp
  if (isPlainObject(base)) {
    const code = readNumber(base.status_code)
    if (code !== undefined && code !== 0) {
      const message = readString(base.status_msg) ?? `status_code ${code}`
      return { ok: false, error: `MiniMax 返回 ${code}：${message}`, models: [] }
    }
  }
  const list = Array.isArray(body.model_remains) ? body.model_remains : []
  if (list.length === 0) return { ok: false, error: '响应里没有 model_remains', models: [] }
  return { ok: true, error: null, models: list.filter(isPlainObject).map(normalizeMinimaxEntry) }
}

/**
 * Summarize a provider entry: is the plan spent, which window is spent, when
 * does it come back, and how much is left in the current window.
 *
 * A window is *spent* when its remaining percentage reached zero:
 *
 *  - the **5-hour window** spent → the provider is parked until that window
 *    ends (hours);
 *  - the **weekly window** spent → the provider stays parked for the rest of
 *    the week, even when the 5-hour window still has room; it only comes back
 *    when the weekly window resets.
 *
 * The reset time is the end of the spent window — the later of the two, so a
 * spent weekly window always wins over a spent 5-hour window.
 *
 * @param {{ models?: Array<object>, primary?: object | null }} entry
 * @returns {{ exhausted: boolean, intervalExhausted: boolean, weeklyExhausted: boolean, resetAt: number | undefined, percent: number | undefined }}
 */
export function summarizeEntry(entry) {
  const models = Array.isArray(entry?.models) ? entry.models : []
  const spent = models.filter((model) => {
    const interval = model?.interval?.percent
    const weekly = model?.weekly?.percent
    return (typeof interval === 'number' && interval <= 0) || (typeof weekly === 'number' && weekly <= 0)
  })
  const resets = []
  let intervalExhausted = false
  let weeklyExhausted = false
  for (const model of spent) {
    const interval = model?.interval
    const weekly = model?.weekly
    if (typeof interval?.percent === 'number' && interval.percent <= 0) {
      intervalExhausted = true
      if (typeof interval.endTime === 'number' && interval.endTime > 0) resets.push(interval.endTime)
    }
    if (typeof weekly?.percent === 'number' && weekly.percent <= 0) {
      weeklyExhausted = true
      if (typeof weekly.endTime === 'number' && weekly.endTime > 0) resets.push(weekly.endTime)
    }
  }
  const primary = entry?.primary ?? models[0]
  const percent = typeof primary?.interval?.percent === 'number'
    ? primary.interval.percent
    : primary?.weekly?.percent
  return {
    exhausted: spent.length > 0,
    intervalExhausted,
    weeklyExhausted,
    resetAt: resets.length > 0 ? Math.max(...resets) : undefined,
    percent: typeof percent === 'number' ? percent : undefined,
  }
}

/**
 * Parse a DeepSeek balance response.
 *
 * @param {unknown} body parsed JSON body.
 * @returns {{ ok: boolean, error: string | null, models: Array<object> }}
 */
export function parseDeepseekBalance(body) {
  if (!isPlainObject(body)) return { ok: false, error: '响应不是 JSON 对象', models: [] }
  const list = Array.isArray(body.balance_infos) ? body.balance_infos : []
  if (list.length === 0) return { ok: false, error: '响应里没有 balance_infos', models: [] }
  const models = list.filter(isPlainObject).map((entry) => ({
    name: readString(entry.currency) ?? 'balance',
    balance: {
      total: readNumber(entry.total_balance),
      granted: readNumber(entry.granted_balance),
      toppedUp: readNumber(entry.topped_up_balance),
      currency: readString(entry.currency) ?? 'CNY',
    },
  }))
  return { ok: true, error: null, models }
}

//#region provider discovery

/**
 * The DSH home directory.
 * @returns {string}
 */
export function dshHome() {
  const home = readString(process.env.DSH_HOME)
  return home ?? join(homedir(), '.dsh')
}

/**
 * The profile this plugin was installed into, derived from the module path
 * (`<profile>/node_modules/@nethiel/dsh-llm-keypool/lib/quota.js`).
 * @returns {string | undefined}
 */
export function ownProfileDir() {
  let dir = dirname(fileURLToPath(import.meta.url))
  const parts = dir.split(sep)
  const index = parts.lastIndexOf('profiles')
  if (index === -1 || index + 1 >= parts.length) return undefined
  return parts.slice(0, index + 2).join(sep)
}

/**
 * The profile patch files to scan, own profile first.
 * @returns {string[]}
 */
export function patchFiles() {
  const home = dshHome()
  const files = []
  const own = ownProfileDir()
  if (own !== undefined) files.push(join(own, 'cordis.patch.yml'))
  const profilesDir = join(home, 'profiles')
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(profilesDir, entry.name, 'cordis.patch.yml')
      if (!files.includes(file)) files.push(file)
    }
  } catch {
    // No profiles directory: nothing else to scan.
  }
  const root = join(home, 'cordis.patch.yml')
  if (!files.includes(root)) files.push(root)
  return files.filter((file) => existsSync(file))
}

/**
 * @param {string} line
 * @returns {number} the indentation width.
 */
const indentOf = (line) => line.length - line.trimStart().length

/**
 * @param {string} line
 * @returns {string} the trimmed line without comments.
 */
const contentOf = (line) => {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return ''
  return trimmed
}

/**
 * A minimal YAML reader for the one shape this plugin needs: the `llm-pi-ai`
 * row's `providers` map with `apiKeyEnv` and `baseURL` entries. It is only the
 * fallback for hosts without the `yaml` package.
 *
 * @param {string} text
 * @returns {Record<string, { ref?: string, baseUrl?: string }>}
 */
export function scanPiAiProviders(text) {
  const lines = text.split(/\r?\n/)
  const providers = {}

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('dsh-llm-pi-ai')) continue
    // The row is a YAML list item: the config block is indented deeper than
    // the item itself, not deeper than the line that mentioned the package.
    let rowIndent = indentOf(lines[index])
    for (let back = index; back >= 0; back -= 1) {
      if (contentOf(lines[back]).startsWith('- ')) {
        rowIndent = indentOf(lines[back])
        break
      }
    }

    // The row block: following lines that are deeper than the row itself.
    let cursor = index + 1
    let providersIndent = -1
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (contentOf(line) === '') { cursor += 1; continue }
      const indent = indentOf(line)
      if (indent <= rowIndent) break
      if (/^providers:\s*$/.test(contentOf(line))) { providersIndent = indent; break }
      cursor += 1
    }
    if (providersIndent === -1) continue

    // Provider entries: deeper than `providers:` and shaped like `name:`.
    let entry = null
    let entryIndent = -1
    for (cursor += 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      const content = contentOf(line)
      if (content === '') continue
      const indent = indentOf(line)
      if (indent <= providersIndent) break
      // List items belong to a nested key (for example `models:`).
      if (content.startsWith('-')) continue
      const match = /^([^:\s][^:]*):\s*(.*)$/.exec(content)
      if (match === null) continue
      const [, key, rest] = match
      if (rest === '') {
        // A key without a value: a nested map of the current provider (keep the
        // current entry) or the next provider name.
        if (entry !== null && indent > entryIndent) continue
        entry = key
        entryIndent = indent
        providers[key] = {}
        continue
      }
      if (entry === null) continue
      if (indent !== entryIndent && indent < entryIndent) { entry = null; continue }
      if (key === 'apiKeyEnv') providers[entry].ref = unquote(rest)
      else if (key === 'baseURL') providers[entry].baseUrl = unquote(rest)
    }
  }

  return providers
}

/**
 * @param {string} value
 * @returns {string} the value without surrounding quotes.
 */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Read the `llm-pi-ai` provider profiles out of a parsed patch document.
 * @param {unknown} document
 * @returns {Record<string, { ref?: string, baseUrl?: string }>}
 */
export function providersFromDocument(document) {
  const rows = Array.isArray(document) ? document : []
  const providers = {}
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const name = readString(row.name) ?? ''
    const id = readString(row.id) ?? ''
    if (!name.includes('dsh-llm-pi-ai') && id !== 'llm-pi-ai') continue
    const config = isPlainObject(row.config) ? row.config : {}
    const list = isPlainObject(config.providers) ? config.providers : {}
    for (const [providerId, profile] of Object.entries(list)) {
      if (!isPlainObject(profile)) continue
      const ref = readString(profile.apiKeyEnv)
      const baseUrl = readString(profile.baseURL)
      providers[providerId] = {
        ...(ref === undefined ? {} : { ref }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }
    }
  }
  return providers
}

/** Cached YAML parser; `null` when the `yaml` package is unavailable. */
let yamlParser

/**
 * @param {string} text
 * @returns {Promise<unknown | undefined>} the parsed document, or undefined.
 */
async function parseYaml(text) {
  if (yamlParser === undefined) {
    try {
      const module = await import('yaml')
      yamlParser = typeof module.parse === 'function' ? module : null
    } catch {
      yamlParser = null
    }
  }
  if (yamlParser === null) return undefined
  try {
    return yamlParser.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Discover the `llm-pi-ai` provider profiles of the running DSH profile.
 *
 * @returns {Promise<Record<string, { ref?: string, baseUrl?: string }>>}
 */
export async function discoverProfileProviders() {
  const found = {}
  for (const file of patchFiles()) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const document = await parseYaml(text)
    const providers = document === undefined
      ? scanPiAiProviders(text)
      : providersFromDocument(document)
    for (const [providerId, profile] of Object.entries(providers)) {
      if (found[providerId] === undefined) found[providerId] = profile
    }
  }
  return found
}

//#endregion

//#region source resolution

/**
 * Normalize one provider's quota source configuration.
 * @param {unknown} raw
 * @returns {{ ref?: string, baseUrl?: string, path?: string, kind?: string }}
 */
export function normalizeQuotaProvider(raw) {
  if (!isPlainObject(raw)) return {}
  const ref = readString(raw.apiKeyEnv) ?? readString(raw.ref) ?? readString(raw.credentialRef)
  const baseUrl = readString(raw.baseUrl) ?? readString(raw.baseURL) ?? readString(raw.url)
  const path = readString(raw.path)
  const kind = readString(raw.kind)
  return {
    ...(ref === undefined ? {} : { ref }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(path === undefined ? {} : { path }),
    ...(kind === undefined ? {} : { kind }),
  }
}

/**
 * Resolve one provider's quota source from the configured layers.
 *
 * @param {string} providerId
 * @param {Array<Record<string, any>>} layers priority order, highest first.
 * @returns {{ ref?: string, baseUrl?: string, path?: string, kind?: string }}
 */
export function resolveProviderSource(providerId, layers) {
  const merged = {}
  for (const layer of layers) {
    const entry = normalizeQuotaProvider(layer?.[providerId])
    for (const [key, value] of Object.entries(entry)) {
      if (merged[key] === undefined) merged[key] = value
    }
  }
  return merged
}

//#endregion

//#region quota service

/**
 * The default endpoint path per adapter kind.
 * @param {string} kind
 * @returns {string}
 */
function defaultPathFor(kind) {
  if (kind === 'deepseek') return DEEPSEEK_BALANCE_PATH
  return MINIMAX_REMAINS_PATH
}

/**
 * Join a base URL and an absolute endpoint path.
 *
 * Only the origin of the base URL is used: a provider's base URL usually
 * points at its API surface (`https://api.minimax.cn/anthropic`), while the
 * quota endpoint lives at the host root.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  const suffix = path.startsWith('/') ? path : `/${path}`
  try {
    const url = new URL(baseUrl)
    return `${url.origin}${suffix}`
  } catch {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    return `${base}${suffix}`
  }
}

/**
 * @param {any} ctx Cordis context.
 * @param {unknown} value the credential value.
 * @returns {boolean} whether the value looks usable.
 */
function usableValue(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Read a credential value for a reference. Only the reference name is ever
 * reported back to the caller; the value stays inside this function.
 *
 * @param {any} ctx
 * @param {string} ref
 * @returns {Promise<string | undefined>}
 */
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved !== null && usableValue(resolved.value)) return resolved.value
    } catch {
      // Fall through to the environment lookup below.
    }
  }
  const fromEnv = process.env[ref]
  return usableValue(fromEnv) ? fromEnv : undefined
}

/**
 * Create the quota service for one plugin instance.
 *
 * @param {any} ctx Cordis context.
 * @param {Record<string, any>} [config] the row's `quota` config.
 */
export function createQuotaService(ctx, config = {}) {
  const rowProviders = isPlainObject(config.providers) ? config.providers : {}
  const cacheMs = readNonNegativeInt(config.cacheMs, DEFAULT_CACHE_MS)
  const timeoutMs = readPositiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS)

  /** @type {Map<string, { at: number, entry: object }>} */
  const cache = new Map()
  /** @type {Record<string, { ref?: string, baseUrl?: string }> | undefined} */
  let profileProviders

  /**
   * @param {Record<string, any>} layers
   * @returns {Promise<Record<string, { ref?: string, baseUrl?: string }>>}
   */
  const profileLayer = async () => {
    if (profileProviders === undefined) profileProviders = await discoverProfileProviders()
    return profileProviders
  }

  /**
   * Resolve the quota source of one provider.
   * @param {string} providerId
   * @param {Record<string, any>} [guiProviders] GUI-managed overrides.
   * @returns {Promise<{ ref?: string, baseUrl?: string, path?: string, kind?: string }>}
   */
  const sourceFor = async (providerId, guiProviders = {}) => {
    const profile = await profileLayer()
    const layers = [
      guiProviders,
      rowProviders,
      profile,
      BUILTIN_PROVIDERS,
    ]
    const source = resolveProviderSource(providerId, layers)
    if (source.kind === undefined) {
      source.kind = detectAdapterKind(source.baseUrl, providerId)
    }
    if (source.path === undefined && source.kind !== undefined) {
      source.path = defaultPathFor(source.kind)
    }
    if (source.baseUrl !== undefined && source.path === undefined) {
      source.path = defaultPathFor(detectAdapterKind(source.baseUrl, providerId) ?? 'minimax')
    }
    return source
  }

  /**
   * Fetch and normalize the quota of one provider.
   *
   * @param {string} providerId
   * @param {{ force?: boolean, guiProviders?: Record<string, any> }} [options]
   * @returns {Promise<object>}
   */
  const read = async (providerId, options = {}) => {
    const cached = cache.get(providerId)
    if (!options.force && cached !== undefined && Date.now() - cached.at < cacheMs) return cached.entry

    const source = await sourceFor(providerId, options.guiProviders ?? {})
    const entry = {
      provider: providerId,
      ok: false,
      error: null,
      ref: source.ref ?? null,
      baseUrl: source.baseUrl ?? null,
      path: source.path ?? null,
      kind: source.kind ?? null,
      fetchedAt: Date.now(),
      models: [],
      primary: null,
    }

    if (source.kind === undefined) {
      entry.error = '这个供应商没有已知的额度接口（可手动配置）'
      cache.set(providerId, { at: entry.fetchedAt, entry })
      return entry
    }
    if (source.ref === undefined) {
      entry.error = '没有找到这个供应商的凭据引用（可手动配置）'
      cache.set(providerId, { at: entry.fetchedAt, entry })
      return entry
    }

    const secret = await resolveCredential(ctx, source.ref)
    if (secret === undefined) {
      entry.error = `凭据 ${source.ref} 没有可用的值`
      cache.set(providerId, { at: entry.fetchedAt, entry })
      return entry
    }

    const url = joinUrl(source.baseUrl ?? '', source.path ?? defaultPathFor(source.kind))
    try {
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) {
        entry.error = `接口返回 HTTP ${response.status}`
        cache.set(providerId, { at: entry.fetchedAt, entry })
        return entry
      }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        entry.error = '响应不是 JSON'
        cache.set(providerId, { at: entry.fetchedAt, entry })
        return entry
      }
      const parsed = source.kind === 'deepseek' ? parseDeepseekBalance(body) : parseMinimaxRemains(body)
      entry.ok = parsed.ok
      entry.error = parsed.error
      entry.models = parsed.models
      entry.primary = parsed.models.find((model) => model.name === 'general') ?? parsed.models[0] ?? null
      const summary = summarizeEntry(entry)
      entry.exhausted = summary.exhausted
      entry.intervalExhausted = summary.intervalExhausted
      entry.weeklyExhausted = summary.weeklyExhausted
      entry.resetAt = summary.resetAt
      entry.percent = summary.percent
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
    }

    cache.set(providerId, { at: entry.fetchedAt, entry })
    return entry
  }

  /**
   * The last reading of one provider, if any (no network access).
   * @param {string} providerId
   * @returns {object | undefined}
   */
  const cached = (providerId) => cache.get(providerId)?.entry

  /**
   * Quota state of one provider, from the last reading (no network access).
   * @param {string} providerId
   * @returns {{ ok: boolean, exhausted: boolean, resetAt: number | undefined, percent: number | undefined, entry: object | undefined }}
   */
  const state = (providerId) => {
    const entry = cached(providerId)
    if (entry === undefined || entry.ok !== true) {
      return {
        ok: false,
        exhausted: false,
        intervalExhausted: false,
        weeklyExhausted: false,
        resetAt: undefined,
        percent: undefined,
        entry,
      }
    }
    const summary = summarizeEntry(entry)
    return { ok: true, ...summary, entry }
  }

  /**
   * How long a provider must stay out of rotation because its plan is spent.
   * The answer follows the vendor's own reset time, so a 5-hour token plan
   * keeps the provider out for the rest of its window instead of a fixed
   * cooldown.
   *
   * @param {string} providerId
   * @returns {number | undefined} milliseconds, or undefined when the provider
   *   is not known to be out of quota.
   */
  const cooldownMs = (providerId) => {
    const current = state(providerId)
    if (!current.ok || !current.exhausted || current.resetAt === undefined) return undefined
    const wait = current.resetAt - Date.now()
    if (wait <= 0) return undefined
    return Math.min(wait, MAX_QUOTA_COOLDOWN_MS)
  }

  /**
   * Force a fresh reading of one provider.
   * @param {string} providerId
   * @param {{ guiProviders?: Record<string, any> }} [options]
   * @returns {Promise<object>}
   */
  const refresh = async (providerId, options = {}) =>
    read(providerId, { force: true, guiProviders: options.guiProviders ?? {} })

  /**
   * Whether the provider is known to be out of quota. Only a confirmed
   * reading counts — an unreadable quota never blocks a route.
   * @param {string} providerId
   * @returns {boolean}
   */
  const exhausted = (providerId) => {
    const entry = cached(providerId)
    if (entry === undefined || entry.ok !== true) return false
    return summarizeEntry(entry).exhausted
  }

  /**
   * Read every provider the panel cares about.
   *
   * @param {{ force?: boolean, providers?: string[], guiProviders?: Record<string, any> }} [options]
   * @returns {Promise<{ updatedAt: number, providers: object[] }>}
   */
  const snapshot = async (options = {}) => {
    const providerIds = options.providers ?? []
    const entries = []
    for (const providerId of providerIds) {
      entries.push(await read(providerId, { force: options.force, guiProviders: options.guiProviders }))
    }
    return { updatedAt: Date.now(), providers: entries }
  }

  return { read, snapshot, cached, exhausted, state, cooldownMs, refresh, sourceFor, cacheMs }
}

//#endregion
