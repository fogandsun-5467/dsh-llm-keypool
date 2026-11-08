/**
 * A faithful simulator of the DSH 0.2.2-rc.1 agent turn/step loop.
 *
 * The keypool plugins meet the host through three waterfalls, so a test that
 * reproduces a *turn level* failure (the whole run dies) needs the host's own
 * step semantics, not a single dispatch. This module models exactly the parts
 * of `@deepseek-ai/dsh-agent-loop` a plugin can observe. Every modelled
 * behaviour cites the host source it mirrors:
 *
 * | host behaviour | host source |
 * |---|---|
 * | the step's route is fixed before the `agent/pre-step` waterfall runs | `dsh-agent-loop/lib/index.js:671` |
 * | the `agent/pre-step` payload carries that very object as `modelSelection` | `dsh-agent-loop/lib/index.js:689` |
 * | the step keeps that object as `decision.selection` | `dsh-agent-loop/lib/index.js:706` |
 * | every attempt re-prepares the request from `decision.selection` | `dsh-agent-loop/lib/index.js:841-842`, `:990-993` |
 * | `agent/request` may not change the route of an already prepared step | `dsh-agent-loop/lib/index.js:1000-1001` |
 * | a failed attempt asks `agent/request-error`; `{ kind: 'retry' }` repeats the step | `dsh-agent-loop/lib/index.js:929-939` |
 * | any other answer ends the whole turn with that failure | `dsh-agent-loop/lib/index.js:938`, `:809-816` |
 * | the dispatcher injects `agent` into every payload | `dsh-agent/lib/types/dispatch.js:42` |
 * | `agent.model.current()` answers with a copy, `select()` stages the next step | `dsh-agent/lib/types/model-selection.js:81-92` |
 *
 * What this simulator does NOT model: tool calls, message persistence, the
 * inbox, retries driven by the provider's own retry policy, and any turn
 * behaviour after the model answered. Those do not take part in the failure
 * this suite reproduces.
 */

/** The host's error for a failed request (`LlmError`). */
export class HostLlmError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {unknown} [cause]
   */
  constructor(message, code, cause) {
    super(message, { cause })
    this.name = 'LlmError'
    this.code = code
  }
}

/**
 * A stand-in for the host's `Agent` and its `AgentModel`.
 *
 * The host answers `model.current()` with a *copy* of the recorded selection
 * (`dsh-agent/lib/types/model-selection.js:84`), so the object a step owns can
 * be changed without touching the agent's global state. `select()` only stages
 * the route of the *next* step.
 *
 * @param {{ id?: string, provider?: string, model?: string, reasoningEffort?: string }} [initial]
 */
export function createHostAgent(initial = {}) {
  const { id = 'agent-1', ...route } = initial
  /** @type {{ provider: string, model: string, reasoningEffort?: string } | undefined} */
  let pending
  /** @type {{ provider: string, model: string, reasoningEffort?: string } | undefined} */
  let lastUsed
  /** @type {Array<{ provider: string, model: string, reasoningEffort?: string }>} */
  const selections = []
  return {
    id,
    /** Every selection the plugin asked for, in order. */
    selections,
    model: {
      current() {
        const recorded = pending ?? lastUsed ?? route
        // host: dsh-agent/lib/types/model-selection.js:84 — the host answers with a copy
        return recorded === undefined ? undefined : { ...recorded }
      },
      select(selection) {
        selections.push({ ...selection })
        pending = { ...selection }
      },
    },
    /**
     * The route the host recorded for the request a step actually made.
     * A pending choice that matches it is consumed.
     * @param {{ provider: string, model: string }} selection
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

/**
 * Turn a thrown value into the failure shape the host hands to
 * `agent/request-error` (`{ message, code }`).
 * @param {unknown} error
 * @returns {{ message: string, code: string }}
 */
function normalizeFailure(error) {
  if (error !== null && typeof error === 'object'
    && typeof (/** @type {{ code?: unknown }} */ (error).code) === 'string'
    && typeof (/** @type {{ message?: unknown }} */ (error).message) === 'string') {
    return Object.freeze({
      message: /** @type {{ message: string }} */ (error).message,
      code: /** @type {{ code: string }} */ (error).code,
    })
  }
  return Object.freeze({ message: String(error), code: 'UNKNOWN' })
}

/**
 * Prepare the request of one attempt, the way the host does it.
 *
 * The seed config is a frozen copy of the step's selection, so a step that
 * changed its own selection object before the retry is honoured by the next
 * attempt — while `agent/request` still may not change the route.
 *
 * @param {{ harness: any, agent: any, turn: number, step: number, signal: any, selection: any }} options
 */
async function prepareRequest({ harness, agent, turn, step, signal, selection }) {
  // host: dsh-agent-loop/lib/index.js:990-993
  const seedConfig = Object.freeze(structuredClone({ ...selection }))
  // host: dsh-agent-loop/lib/index.js:994-998
  const proposedConfig = await harness.dispatch(
    'agent/request',
    { turn, step, signal },
    async () => seedConfig,
  )
  // host: dsh-agent-loop/lib/index.js:1000-1001
  if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model) {
    throw new Error(
      `agent "${agent.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" `
      + `after step preparation fixed "${selection.provider}/${selection.model}"; `
      + 'use agent.model.select() before step preparation',
    )
  }
  if (proposedConfig.reasoningEffort !== selection.reasoningEffort) {
    throw new Error(
      `agent "${agent.id}": agent/request proposed reasoning effort `
      + `"${proposedConfig.reasoningEffort ?? 'adapter default'}" after step preparation fixed `
      + `"${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`,
    )
  }
  return { config: proposedConfig }
}

/**
 * Run one host turn: pre-step → request attempts → turn end.
 *
 * Resolves when the model answered; rejects with a `HostLlmError` when the
 * step failed and no listener asked for a retry — the host's
 * "the turn ends with that failure" behaviour.
 *
 * @param {object} options
 * @param {{ ctx: any, dispatch: (event: string, payload: unknown, terminal?: (payload: unknown) => unknown) => Promise<any> }} options.harness
 * @param {any} options.agent agent stand-in, see `createHostAgent`
 * @param {(call: { provider: string, model: string, attempt: number, turn: number, step: number }) => Promise<unknown>} options.llm
 * @param {number} [options.turn]
 * @param {number} [options.maxAttempts]
 */
export async function runHostTurn({ harness, agent, llm, turn = 1, maxAttempts = 5 }) {
  const signal = { aborted: false }
  const step = 1
  // host: dsh-agent/lib/types/dispatch.js:42 — the dispatcher injects the
  // subject into every payload, so `payload.agent` always exists.
  const dispatch = (event, payload, terminal) =>
    harness.dispatch(event, { ...payload, agent }, terminal)
  // host: dsh-agent-loop/lib/index.js:671 — the route of the step is fixed here
  const selection = agent.model.current()
  // host: dsh-agent-loop/lib/index.js:685-697
  const decision = await dispatch(
    'agent/pre-step',
    { messages: [], turn, step, signal, modelSelection: selection },
    async () => ({ kind: 'enter', messages: [] }),
  )
  // host: dsh-agent-loop/lib/index.js:706 — the decision keeps the same selection object
  const stepSelection = decision.selection ?? selection

  // host: dsh-agent-loop/lib/index.js:841-842 — the step repeats until it succeeds
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // host: dsh-agent-loop/lib/index.js:986-1016 — every attempt re-prepares the request
    const { config } = await prepareRequest({ harness, agent, turn, step, signal, selection: stepSelection })
    try {
      const result = await llm({
        provider: config.provider,
        model: config.model,
        attempt,
        turn,
        step,
      })
      agent.usedRoute?.(config)
      return { result, attempts: attempt }
    } catch (error) {
      const failure = normalizeFailure(error)
      // host: dsh-agent-loop/lib/index.js:929-936
      const action = await dispatch(
        'agent/request-error',
        { turn, step, provider: config.provider, failure, retryPolicy: undefined, signal },
        async () => undefined,
      )
      // host: dsh-agent-loop/lib/index.js:938-939
      if (action?.kind !== 'retry') {
        throw new HostLlmError(failure.message, failure.code, failure)
      }
    }
  }
  throw new Error(`host-loop: the step ran out of attempts (${maxAttempts})`)
}
