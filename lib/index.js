/**
 * dsh-router — behavior routing + progressive tool disclosure for DSH.
 *
 * Two capabilities, both re-derived from durable session state so a resumed
 * session lands on the same stage it left:
 *
 *   1. Behavior mode (spec / mixed / react / weak) selects the persona text and
 *      is applied by rewriting the assembled system prompt.
 *   2. Phase gating reveals tools a phase at a time and restricts the rest, so
 *      the model cannot skip straight to shell access before it has aligned.
 *
 * Everything is read from the session's own event log; nothing is persisted
 * separately, so editing history or resuming cannot desynchronize the state.
 */

import {
  ALWAYS,
  MODE_WEAK,
  STAGES,
  advanceStage,
  allowListFor,
  bandFor,
  classifyTask,
  describeMode,
  deriveStage,
  firstUserTask,
  parseMode,
  personaFor,
  stageText,
} from './core.js'

export const name = 'dsh-router'

/** Both services must exist before apply() runs. */
export const inject = ['systemPrompt', 'tools']

/** Per-agent routing state, keyed by the agent object itself. */
const states = new WeakMap()

function stateOf(agent) {
  let state = states.get(agent)
  if (state === undefined) {
    state = { dispose: null, key: '', override: undefined, stage: -1 }
    states.set(agent, state)
  }
  return state
}

/* ------------------------------------------------------------------ session */

/**
 * Read a session's events through whichever accessor this host exposes.
 * `snapshotEvents()` is authoritative; `events` is the fallback shape.
 */
function sessionEvents(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return []
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  }
  if (Array.isArray(session.events)) return session.events
  return []
}

/** True for a delegated child agent, which routes with its parent's settings. */
function isSubagent(agent) {
  try {
    return agent?.session?.header?.parentSession !== undefined
  } catch {
    return false
  }
}

/* --------------------------------------------------------------------- mode */

/**
 * Resolve the effective behavior mode.
 *
 * Order of precedence: an explicit per-session override, then the configured
 * mode, then automatic classification of the first user task.
 */
function modeFor(state, config, events) {
  if (state.override !== undefined) return state.override
  const configured = parseMode(config?.mode ?? 'auto')
  if (configured === null || configured === 'auto') return classifyTask(firstUserTask(events))
  return configured
}

/** Best-effort model id for the persona variant (Flash vs Pro wording). */
function modelIdOf(assembly) {
  const variables = assembly?.variables
  if (variables === null || typeof variables !== 'object') return undefined
  for (const key of ['model', 'modelId', 'model_id', 'route']) {
    const value = variables[key]
    if (typeof value === 'string' && value !== '') return value
    if (value !== null && typeof value === 'object' && typeof value.model === 'string') return value.model
  }
  return undefined
}

/* ------------------------------------------------------------------- prompt */

/** Replace every persona-ish section with one persona section at the end. */
function withPersona(sections, text) {
  const kept = (Array.isArray(sections) ? sections : [])
    .filter((section) => !/persona/i.test(String(section?.name ?? '')))
    .filter((section) => typeof section?.text === 'string' && section.text.length > 0)
  return [...kept, { name: 'router-persona', text }]
}

/** Append (or replace) the standing phase declaration. */
function withStage(sections, text) {
  const kept = sections.filter((section) => section?.name !== 'router-stage')
  return [...kept, { name: 'router-stage', text }]
}

/* -------------------------------------------------------------------- tools */

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function statusReport(state, config, events) {
  const mode = modeFor(state, config, events)
  const stage = deriveStage(events)
  const unlocked = allowListFor(stage, null)
  return [
    `mode: ${describeMode(mode, undefined)} (band: ${bandFor(mode)})`,
    `phase: ${stage + 1}/${STAGES.length} — ${STAGES[stage].name}`,
    `unlocked: ${unlocked === null ? '(all tools)' : unlocked.join(', ')}`,
  ].join('\n')
}

/** Draw the route tools. Registered once, in the global tool layer. */
function registerTools(ctx, config) {
  ctx.tools.register({
    name: 'router_status',
    description:
      'Report the current behavior mode (spec/mixed/react/weak), the tool-disclosure phase, '
      + 'and which tools are unlocked right now.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput,
    async execute(_args, exec) {
      const events = sessionEvents(exec?.agent)
      return { text: statusReport(stateOf(exec?.agent), config, events) }
    },
  })

  ctx.tools.register({
    name: 'router_mode',
    description:
      'Set the behavior mode for this session. Accepts auto, weak, spec, mixed, react, '
      + 'or a number 0-1 / 0-100. Use when the user asks to change how you work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          description: 'auto | weak | spec | mixed | react | 0-1 | 0-100',
        },
      },
      required: ['mode'],
    },
    output: textOutput,
    async execute(args, exec) {
      const parsed = parseMode(args?.mode)
      if (parsed === null) return { text: `Unrecognized mode "${String(args?.mode)}".` }
      const state = stateOf(exec?.agent)
      state.override = parsed === 'auto' ? undefined : parsed
      return { text: `mode set to ${describeMode(modeFor(state, config, sessionEvents(exec?.agent)), undefined)}` }
    },
  })

  ctx.tools.register({
    name: 'router_advance',
    description:
      'Advance the tool-disclosure phase once the current phase goal is met, unlocking the '
      + 'next set of tools early instead of waiting for the automatic signal.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput,
    async execute(_args, exec) {
      const agent = exec?.agent
      const state = stateOf(agent)
      const events = sessionEvents(agent)
      const current = deriveStage(events)
      const next = Math.min(current + 1, STAGES.length - 1)
      if (next === current) return { text: `Already at the final phase: ${STAGES[current].name}.` }
      const marker = STAGES[next].tools[0]
      // A real tool call is the only durable promotion signal, so record the
      // advance by marking the state and letting the next pre-step recompute.
      state.stage = Math.max(state.stage, next)
      await applyStageRestrict(ctx, agent, next)
      return {
        text: `phase → ${next + 1}/${STAGES.length} — ${STAGES[next].name} (unlocked via ${marker})`,
      }
    },
  })
}

/* --------------------------------------------------------------- disclosure */

/**
 * Apply (or lift) the tool restriction for a phase. Lifting at the final phase
 * is what makes this a disclosure aid rather than a permanent cage.
 *
 * `tools.restrict()` rejects any name it does not recognise and reports the
 * names it does accept, so an unknown name is recovered from that report and
 * narrowed once instead of disabling the phase. A host that rejects the retry
 * too leaves the agent unrestricted, which is the safe direction to fail.
 */
async function applyStageRestrict(ctx, agent, stage) {
  if (agent === undefined || agent === null) return
  const state = stateOf(agent)
  const allow = allowListFor(stage, null)
  if (allow === null) {
    if (state.dispose !== null) {
      try { state.dispose() } catch { /* already lifted */ }
      state.dispose = null
      state.key = ''
    }
    return
  }

  const install = (names) => {
    const key = [...names].sort().join(',')
    if (key === state.key && state.dispose !== null) return true
    if (state.dispose !== null) {
      try { state.dispose() } catch { /* superseded */ }
      state.dispose = null
      state.key = ''
    }
    try {
      state.dispose = agent.ctx.tools.restrict({ allow: names })
      state.key = key
      return true
    } catch {
      return false
    }
  }

  if (install(allow)) return

  const known = reportedKnownTools(() => {
    agent.ctx.tools.restrict({ allow: [PROBE_NAME] })
  })
  if (known === null) {
    ctx.logger?.warn?.('dsh-router: tool restriction rejected and the known-tool list was unreadable; this phase is ungated')
    return
  }
  const narrowed = allow.filter((toolName) => known.has(toolName))
  if (narrowed.length === 0 || !install(narrowed)) {
    ctx.logger?.warn?.('dsh-router: no phase tool matched the host registry; this phase is ungated')
  }
}

const PROBE_NAME = 'dsh-router-probe'

/** Every global tool name the host will accept, read from its own rejection. */
function reportedKnownTools(probe) {
  try {
    probe()
  } catch (error) {
    const message = String(error?.message ?? '')
    const marker = message.indexOf('known global tools:')
    if (marker < 0) return null
    const listed = message.slice(marker + 'known global tools:'.length).trim()
    if (listed === '' || listed === '(none)') return null
    const names = new Set()
    for (const part of listed.split(',')) {
      const name = part.trim().replace(/^"|"$/g, '')
      if (name !== '') names.add(name)
    }
    return names.size > 0 ? names : null
  }
  return null
}

/* -------------------------------------------------------------------- apply */

export function apply(ctx, config = {}) {
  registerTools(ctx, config)

  ctx.on('agent/created', ({ agent }) => {
    if (agent === undefined || agent === null) return
    states.set(agent, { dispose: null, key: '', override: undefined, stage: -1 })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state === undefined) return
    if (state.dispose !== null) {
      try { state.dispose() } catch { /* fiber already tearing down */ }
    }
    states.delete(agent)
  })

  // Persona + phase declaration. Runs after every other assembly listener so
  // the final section list is the one the model actually receives.
  ctx.on('system-prompt/assemble', async (...args) => {
    const assembly = args[0]
    const context = args[1]
    const next = args.length >= 3 ? args[args.length - 1] : undefined
    const resolved = typeof next === 'function' ? await next() : assembly
    const agent = context?.agent
    if (agent === undefined || agent === null || isSubagent(agent)) return resolved
    const events = sessionEvents(agent)
    const state = stateOf(agent)
    const mode = modeFor(state, config, events)
    const stage = deriveStage(events)
    const unlocked = allowListFor(stage, null)
    let sections = withPersona(resolved.sections, personaFor(mode, modelIdOf(resolved)))
    sections = withStage(sections, stageText(stage, unlocked ?? []))
    return { ...resolved, sections }
  }, { prepend: true })

  // Phase gating. Derived from the log first, then reconciled with any manual
  // advance recorded through router_advance. `phases: false` keeps the persona
  // rewriting and leaves the tool registry untouched.
  if (config?.phases === false) return

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = typeof next === 'function' ? await next() : payload
    const agent = payload?.agent
    if (agent === undefined || agent === null || isSubagent(agent)) return decision
    const state = stateOf(agent)
    const derived = deriveStage(sessionEvents(agent))
    const stage = Math.min(Math.max(derived, state.stage), STAGES.length - 1)
    state.stage = stage
    await applyStageRestrict(ctx, agent, stage)
    return decision
  }, { prepend: true })
}

/** Re-exported so a test or another plugin can reason about the same tables. */
export {
  ALWAYS,
  MODE_WEAK,
  STAGES,
  advanceStage,
  allowListFor,
  bandFor,
  classifyTask,
  deriveStage,
  firstUserTask,
  parseMode,
  personaFor,
  stageText,
}
