/**
 * A tiny Cordis-like context for unit tests.
 *
 * It implements only what the keypool plugins touch:
 *  - `ctx.on(event, listener, options?)` with waterfall `next()` composition
 *    and `{ prepend: true }` ordering, returning a disposer;
 *  - `ctx.effect(fn)` collecting disposers;
 *  - `ctx.get(serviceName)` for service access;
 *  - `ctx.logger` recording calls.
 *
 * The real harness composes listeners the same way: first registered runs
 * first, each listener decides whether to delegate with `await next()` or to
 * return its own decision, and `prepend` puts a listener in front of already
 * registered ones.
 */

/**
 * @param {{ services?: Record<string, unknown>, logger?: object }} [options]
 */
export function createFakeCtx(options = {}) {
  /** @type {Map<string, Array<{ listener: Function, prepend: boolean }>>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const disposers = []
  /** @type {Array<{ level: string, args: unknown[] }>} */
  const logs = []

  const defaultLogger = {
    debug: (...args) => logs.push({ level: 'debug', args }),
    info: (...args) => logs.push({ level: 'info', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
    error: (...args) => logs.push({ level: 'error', args }),
  }

  const services = { ...(options.services ?? {}) }

  const ctx = {
    logger: options.logger ?? defaultLogger,
    /** @param {string} name */
    get(name) {
      return services[name]
    },
    /** Test helper: expose the service table for late binding. */
    _services: services,
    /**
     * @param {string} event
     * @param {Function} listener
     * @param {{ prepend?: boolean }} [opts]
     */
    on(event, listener, opts = {}) {
      const entries = listeners.get(event) ?? []
      const entry = { listener, prepend: opts.prepend === true }
      if (entry.prepend) entries.unshift(entry)
      else entries.push(entry)
      listeners.set(event, entries)
      const dispose = () => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    /** @param {Function} fn */
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    /** No-op used by plugins that declare optional injections. */
    inject() {},
  }

  /**
   * Dispatch one event through the waterfall.
   * @param {string} event
   * @param {unknown} payload
   * @param {(payload: unknown) => unknown} [terminal]
   */
  async function dispatch(event, payload, terminal = async () => undefined) {
    const entries = listeners.get(event) ?? []
    const call = async (index, current) => {
      if (index >= entries.length) return terminal(current)
      const listener = entries[index].listener
      let called = false
      const next = async (replacement) => {
        called = true
        return call(index + 1, arguments.length === 1 ? replacement : current)
      }
      const result = await listener(current, next)
      if (result !== undefined) return result
      return called ? undefined : terminal(current)
    }
    return call(0, payload)
  }

  /** Dispose everything a plugin registered (simulates plugin unload). */
  function disposeAll() {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // disposers are best-effort in tests
      }
    }
    listeners.clear()
  }

  return { ctx, dispatch, disposeAll, logs, listeners }
}

/**
 * In-memory stand-in for the `credentials` service.
 * `resolve` returns `{ value, source }` (or undefined) exactly like the host.
 * @param {Record<string, string>} initial
 */
export function createFakeCredentials(initial = {}) {
  /** @type {Map<string, string>} */
  const store = new Map(Object.entries(initial))
  /** @type {Array<{ ref: string, value: string }>} */
  const writes = []
  /** @type {string[]} */
  const resolves = []

  return {
    writes,
    resolves,
    async resolve(ref) {
      resolves.push(ref)
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'store' }
    },
    async describe(ref) {
      return { configured: store.has(ref), source: 'store', writable: true }
    },
    async set(ref, value) {
      writes.push({ ref, value })
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
    /** Current values, for assertions. */
    snapshot() {
      return Object.fromEntries(store.entries())
    },
  }
}

/** Build an `agent/request-error` payload with the fields the host provides. */
export function requestErrorPayload(overrides = {}) {
  return {
    agent: { id: 'agent-1' },
    turn: 1,
    step: 1,
    provider: 'provider-a',
    failure: { code: 'QUOTA', message: 'quota exceeded' },
    retryPolicy: undefined,
    signal: { aborted: false },
    ...overrides,
  }
}

/** Build an `agent/request` payload. */
export function requestPayload(overrides = {}) {
  return { turn: 1, step: 1, signal: { aborted: false }, ...overrides }
}

/**
 * A minimal stand-in for the host's `Agent`.
 *
 * Since DSH 0.2.2 the provider/model of a step is fixed when the step is
 * prepared, and a plugin picks the route of the *next* step through
 * `agent.model.select()`. The stub mirrors that contract: `select()` records a
 * pending choice, `current()` answers the pending choice, then the last used
 * route, then the initial one.
 *
 * @param {{ id?: string, provider?: string, model?: string, reasoningEffort?: string }} [initial]
 */
export function createFakeAgent(initial = {}) {
  const { id = 'agent-1', ...route } = initial
  let pending
  let lastUsed
  /** @type {Array<{ provider: string, model: string, reasoningEffort?: string }>} */
  const selections = []
  return {
    id,
    /** Every selection the plugin asked for, in order. */
    selections,
    model: {
      current() {
        return pending ?? lastUsed ?? route
      },
      select(selection) {
        selections.push(selection)
        pending = { ...selection }
      },
    },
    /**
     * Test helper: the host records the route a request actually ran on.
     * A pending choice that matches it is consumed, exactly like the host's
     * model-selection projection.
     */
    usedRoute(selection) {
      lastUsed = { ...selection }
      if (pending !== undefined
        && pending.provider === selection.provider
        && pending.model === selection.model) {
        pending = undefined
      }
    },
  }
}

/** Build an `agent/inbox/inserted` payload. */
export function inboxInsertedPayload(agent, overrides = {}) {
  return {
    agent,
    message: { id: 'message-1', role: 'user', content: [], source: { kind: 'user' } },
    ...overrides,
  }
}

/** Build an `agent/pre-step` payload. */
export function preStepPayload(agent, modelSelection, overrides = {}) {
  return {
    agent,
    messages: [],
    turn: 1,
    step: 1,
    signal: { aborted: false },
    modelSelection,
    ...overrides,
  }
}
