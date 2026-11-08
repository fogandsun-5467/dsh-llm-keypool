/**
 * dsh-llm-keypool — shared helpers for the two host plugins.
 *
 * Both plugins run on the same failure surface (`agent/request-error`) and
 * share the quota classifier and the per-turn switch budget implemented here,
 * so the two plugins never drift apart on what "quota exhausted" means.
 *
 * Rules this module must keep:
 *  - never throw on malformed user configuration from `cordis.patch.yml`;
 *  - never treat an empty/missing value as a configured value;
 *  - never expose credential values in logs.
 */

/**
 * Canonical harness failure codes that mean "this credential/route is out of
 * quota" rather than "this request was bad". Mirrors
 * `@deepseek-ai/dsh-llm`'s QUOTA_EXCEEDED_CODE / ACCOUNT_QUOTA_EXCEEDED_CODE.
 */
export const DEFAULT_CODES = ['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT']

/**
 * Failure codes that do **not** name a spent plan but can hide one.
 *
 * A vendor whose plan is exhausted often does not answer "quota exceeded": the
 * request hangs, the connection drops, or the gateway returns an error page.
 * These codes are the shapes the pool asks the vendor about before it gives up
 * on a route, because the route may still be alive.
 */
export const DEFAULT_AMBIGUOUS_CODES = ['TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE']

/**
 * Provider-error wording that the harness classifies only when its English
 * regexes match. Chinese gateways (the common case for this plugin's users)
 * phrase the same condition as 余额/额度/配额/欠费, so both vocabularies are
 * covered here. Entries are regular-expression sources, compiled
 * case-insensitively and unicode-aware.
 */
export const DEFAULT_PATTERNS = [
  'insufficient[\\s_-]+(?:quota|balance|credits?)',
  '(?:quota|usage[\\s_-]+limit)[\\s_-]+(?:exceeded|exhausted|reached)',
  '(?:balance|credits?)[\\s_-]+(?:exhausted|depleted)',
  '余额\\s*(?:不足|耗尽|用完|已用尽)',
  '额度\\s*(?:不足|用尽|耗尽|超限|已用尽)',
  '配额\\s*(?:不足|用尽|耗尽|超限|已用尽)',
  '欠费',
  'rate[\\s_-]*limit[\\s_-]*(?:exceeded|reached|hit)',
  'too[\\s_-]+many[\\s_-]+requests',
  '限流',
  '请求(?:过于|太过)?频繁',
]

/**
 * Wording of a failure that looks like a hiccup rather than a spent plan.
 *
 * These are the messages a route that is still alive produces when the
 * network hiccups. They are only used to decide *whether to ask the vendor*,
 * never to decide that a route is dead.
 */
export const DEFAULT_AMBIGUOUS_PATTERNS = [
  'timed?\\s*out',
  'timeout',
  'etimedout',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'socket hang up',
  '超时',
  '连接(?:重置|被拒绝|中断)',
]

/** Read a non-empty trimmed string, or undefined. */
export function readString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read an array of non-empty strings, preserving order and dropping invalid
 * entries. Returns undefined when the value is not an array at all, so callers
 * can distinguish "not configured" from "configured empty".
 */
export function readStringArray(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const entry of value) {
    const text = readString(entry)
    if (text !== undefined) out.push(text)
  }
  return out
}

/** Read a finite, positive integer, or the fallback. */
export function readPositiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/** Read a finite, non-negative integer (milliseconds, 0 allowed), or the fallback. */
export function readNonNegativeInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/**
 * Compile the configured pattern sources. `patterns` replaces the default list
 * when provided (so a deployment can silence a noisy default); invalid regex
 * sources are skipped instead of failing the plugin.
 * @param {unknown} patterns
 * @param {string[]} [defaults] the pattern list used when none are configured
 * @returns {RegExp[]}
 */
export function compilePatterns(patterns, defaults = DEFAULT_PATTERNS) {
  const sources = readStringArray(patterns)
  const effective = sources === undefined ? defaults : sources
  const compiled = []
  for (const source of effective) {
    try {
      compiled.push(new RegExp(source, 'iu'))
    } catch {
      // A bad pattern from the profile patch must not break request handling.
    }
  }
  return compiled
}

/**
 * Whether a request failure identifies an exhausted quota/balance — the only
 * condition both plugins may react to.
 * @param {{ code?: unknown, message?: unknown } | undefined} failure
 * @param {{ codes?: unknown, patterns?: unknown, regexes?: RegExp[] }} [options]
 * @returns {boolean}
 */
export function matchesFailure(failure, options = {}) {
  if (failure === null || typeof failure !== 'object') return false
  const codes = readStringArray(options.codes) ?? DEFAULT_CODES
  if (typeof failure.code === 'string' && codes.includes(failure.code)) return true
  const text = typeof failure.message === 'string' ? failure.message : ''
  if (text === '') return false
  const regexes = Array.isArray(options.regexes) ? options.regexes : compilePatterns(options.patterns)
  for (const regex of regexes) {
    if (regex.test(text)) return true
  }
  return false
}

/** Short, credential-free description of a failure for logs. */
export function describeFailure(failure) {
  const code = failure !== null && typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : 'UNKNOWN'
  const raw = failure !== null && typeof failure === 'object' && typeof failure.message === 'string' ? failure.message : ''
  const message = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  return `${code}${message === '' ? '' : `: ${message}`}`
}

/**
 * Per-agent, per-turn budget of how many times a failure may trigger a switch.
 * A new turn resets the bucket; a plugin never retries forever because the
 * budget is consulted before every switch.
 */
export class SwitchBudget {
  /** @type {WeakMap<object, { turn: unknown, count: number }>} */
  #states = new WeakMap()
  /** @type {{ turn: unknown, count: number }} */
  #anonymous = { turn: undefined, count: 0 }

  #bucketFor(agent, turn) {
    if (agent === null || typeof agent !== 'object') {
      if (this.#anonymous.turn !== turn) this.#anonymous = { turn, count: 0 }
      return this.#anonymous
    }
    let bucket = this.#states.get(agent)
    if (bucket === undefined || bucket.turn !== turn) {
      bucket = { turn, count: 0 }
      this.#states.set(agent, bucket)
    }
    return bucket
  }

  /** How many switches this agent already consumed in this turn. */
  used(agent, turn) {
    return this.#bucketFor(agent, turn).count
  }

  /**
   * Consume one switch if the budget allows it.
   * @param {unknown} agent
   * @param {unknown} turn
   * @param {number} max
   * @returns {boolean} true when one switch was consumed.
   */
  take(agent, turn, max) {
    if (!Number.isFinite(max) || max <= 0) return false
    const bucket = this.#bucketFor(agent, turn)
    if (bucket.count >= max) return false
    bucket.count += 1
    return true
  }
}

/**
 * Normalize a configured route pool.
 *
 * A pool is a manually ordered list of `(provider, model)` pairs. Two shapes
 * are accepted so old hand-written configs keep working:
 *  - `{ routes: [{ provider, model }, …] }` — each route names its own model;
 *  - `{ model: 'x', routes: [{ provider }] }` — a route without `model`
 *    inherits the pool model.
 *
 * Malformed pools are dropped instead of failing plugin activation.
 *
 * @param {unknown} raw
 * @returns {Array<{ name?: string, routes: Array<{ provider: string, model: string }>, cooldownMs?: number }>}
 */
export function normalizeRoutePools(raw) {
  if (!Array.isArray(raw)) return []
  const pools = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    if (!Array.isArray(entry.routes)) continue
    const poolModel = readString(entry.model)
    const poolCooldown = readNonNegativeInt(entry.cooldownMs, undefined)
    const routes = []
    for (const route of entry.routes) {
      if (route === null || typeof route !== 'object') continue
      const provider = readString(route.provider)
      if (provider === undefined) continue
      const model = readString(route.model) ?? poolModel
      if (model === undefined) continue
      if (routes.some((other) => other.provider === provider && other.model === model)) continue
      routes.push({ provider, model })
    }
    if (routes.length < 2) continue
    const pool = { routes }
    const poolName = readString(entry.name)
    if (poolName !== undefined) pool.name = poolName
    if (poolCooldown !== undefined) pool.cooldownMs = poolCooldown
    pools.push(pool)
  }
  return pools
}

