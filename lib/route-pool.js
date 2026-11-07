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
 * Extension points (the DSH 0.2.2 route contract):
 *  - `agent/inbox/inserted` fires before the driver wakes, so the pool can
 *    pick the route of the turn's first step;
 *  - `agent/pre-step` records the route a step runs on and picks the route of
 *    the *next* step (the current step's route is already fixed there);
 *  - `agent/request-error` cools the failing provider and picks the next
 *    healthy route for the next step.
 *
 * The pool never touches `agent/request`: since DSH 0.2.2 the host rejects a
 * configuration whose provider/model differ from the route the step fixed, so
 * a route change has to go through `agent.model.select()`.
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
 * @typedef {{ provider: string, model: string }} Route a provider/model pair
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} Selection a route plus an effort
 * @typedef {{ name?: string, routes: Route[], cooldownMs?: number }} Pool one failover pool
 * @typedef {{ pool: Pool, current: Route, target: Route, reason: string }} RoutePlan what the pool wants next
 */

/** Why the pool wants to move off the current route. */
const ROUTE_REASON = {
  HEALTHY: 'healthy',
  POOL_ORDER: 'pool order',
  SPENT_QUOTA: 'spent quota',
  COOLING_DOWN: 'cooling down',
}

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

  /**
   * Log that the pool moves off the current route.
   * @param {RoutePlan} plan
   * @param {string} tail where the new route applies
   */
  const logRouteChange = (plan, tail) => {
    ctx.logger.info(
      `llm-route-pool: route "${routeLabel(plan.current)}" is ${plan.reason}; ${tail}`,
    )
  }

  /**
   * Log an operation the pool had to skip. Never throws: the host keeps going.
   * @param {string} what
   * @param {unknown} error
   */
  const logSkipped = (what, error) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`llm-route-pool: ${what}: ${message}`)
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
   * The route each agent's current step runs on.
   *
   * `agent/request-error` carries the provider but not the model, so the pool
   * remembers the route the step fixed (`agent/pre-step` reports it) and only
   * fails over when the failing provider still matches it.
   * @type {WeakMap<object, { route: Route, pool: Pool }>}
   */
  const routesByAgent = new WeakMap()

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
   * Read a route out of a selection-like object.
   * @param {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown } | undefined | null} selection
   * @returns {Selection | undefined}
   */
  const readRoute = (selection) => {
    if (selection === undefined || selection === null) return undefined
    const provider = readString(selection.provider)
    const model = readString(selection.model)
    if (provider === undefined || model === undefined) return undefined
    const reasoningEffort = readString(selection.reasoningEffort)
    return reasoningEffort === undefined
      ? { provider, model }
      : { provider, model, reasoningEffort }
  }

  /**
   * The route the agent currently has selected.
   * @param {any} agent
   * @returns {Selection | undefined}
   */
  const currentRoute = (agent) => readRoute(agent?.model?.current?.())

  /** @param {Route} a @param {Route} b */
  const sameRoute = (a, b) => a.provider === b.provider && a.model === b.model

  /**
   * The route a step fixed, as the host reports it in `agent/pre-step`.
   * @param {{ modelSelection?: unknown }} payload
   * @returns {Selection | undefined}
   */
  const stepRoute = (payload) => readRoute(payload?.modelSelection)

  /**
   * Decide which route the pool wants to use next.
   *
   * The route stays as it is while it is healthy. A provider with a spent
   * quota or a cooling provider is left behind, and with `preferFirst` the
   * first healthy route of the pool wins even when the current one is fine.
   *
   * @param {Route} current
   * @returns {RoutePlan | undefined}
   */
  const planRoute = (current) => {
    const { pools, preferFirst } = effective()
    if (pools.length === 0) return undefined
    const pool = poolFor(pools, current)
    if (pool === undefined) return undefined
    const exhausted = isExhausted(current.provider)
    if (preferFirst) {
      const preferred = preferredRoute(pool, current)
      if (preferred !== undefined && !sameRoute(preferred, current)) {
        return { pool, current, target: preferred, reason: ROUTE_REASON.POOL_ORDER }
      }
    }
    if (exhausted || isCooling(current.provider)) {
      const next = nextHealthyRoute(pool, current)
      if (next !== undefined && !sameRoute(next, current)) {
        return {
          pool,
          current,
          target: next,
          reason: exhausted ? ROUTE_REASON.SPENT_QUOTA : ROUTE_REASON.COOLING_DOWN,
        }
      }
    }
    return { pool, current, target: current, reason: ROUTE_REASON.HEALTHY }
  }

  /**
   * Select a route through the agent's model selection.
   *
   * `agent.model.select()` decides the route of the next step whose
   * preparation has not begun. The reasoning effort travels along only while
   * the model stays the same: another model may not know the effort id, and
   * the host drops the effort when the route changes.
   *
   * @param {any} agent
   * @param {{ provider: string, model: string, reasoningEffort?: string }} current
   * @param {{ provider: string, model: string }} target
   */
  const selectRoute = (agent, current, target) => {
    const selection = { provider: target.provider, model: target.model }
    if (target.model === current.model && current.reasoningEffort !== undefined) {
      selection.reasoningEffort = current.reasoningEffort
    }
    agent.model.select(selection)
    noteActiveRoute(target.provider, target.model)
  }

  /**
   * Pick the route of the turn's first step.
   *
   * `agent/inbox/inserted` fires while the driver is still asleep, so the
   * selection it makes is still pending when the turn starts: it decides the
   * route of the coming turn's first step.
   *
   * @param {{ agent?: unknown }} payload
   */
  async function onInboxInserted(payload) {
    try {
      const agent = payload?.agent
      if (agent === undefined) return
      const current = currentRoute(agent)
      if (current === undefined) return
      const plan = planRoute(current)
      if (plan === undefined) return
      if (plan.reason === ROUTE_REASON.HEALTHY) {
        noteActiveRoute(plan.current.provider, plan.current.model)
        return
      }
      selectRoute(agent, plan.current, plan.target)
      logRouteChange(plan, `routing through "${routeLabel(plan.target)}"`)
    } catch (error) {
      logSkipped('route selection skipped', error)
    }
  }

  /**
   * Keep the next step on a healthy route.
   *
   * The step's route is already fixed when `agent/pre-step` runs, so a
   * selection made here decides the route of the *next* step.
   *
   * @param {{ agent?: unknown, modelSelection?: unknown }} payload
   * @param {() => Promise<any>} next
   */
  async function onPreStep(payload, next) {
    const decision = await next()
    try {
      const agent = payload?.agent
      // The step fixed its route before the waterfall ran: remember it, so a
      // later failure can be traced back to the pool route it ran on.
      const fixed = stepRoute(payload)
      if (fixed !== undefined) {
        const { pools } = effective()
        const pool = poolFor(pools, fixed)
        if (pool === undefined) routesByAgent.delete(agent)
        else routesByAgent.set(agent, { route: fixed, pool })
      }
      const current = fixed ?? currentRoute(agent)
      if (current === undefined) return decision
      const plan = planRoute(current)
      if (plan === undefined) return decision
      if (plan.reason === ROUTE_REASON.HEALTHY) {
        noteActiveRoute(plan.current.provider, plan.current.model)
        return decision
      }
      selectRoute(agent, plan.current, plan.target)
      logRouteChange(plan, `the next step runs on "${routeLabel(plan.target)}"`)
    } catch (error) {
      logSkipped('route selection skipped', error)
    }
    return decision
  }

  /**
   * Cool the failing provider and move the pool on.
   *
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
      // the route the step fixed when its provider matches; otherwise accept
      // an unambiguous provider match.
      const agent = payload?.agent
      const remembered = agent === undefined ? undefined : routesByAgent.get(agent)
      let route
      let pool
      if (remembered !== undefined && remembered.route.provider === provider) {
        route = remembered.route
        pool = remembered.pool
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
      if (agent !== undefined) routesByAgent.delete(agent)
      ctx.logger.warn(
        `llm-route-pool: route "${routeLabel(route)}" failed with ${detail}; cooling provider "${provider}" for `
          + `${humanDuration(waitMs)}${quotaDriven ? '（按额度窗口剩余时间）' : ''}, `
          + `the next step runs on "${routeLabel(target)}"${dryRun ? ' [dry run]' : ''}`,
      )
      // The route of a step is fixed, so asking for a retry would only hit
      // the same dead route again. The pool speaks for the next step and lets
      // the failure travel downstream: the key rotator may still own the
      // retry.
      if (agent !== undefined) selectRoute(agent, route, target)
      return next()
    } catch (error) {
      logSkipped('failover skipped', error)
      return next()
    }
  }

  ctx.effect(() => ctx.on('agent/inbox/inserted', onInboxInserted))
  ctx.effect(() => ctx.on('agent/pre-step', onPreStep))
  ctx.effect(() => ctx.on('agent/request-error', onRequestError))
}
