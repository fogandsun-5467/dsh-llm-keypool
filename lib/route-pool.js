/**
 * `llm-route-pool` — a host plugin that fails a model request over to the next
 * healthy route in a **manually ordered pool** when the current route reports
 * an exhausted quota.
 *
 * A pool is a hand-picked list of `provider` + `model` pairs, possibly from
 * different providers and different models (for example six models across
 * three vendors). The list order is the failover order and each entry is
 * matched exactly against the route a request resolved to.
 *
 * Where the pool comes from (first wins):
 *  1. the GUI-managed file `$DSH_HOME/keypool/route-pool.json`, written by the
 *     bundle's own settings panel (see `lib/client.js` + `lib/runtime.js`);
 *  2. this row's `pools` config in `cordis.patch.yml` (hand-written setups).
 * The file is re-read per request (mtime-cached), so saving in the panel takes
 * effect without a restart.
 *
 * Extension points:
 *  - `agent/request` (registered with `{ prepend: true }`) rewrites
 *    `provider`/`model` when the selected route is cooling down. Prepending
 *    matters: DSH's own per-agent model selection listens on the same
 *    waterfall and overrides the provider AFTER `next()` resolves.
 *  - `agent/request-error` marks the failing provider as cooling and asks the
 *    loop to retry the step; the retried request passes through the rewrite.
 *
 * Hard rules: never append session events, never throw into the waterfall,
 * never log credential values.
 *
 * @module dsh-llm-keypool/route-pool
 */
import {
  compilePatterns,
  describeFailure,
  matchesFailure,
  normalizeRoutePools,
  readNonNegativeInt,
  readPositiveInt,
  readString,
  readStringArray,
  SwitchBudget,
} from './shared.js'
import {
  noteActiveRoute,
  noteCooling,
  noteFailure,
  noteSwitch,
  readStoredConfig,
  storedConfigError,
} from './runtime.js'

/** Cordis plugin name. */
export const name = 'llm-route-pool'

/** Human-readable route label for logs. */
const routeLabel = (route) => `${route.provider}/${route.model}`

/**
 * Human-readable duration for logs: "3 小时 12 分".
 * @param {number} ms
 * @returns {string}
 */
const humanDuration = (ms) => {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000))
  if (totalMinutes < 1) return '不到 1 分钟'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分`
}

/**
 * @param {any} ctx Cordis context.
 * @param {Record<string, unknown>} [config] row config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const rowPools = normalizeRoutePools(config.pools)
  const rowCooldownMs = readNonNegativeInt(config.cooldownMs, 10 * 60_000)
  const rowMaxSwitchesPerTurn = readPositiveInt(config.maxSwitchesPerTurn, 3)
  const regexes = compilePatterns(config.patterns)
  const rowCodes = readStringArray(config.codes)
  const dryRun = config.dryRun === true
  // Pool order as preference order: when on, the first healthy route of the
  // pool wins even when the resolved route is healthy too.
  const rowPreferFirst = config.preferFirst === true
  // Optional hook from the quota reader: `exhausted(provider) -> boolean`.
  // When it reports an exhausted quota the pool routes around the provider
  // *before* the vendor starts rejecting requests.
  const quotaExhausted = typeof config.quota?.exhausted === 'function' ? config.quota.exhausted : undefined
  // Optional hook from the quota reader: `cooldownMs(provider) -> ms | undefined`.
  // It answers "how long until the plan is back?", so a spent 5-hour token
  // plan keeps its provider out of rotation for the rest of the window
  // instead of a fixed number of minutes.
  const quotaCooldownHook = typeof config.quota?.cooldownMs === 'function' ? config.quota.cooldownMs : undefined

  if (rowPools.length === 0 && readStoredConfig() === undefined) {
    ctx.logger.warn(
      'llm-route-pool: no pool configured yet — set one in the "轮换池" panel (writes '
        + '$DSH_HOME/keypool/route-pool.json) or add "pools" to this row in cordis.patch.yml',
    )
  }

  const budget = new SwitchBudget()

  /** @type {Map<string, number>} provider -> epoch ms until which it is cooling */
  const coolingUntil = new Map()
  let lastConfigError

  const isCooling = (provider) => {
    const until = coolingUntil.get(provider)
    return until !== undefined && Date.now() < until
  }

  /**
   * True when the quota reader knows the provider's plan is spent.
   * Never throws: a broken quota hook must not break routing.
   * @param {string} provider
   */
  const isExhausted = (provider) => {
    if (quotaExhausted === undefined) return false
    try {
      return quotaExhausted(provider) === true
    } catch {
      return false
    }
  }

  /**
   * How long the vendor says the provider must stay out. Never throws: a
   * broken quota hook must not break routing.
   * @param {string} provider
   * @returns {Promise<number | undefined>}
   */
  const quotaCooldown = async (provider) => {
    if (quotaCooldownHook === undefined) return undefined
    try {
      const value = await quotaCooldownHook(provider)
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Effective pool settings: GUI file when present and valid, otherwise the
   * row config. Re-read every request so a panel save applies immediately.
   */
  const effective = () => {
    const stored = readStoredConfig()
    if (stored !== undefined) {
      lastConfigError = undefined
      return {
        pools: stored.pools,
        cooldownMs: stored.cooldownMs,
        maxSwitchesPerTurn: stored.maxSwitchesPerTurn,
        // The panel-written codes replace the row codes when present.
        codes: stored.codes ?? rowCodes,
        // The panel checkbox is the source of truth for the pool order.
        preferFirst: stored.preferFirst === true,
      }
    }
    const error = storedConfigError()
    if (error !== undefined && error !== lastConfigError) {
      lastConfigError = error
      ctx.logger.warn(`llm-route-pool: ignoring unreadable pool config file: ${error}`)
    }
    return { pools: rowPools, cooldownMs: rowCooldownMs, maxSwitchesPerTurn: rowMaxSwitchesPerTurn, codes: rowCodes, preferFirst: rowPreferFirst }
  }

  /** The pool entry matching the resolved request, if any. */
  const routeFor = (pool, resolved) =>
    pool.routes.find((route) => route.provider === resolved.provider && route.model === resolved.model)

  const poolFor = (pools, resolved) => {
    if (resolved === null || typeof resolved !== 'object') return undefined
    if (typeof resolved.provider !== 'string' || typeof resolved.model !== 'string') return undefined
    return pools.find((pool) => routeFor(pool, resolved) !== undefined)
  }

  /**
   * `agent/request-error` carries the provider but not the model, so remember
   * the last pool route a request resolved to and only fail over when the
   * failing provider still matches it. Falls back to a unique provider match
   * when no request was observed yet (for example after a restart).
   */
  let lastPoolRoute

  /** Ring order after the current route, skipping cooling providers. */
  const nextHealthyRoute = (pool, current) => {
    const currentIndex = pool.routes.findIndex(
      (route) => route.provider === current.provider && route.model === current.model,
    )
    if (currentIndex < 0) return undefined
    for (let step = 1; step < pool.routes.length; step += 1) {
      const candidate = pool.routes[(currentIndex + step) % pool.routes.length]
      if (candidate.provider === current.provider) continue
      if (isCooling(candidate.provider)) continue
      if (isExhausted(candidate.provider)) continue
      return candidate
    }
    return undefined
  }

  /**
   * The first pool route that serves the requested model and is healthy.
   * With `preferFirst` on, the pool order is the preference order: the small
   * plan is used first, the big one only takes over once the small one ran
   * out and comes back when its quota window resets.
   * @param {{ routes: Array<{ provider: string, model: string }> }} pool
   * @param {{ model: string }} resolved
   * @returns {{ provider: string, model: string } | undefined}
   */
  const preferredRoute = (pool, resolved) => {
    for (const candidate of pool.routes) {
      if (candidate.model !== resolved.model) continue
      if (isCooling(candidate.provider)) continue
      if (isExhausted(candidate.provider)) continue
      return { provider: candidate.provider, model: candidate.model }
    }
    return undefined
  }

  /**
   * @param {{ turn?: unknown, step?: unknown }} _payload
   * @param {() => Promise<any>} next
   */
  async function onRequest(_payload, next) {
    const resolved = await next()
    try {
      const { pools, preferFirst } = effective()
      if (pools.length === 0) return resolved
      const pool = poolFor(pools, resolved)
      const current = pool === undefined
        ? undefined
        : { provider: String(resolved.provider), model: String(resolved.model) }
      if (pool === undefined || current === undefined) {
        lastPoolRoute = undefined
        return resolved
      }
      lastPoolRoute = { ...current, pool }
      const exhausted = isExhausted(current.provider)
      let effectiveRoute = current
      let poolOrder = false
      if (preferFirst) {
        // The pool order is the preference order: take the first healthy route
        // of the pool, even when the resolved route is healthy as well.
        const preferred = preferredRoute(pool, resolved)
        if (preferred !== undefined) {
          effectiveRoute = preferred
          poolOrder = true
        } else if (isCooling(current.provider) || exhausted) {
          effectiveRoute = nextHealthyRoute(pool, current) ?? current
        }
      } else if (isCooling(current.provider) || exhausted) {
        effectiveRoute = nextHealthyRoute(pool, current) ?? current
      }
      noteActiveRoute(effectiveRoute.provider, effectiveRoute.model)
      const unchanged = effectiveRoute.provider === current.provider
        && effectiveRoute.model === current.model
      if (unchanged) return resolved
      if (poolOrder) {
        ctx.logger.info(
          `llm-route-pool: pool order prefers "${routeLabel(effectiveRoute)}"; `
            + `routing through it instead of "${routeLabel(current)}"`,
        )
      } else {
        ctx.logger.info(
          exhausted
            ? `llm-route-pool: route "${routeLabel(current)}" has an exhausted quota; `
              + `routing through "${routeLabel(effectiveRoute)}"`
            : `llm-route-pool: route "${routeLabel(current)}" is cooling down; `
              + `routing through "${routeLabel(effectiveRoute)}"`,
        )
      }
      return { ...resolved, provider: effectiveRoute.provider, model: effectiveRoute.model }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`llm-route-pool: request rewrite skipped: ${message}`)
      return resolved
    }
  }

  /**
   * @param {{ agent?: unknown, turn?: unknown, provider?: unknown, failure?: unknown }} payload
   * @param {() => Promise<unknown>} next
   */
  async function onRequestError(payload, next) {
    try {
      const failure = payload?.failure
      const { pools, cooldownMs, maxSwitchesPerTurn, codes: activeCodes } = effective()
      if (!matchesFailure(failure, { codes: activeCodes, regexes })) return next()
      const provider = readString(payload?.provider)
      if (provider === undefined) return next()

      if (pools.length === 0) return next()

      // Identify the pool route that failed. The payload has no model, so use
      // the route the last request resolved to when its provider matches;
      // otherwise accept an unambiguous provider match.
      let route
      let pool
      if (lastPoolRoute !== undefined && lastPoolRoute.provider === provider) {
        route = { provider, model: lastPoolRoute.model }
        pool = lastPoolRoute.pool
      } else {
        const candidates = pools.filter((entry) => entry.routes.some((entryRoute) => entryRoute.provider === provider))
        if (candidates.length !== 1) return next()
        pool = candidates[0]
        route = pool.routes.find((entryRoute) => entryRoute.provider === provider)
      }
      if (route === undefined || pool === undefined) return next()

      const detail = describeFailure(failure)
      const failureCode = typeof failure?.code === 'string' ? failure.code : ''
      noteFailure(provider, detail)

      const target = nextHealthyRoute(pool, route)
      if (target === undefined) {
        ctx.logger.warn(
          `llm-route-pool: route "${routeLabel(route)}" failed with ${detail} and every other route in its pool is `
            + 'cooling down; leaving the turn to fail',
        )
        return next()
      }
      if (!budget.take(payload?.agent, payload?.turn, maxSwitchesPerTurn)) return next()

      const baseWaitMs = pool.cooldownMs ?? cooldownMs
      // A 429 rate limit resets within seconds/minutes: cool the provider only
      // briefly instead of removing it for the whole quota cooldown.
      let waitMs = failureCode === 'RATE_LIMIT' ? Math.min(baseWaitMs, 60_000) : baseWaitMs
      let quotaDriven = false
      if (failureCode !== 'RATE_LIMIT') {
        // A quota failure means the plan window is spent. The quota reader
        // knows when the vendor resets it (hours for a 5-hour token plan), so
        // follow that instead of the fixed cooldown: the provider stays out
        // of rotation until its quota really is back.
        const suggested = await quotaCooldown(provider)
        if (suggested !== undefined && suggested > waitMs) {
          waitMs = suggested
          quotaDriven = true
        }
      }
      if (!dryRun) {
        coolingUntil.set(provider, Date.now() + waitMs)
        noteCooling(provider, Date.now() + waitMs)
      }
      noteSwitch(routeLabel(route), routeLabel(target), detail)
      lastPoolRoute = undefined
      ctx.logger.warn(
        `llm-route-pool: route "${routeLabel(route)}" failed with ${detail}; cooling provider "${provider}" for `
          + `${humanDuration(waitMs)}${quotaDriven ? '（按额度窗口剩余时间）' : ''}, `
          + `failing over to "${routeLabel(target)}"${dryRun ? ' [dry run]' : ''}`,
      )
      return { kind: 'retry' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`llm-route-pool: failover skipped: ${message}`)
      return next()
    }
  }

  // prepend: the rewrite must run after every later listener (notably the
  // host's model selection) has had its say about provider/model.
  ctx.effect(() => ctx.on('agent/request', onRequest, { prepend: true }))
  ctx.effect(() => ctx.on('agent/request-error', onRequestError))
}
