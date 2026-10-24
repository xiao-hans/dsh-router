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

import { statSync, readFileSync } from 'node:fs'

import {
  ALWAYS,
  META_TOOLS,
  MODE_WEAK,
  PRESSURE_GUIDE,
  PROGRESSIVE_DECL,
  STAGES,
  STAGE_GUIDES,
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
  validateEvidence,
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

/** Append (or replace) a named section, keeping the list free of duplicates. */
function withSection(sections, name, text) {
  const kept = sections.filter((section) => section?.name !== name)
  return [...kept, { name, text }]
}

/* ---------------------------------------------------------------- catalog */

/**
 * The tool catalog the model may query. Read from the host registry rather than
 * a hardcoded list, so a tool added by another plugin shows up here too.
 *
 * The agent-scoped registry is preferred: `view(scope)` projects what THAT
 * scope can call, which is the question the model is asking. The plugin-level
 * registry is the fallback for a host that does not expose the scoped one.
 */
function catalogOf(ctx, agent) {
  const registries = [agent?.ctx?.tools, ctx.tools]
  for (const registry of registries) {
    if (registry === undefined || registry === null || typeof registry.view !== 'function') continue
    try {
      const view = registry.view(agent ?? undefined)
      const visible = view?.visible
      if (visible instanceof Map && visible.size > 0) {
        return [...visible.values()].map((definition) => ({
          name: definition.name,
          description: definition.description ?? '',
          parameters: definition.parameters ?? {},
        }))
      }
    } catch { /* try the next registry */ }
  }
  return []
}

/** Which phase a tool belongs to, or `meta` / `host`. */
function phaseOf(toolName) {
  const index = STAGES.findIndex((stage) => stage.tools.includes(toolName))
  if (index >= 0) return { kind: 'phase', stage: index, name: STAGES[index].name }
  if (META_TOOLS.includes(toolName)) return { kind: 'meta', stage: null, name: 'routing' }
  return { kind: 'host', stage: null, name: 'host' }
}

/** Parameter names of a JSON-schema object, for the one-line catalog row. */
function paramNames(schema) {
  const properties = schema?.properties
  if (properties === null || typeof properties !== 'object') return ''
  const names = Object.keys(properties)
  return names.length === 0 ? '' : `(${names.join(', ')})`
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

function statusReport(state, config, events, modelId) {
  const mode = modeFor(state, config, events)
  const stage = deriveStage(events)
  const unlocked = allowListFor(stage, null)
  const lines = [
    `mode: ${describeMode(mode, modelId)} (band: ${bandFor(mode)})`,
    `phase: ${stage + 1}/${STAGES.length} — ${STAGES[stage].name}`,
    `unlocked: ${unlocked === null ? '(all tools)' : `${unlocked.length} tools — ${unlocked.join(', ')}`}`,
  ]
  const next = STAGES[stage + 1]
  if (next !== undefined) lines.push(`next phase unlocks: ${next.tools.join(', ')}`)
  return lines.join('\n')
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
      const current = Math.max(deriveStage(events), state.stage)
      const next = Math.min(current + 1, STAGES.length - 1)
      if (next === current) return { text: `Already at the final phase: ${STAGES[current].name}.` }
      const marker = STAGES[next].tools[0]
      // A real tool call is the only durable promotion signal, so record the
      // advance by marking the state and letting the next pre-step recompute.
      state.stage = Math.max(state.stage, next)
      await applyStageRestrict(agent, next)
      return {
        text: `phase → ${next + 1}/${STAGES.length} — ${STAGES[next].name} (unlocked via ${marker})\n`
          + `${STAGE_GUIDES[next] ?? ''}`,
      }
    },
  })

  ctx.tools.register({
    name: 'router_begin',
    description:
      'Confirm the start of a progressive-disclosure session: reports the current phase, its '
      + 'goal, and the tools unlocked now. A new conversation already starts at phase 1, so '
      + 'this is a self-check rather than a reset.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: textOutput,
    async execute(_args, exec) {
      const agent = exec?.agent
      const events = sessionEvents(agent)
      const stage = Math.max(deriveStage(events), stateOf(agent).stage)
      const unlocked = allowListFor(stage, null)
      const lines = [
        `Bootstrap confirmed — phase ${stage + 1}/${STAGES.length} "${STAGES[stage].name}".`,
        unlocked === null
          ? 'Unlocked: the full registry (final phase).'
          : `Unlocked: ${unlocked.join(', ')}.`,
        '',
        STAGE_GUIDES[stage] ?? '',
      ]
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'tools_catalog',
    description:
      'Primary disclosure: list the tools visible in this session — name, one-line summary, '
      + 'phase mark, and parameter names. Pass `query` to highlight tools matching a substring '
      + '(detail for just those). There is no full-registry dump: only what the host makes '
      + 'visible to this session is listed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description: 'Optional substring; when given, only matching tools are described in detail.',
        },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const agent = exec?.agent
      const catalog = catalogOf(ctx, agent)
      if (catalog.length === 0) return { text: 'The host registry reported no visible tools.' }
      const query = String(args?.query ?? '').trim().toLowerCase()
      const rows = query === ''
        ? catalog
        : catalog.filter((tool) => tool.name.toLowerCase().includes(query)
          || String(tool.description).toLowerCase().includes(query))
      if (rows.length === 0) return { text: `No visible tool matches "${args?.query}".` }
      const lines = rows.map((tool) => {
        const phase = phaseOf(tool.name)
        const mark = phase.kind === 'phase' ? `[phase ${phase.stage + 1}]` : `[${phase.kind}]`
        const summary = String(tool.description).split(/(?<=\.)\s/)[0] ?? ''
        return `- ${tool.name}${paramNames(tool.parameters)} ${mark} ${summary}`
      })
      return { text: `${rows.length} visible tool(s):\n${lines.join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'tools_help',
    description:
      'Secondary disclosure: the complete spec of one visible tool — description, parameter '
      + 'names with types, which phase unlocks it. Asks about a tool the current phase has not '
      + 'unlocked is allowed; calling it is still refused until the phase advances.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Exact tool name.' },
      },
      required: ['name'],
    },
    output: textOutput,
    async execute(args, exec) {
      const wanted = String(args?.name ?? '').trim()
      if (wanted === '') return { text: 'Pass the exact tool name.' }
      const found = catalogOf(ctx, exec?.agent).find((tool) => tool.name === wanted)
      if (found === undefined) {
        return { text: `No visible tool named "${wanted}". Use tools_catalog to list what is available.` }
      }
      const phase = phaseOf(found.name)
      const where = phase.kind === 'phase'
        ? `unlocked at phase ${phase.stage + 1} — ${phase.name}`
        : phase.kind === 'meta'
          ? 'always callable (routing)'
          : 'host tool, outside the phase table'
      const properties = found.parameters?.properties ?? {}
      const required = new Set(Array.isArray(found.parameters?.required) ? found.parameters.required : [])
      const params = Object.entries(properties).map(([key, schema]) => {
        const type = String(schema?.type ?? 'any')
        const note = String(schema?.description ?? '')
        return `  - ${key}: ${type}${required.has(key) ? ' (required)' : ''}${note === '' ? '' : ` — ${note}`}`
      })
      const lines = [
        `${found.name} — ${where}`,
        String(found.description ?? ''),
        params.length === 0 ? 'Parameters: none' : `Parameters:\n${params.join('\n')}`,
      ]
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'delivery_check',
    description:
      'Delivery gate. Verifies the artifact is real before completion may be declared: the file '
      + 'exists and is non-empty, decodes as UTF-8, and the evidence manifest is valid. '
      + 'evidence.items[] entries are { label, kind, target?, result?, reviewed? } where kind is '
      + 'one of file | page | image | run | test | text | external | numeric — file/page/image/test '
      + 'need target, run/text/external need result (external also accepts target), page/image need '
      + 'reviewed:true. Pass url when the deliverable is a page: at least one reviewed visual '
      + '(page/image/external) is then required. All checks must PASS; a FAIL means fix and re-run, '
      + 'never bypass.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: 'Path to the delivered artifact.' },
        url: { type: 'string', description: 'Optional URL when the deliverable is a page.' },
        evidence: {
          type: 'object',
          description: 'Evidence manifest: { items: [{ label, kind, target?, result?, reviewed? }] }.',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  kind: { type: 'string' },
                  target: { type: 'string' },
                  result: { type: 'string' },
                  reviewed: { type: 'boolean' },
                },
                required: ['label', 'kind'],
              },
            },
          },
          required: ['items'],
        },
      },
      required: ['file', 'evidence'],
    },
    output: textOutput,
    async execute(args) {
      const file = String(args?.file ?? '').trim()
      const checks = []
      if (file === '') {
        return { text: 'delivery-check: FAIL ❌\n- [FAIL] file-path: missing file parameter' }
      }

      let size = 0
      try {
        const stat = statSync(file)
        if (!stat.isFile()) throw new Error('not a regular file')
        size = stat.size
        checks.push({ name: 'file-exists', pass: true, detail: `${file} (${size} bytes)` })
        checks.push(size > 0
          ? { name: 'file-nonempty', pass: true, detail: `${size} bytes` }
          : { name: 'file-nonempty', pass: false, detail: 'file is 0 bytes' })
      } catch (error) {
        checks.push({ name: 'file-exists', pass: false, detail: String(error?.message ?? error) })
      }

      if (size > 0) {
        try {
          const head = readFileSync(file).subarray(0, 65536)
          new TextDecoder('utf-8', { fatal: true }).decode(head)
          checks.push({ name: 'encoding-utf8', pass: true, detail: 'UTF-8 decode OK (head 64KB)' })
        } catch (error) {
          checks.push({ name: 'encoding-utf8', pass: false, detail: String(error?.message ?? error) })
        }
      }

      const verdict = validateEvidence(args?.evidence?.items, {
        url: args?.url,
        exists: (target) => {
          try {
            const stat = statSync(target)
            return stat.isFile() && stat.size > 0
          } catch {
            return false
          }
        },
      })
      checks.push({
        name: 'delivery-evidence',
        pass: verdict.failures.length === 0,
        detail: verdict.failures.length === 0
          ? `evidence accepted (${args.evidence.items.length} item(s))`
          : verdict.failures.join('; '),
      })
      for (const hint of verdict.hints) checks.push({ name: 'numeric-assertion', pass: true, detail: `hint: ${hint}` })

      const ok = checks.every((check) => check.pass)
      const lines = [`delivery-check: ${ok ? 'PASS ✅' : 'FAIL ❌'}`]
      for (const check of checks) lines.push(`- [${check.pass ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`)
      lines.push(ok
        ? 'All checks passed — the delivery gate is satisfied; completion may be reported.'
        : 'Delivery gate NOT satisfied — do not report completion; fix the failing checks and re-run delivery_check.')
      return { text: lines.join('\n') }
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
async function applyStageRestrict(agent, stage, logger) {
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
    logger?.warn?.('dsh-router: tool restriction rejected and the known-tool list was unreadable; this phase is ungated')
    return
  }
  const narrowed = allow.filter((toolName) => known.has(toolName))
  if (narrowed.length === 0 || !install(narrowed)) {
    logger?.warn?.('dsh-router: no phase tool matched the host registry; this phase is ungated')
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

  // Persona + phase declaration + progressive disclosure + proactivity. Runs
  // last so the section list here is the one the model actually receives.
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
    const stage = Math.max(deriveStage(events), state.stage)
    const unlocked = allowListFor(stage, null)
    let sections = withPersona(resolved.sections, personaFor(mode, modelIdOf(resolved)))
    sections = withSection(sections, 'router-decl', PROGRESSIVE_DECL)
    sections = withSection(sections, 'router-stage', stageText(stage, unlocked ?? []))
    sections = withSection(sections, 'router-proactivity', PRESSURE_GUIDE)
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
    await applyStageRestrict(agent, stage, ctx.logger)
    return decision
  }, { prepend: true })
}

/** Re-exported so a test or another plugin can reason about the same tables. */
export {
  ALWAYS,
  META_TOOLS,
  MODE_WEAK,
  PROGRESSIVE_DECL,
  PRESSURE_GUIDE,
  STAGES,
  STAGE_GUIDES,
  advanceStage,
  allowListFor,
  bandFor,
  classifyTask,
  deriveStage,
  firstUserTask,
  parseMode,
  personaFor,
  stageText,
  validateEvidence,
}
