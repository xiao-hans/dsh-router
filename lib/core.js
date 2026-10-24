/**
 * dsh-router/core — pure routing logic, zero dependencies.
 *
 * Behavioral model inherited from the upstream router-standard work
 * (21-point × n=2 sweep on v4-pro): behavior along the react↔spec axis
 * collapses into THREE stable regions plus an internal-routing mode:
 *
 *   spec   [0, 0.15]   plan-first, collective, read-first tools
 *   mixed  [0.2, 0.45] transition band — unstable, opt-in only
 *   react  [0.5, 1.0]  doer, produce-verify-fix, write-first tools
 *   weak   —           the model classifies the task itself per turn
 *
 * Nothing here touches the host: every function is total, side-effect free,
 * and safe to call with malformed input.
 */

export const MODE_SPEC = 0
export const MODE_MIXED = 0.3
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

const SPEC_PERSONA =
  'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session '
  + 'and continue from where you left off; do not repeat completed steps. '
  + 'Do not run environment checks (echo, whoami, uname, node --version, date) '
  + 'or exhaustive grep/glob scans.\n'
  + 'Think deeply first, then produce.'

export const COMPLEX_RE =
  /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

const REACT_RE =
  /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE =
  /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

export function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** True when the task reads as complex (long, or architecturally worded). */
export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Quantize a mode onto one of the four measured behavior bands. */
export function bandOf(mode) {
  if (mode === MODE_WEAK || mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

/** Human-readable band name (the transition band reports as "mixed"). */
export function bandFor(mode) {
  const band = bandOf(mode)
  return band === 'transition' ? 'mixed' : band
}

/** Persona text for a mode. The weak band picks the model-specific variant. */
export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    default: return REACT_PERSONA
  }
}

function countHits(regex, text) {
  const matches = String(text ?? '').match(regex)
  return matches === null ? 0 : matches.length
}

/**
 * Classify a task text into a mode. Clear keyword evidence picks a stable
 * band (1 react / 0 spec); ambiguous or unmatched text returns 'weak', where
 * the model decides per task.
 */
export function classifyTask(text) {
  const source = typeof text === 'string' ? text : ''
  const react = countHits(REACT_RE, source)
  const spec = countHits(SPEC_RE, source)
  if (react > spec) return MODE_REACT
  if (spec > react) return MODE_SPEC
  return MODE_WEAK
}

/**
 * Flatten one message's content into plain text. Defensive about the two
 * shapes seen in practice: `{ subject }` and `{ message: { subject } }`.
 */
export function extractText(data) {
  if (data === undefined || data === null) return ''
  const payload =
    typeof data === 'object' && data !== null
      && typeof data.message === 'object' && data.message !== null
      ? data.message
      : data
  const content = payload?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') return block.text
      return ''
    })
    .join(' ')
}

/** Parse a user- or model-supplied mode token. `null` when unparseable. */
export function parseMode(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === '') return null
  if (t === 'auto') return 'auto'
  if (t === 'weak' || t === 'router' || t === 'self') return MODE_WEAK
  if (t === 'spec' || t === 'spec-lean' || t === 'plan') return MODE_SPEC
  if (t === 'balanced' || t === 'mixed') return MODE_MIXED
  if (t === 'react' || t === 'react-lean' || t === 'build') return MODE_REACT
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return t.includes('.') ? clamp01(n) : clamp01(n / 100)
}

/** Phase table. `host` tools (not listed here) unlock when the last stage is reached. */
export const STAGES = [
  {
    name: '了解 / 对齐',
    tools: [
      'read', 'ops_read_files', 'glob', 'grep', 'read_image',
      'web_search', 'research', 'advanced_search', 'multi_search',
      'platform_search', 'domain_search', 'video_search', 'web_fetch', 'cache_search',
      'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
      'cordis_inspect_list', 'cordis_inspect_query', 'skill',
    ],
  },
  {
    name: '拟合方案',
    tools: [
      'todo_write', 'exit_plan_mode',
      'subagent', 'subagent_fork', 'workflow',
      'list_agents', 'send_message', 'interrupt_agent',
      'schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete',
    ],
  },
  {
    name: '开发',
    tools: ['write', 'edit', 'lint_fix', 'lint_repair'],
  },
  {
    name: '验证 / 交付',
    tools: [
      'ops_bash', 'pwsh',
      'job_list', 'job_output', 'job_kill',
      'quality_verify', 'quality_receipt',
      'lint_diagnostics', 'lint_status', 'lint_workspace_errors',
    ],
  },
]

/** Routing/meta tools: registered by this plugin, callable at every stage. */
export const META_TOOLS = [
  'router_status', 'router_mode', 'router_advance',
  'router_begin', 'tools_catalog', 'tools_help', 'delivery_check',
]

/** Goal tools stay reachable at every stage: a goal outlives a phase. */
export const META_GOAL = ['get_goal', 'create_goal', 'update_goal']

/**
 * Tools available at every stage.
 *
 * Context management is here on purpose: an agent that cannot compress or ask a
 * question during alignment is an agent that guesses. Delivery metadata and the
 * goal tools likewise survive every phase.
 */
export const ALWAYS = [
  ...META_TOOLS,
  ...META_GOAL,
  'ask_user_question', 'present', 'working_directory',
  'compress', 'acp_status', 'decompress', 'search_context',
  'acp_cache', 'acp_read_original_image',
]

/** Every stage name, in order. */
export function stageNames() {
  return STAGES.map((stage) => stage.name)
}

/** Stage index owning a tool, or -1 when the tool is host/unknown. */
export function stageOf(toolName) {
  return STAGES.findIndex((stage) => stage.tools.includes(toolName))
}

/**
 * Names allowed at `stage`, intersected with what actually exists. Reaching the
 * final stage lifts the restriction entirely, so `null` means "do not restrict".
 */
export function allowListFor(stage, knownNames) {
  if (stage >= STAGES.length - 1) return null
  const allowed = new Set(ALWAYS)
  for (let i = 0; i <= stage; i++) for (const name of STAGES[i].tools) allowed.add(name)
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames ?? [])
  if (known.size === 0) return [...allowed]
  return [...allowed].filter((name) => known.has(name))
}

/**
 * Advance the stage from durable session evidence: tool names in log order
 * plus the latest user text. Pure and idempotent, so replaying a session's
 * events reproduces its stage exactly (resume-safe).
 *
 * Each phase is exited by its own completion signal, never by incidental tool
 * use — calling `read` a hundred times does not finish alignment.
 */
export function advanceStage(stage, toolNames, _text) {
  const names = new Set((Array.isArray(toolNames) ? toolNames : []).map((n) => (typeof n === 'string' ? n : n?.name)).filter(Boolean))
  // One signal advances exactly one phase: `todo_write` completes alignment AND
  // is planning's own completion signal, so a cascading check would jump two.
  if (stage === 0 && (names.has('ask_user_question') || names.has('todo_write') || names.has('exit_plan_mode'))) return 1
  if (stage === 1 && (names.has('todo_write') || names.has('exit_plan_mode'))) return 2
  if (stage === 2 && names.has('delivery_check')) return 3
  return Math.min(stage, STAGES.length - 1)
}

/**
 * Derive a session's stage from its event log alone. The first user message
 * sets the mode band; every tool call since folds the stage forward.
 */
export function deriveStage(events) {
  let stage = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'tool/call') {
      const name = event.data?.name ?? event.data?.toolName ?? ''
      if (name) stage = advanceStage(stage, [name], '')
    } else if (event?.type === 'user/message') {
      if (event.data?.source?.kind === 'plugin') continue
      stage = advanceStage(stage, [], extractText(event.data))
    }
  }
  return stage
}

/** First real user task text in a session, or '' when there is none yet. */
export function firstUserTask(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind === 'plugin') continue
    const text = extractText(event.data).trim()
    if (text !== '') return text
  }
  return ''
}

/* ------------------------------------------------------------------ guidance */

/**
 * The standing declaration of how tools arrive. Injected every turn: it is the
 * one text that makes the phase visible as a mechanism instead of a surprise.
 */
export const PROGRESSIVE_DECL =
  'We hold a full tool registry, revealed in phases. tools_catalog lists the tools '
  + 'visible to me now (name + summary + phase mark + parameter names); tools_help <name> '
  + 'returns any visible tool\'s complete spec. Query on demand, then call precisely. '
  + 'Routing tools are always callable: router_status (self-check), router_mode (change '
  + 'behavior), router_advance (level up), tools_catalog / tools_help (disclosure), '
  + 'delivery_check (delivery gate). '
  + 'Tool signatures are NOT uniform: before the first use of a tool this session, read '
  + 'its parameter names via tools_catalog or tools_help — never guess. Runtime limits '
  + '(read lines, result counts, output bytes) are enforced at call time. '
  + 'A tool the current phase has not unlocked is absent, not broken: finish the phase, '
  + 'then call router_advance. '
  + 'Do not print a whole write/edit result back — take path/operation and inspect the '
  + 'changed lines with grep/read instead. Verify your own work by running it; a claim '
  + 'without a run is not verification.'

/**
 * Standing proactivity instruction. Replaces the upstream "pressure valve" with a
 * habit: act on reversible work, ask only about what belongs to the user.
 */
export const PRESSURE_GUIDE =
  'Proactivity: before awaiting the user, scan for the next actionable item — unfinished '
  + 'work, unverified claims, reversible improvements, unfixed warnings. Choose one and '
  + 'act; report what you did and why. Ask only when the choice belongs to the user '
  + '(preference, budget, irreversible or destructive, external approval). Two or more '
  + 'dependent steps: think step by step, but do not stop for permission on reversible '
  + 'work. Depth is our call: a small result gets a small thought, a consequential fork '
  + 'gets full reasoning.'

/** Per-phase guidance: what this phase is for and what counts as done. */
export const STAGE_GUIDES = [
  'Phase: understanding. Unlocked: this stage only — read/glob/grep/web_search/ask_user_question. '
  + 'Ground first: read and ask before concluding. Do this stage properly — do not settle on '
  + 'the first obvious reading. Break the request into its dimensions (what the user wants, '
  + 'how it should behave, what "good" looks like) and surface the genuinely ambiguous ones: '
  + '"拖拽" could mean reorder, drag-to-recategorize, or both; "瀑布流" could mean masonry '
  + 'columns or a JS grid; persistence is often unspecified. Decide each ambiguity by its '
  + 'impact: if only one interpretation is reasonable, state that assumption in one sentence '
  + 'so the user can correct it and continue; if two or more readings would materially change '
  + 'the result, ask ONE focused ask_user_question per such ambiguity, with concrete options. '
  + 'Do not under-ask (assume everything) or over-ask (interrogate trivia). A complex task '
  + 'also wants a plan. '
  + 'Complete when: you understand the task — assumptions stated, or key ambiguities answered.',

  'Phase: planning. Unlocked: todo_write / exit_plan_mode, plus subagents and goals. '
  + 'Design the approach, cover edge cases, define what "done" means, and decide acceptance '
  + 'criteria — not just a list of steps. '
  + 'Attention: keep the goal, the current decision, and the live evidence in view; sink '
  + 'settled exploration into a summary instead of carrying it all. Let superseded threads '
  + 'drop. Holding "everything might be useful" is attention leakage, not diligence. '
  + 'Isolation: when two independent concerns pollute one thread, or a sub-problem is eating '
  + 'the mainline budget, push it into a subagent or workflow so this thread stays on the '
  + 'critical path. '
  + 'Complete when: the plan is decision-complete (what to build, how it fits, what success '
  + 'looks like), recorded via todo_write or presented via exit_plan_mode. That signal '
  + 'auto-advances — do not call router_advance after it, or you skip a phase.',

  'Phase: development. Unlocked: write / edit. Re-read before re-editing. A write or edit '
  + 'result carries full before/after text — take path/operation and inspect with grep/read. '
  + 'Make the artifact real, then self-check it against the plan and the acceptance criteria. '
  + 'Avoid local optima: keep the whole artifact working while iterating. If the same detail '
  + 'resists for several rounds with no convergence, step back — is it blocking the '
  + 'deliverable or is it polish? Preserve a working version. Finish the rest and re-attack '
  + 'the stubborn part fresh rather than stalling everything. '
  + 'Complete when: the artifact exists and passes its own self-check — then run delivery_check.',

  'Phase: verification and delivery. Unlocked: shell, job control, image reading, quality and '
  + 'lint tools. Verify the real artifact, not a summary of it — run it, look at it, read the '
  + 'actual output. For a page, screenshot it and read the image back to confirm what it looks '
  + 'like; unreviewed visuals fail the gate. '
  + 'On a verification failure, hold a quick hypothesis audit before touching the '
  + 'implementation: name in one line which assumption you are re-checking and what NEW '
  + 'evidence you just gained. If the code is actually correct, say so and move on — do not '
  + 'manufacture a defect to justify rework. '
  + 'Gate: delivery_check must PASS with an evidence manifest. Until it does, do not report '
  + 'the task as delivered.',
]

/** Short label for a phase, used in status output. */
export function stageSummary(stage) {
  const safe = Math.min(Math.max(Number(stage) || 0, 0), STAGES.length - 1)
  return {
    stage: safe,
    name: STAGES[safe].name,
    guide: STAGE_GUIDES[safe] ?? '',
    next: STAGES[safe + 1]?.name ?? null,
  }
}

/**
 * Render the standing stage declaration for the system prompt.
 *
 * Three sources of truth have to agree here: the phase table, the restriction
 * actually installed, and what the model is told. `unlocked === null` means no
 * restriction is installed, and the text must say exactly that — describing a
 * partial list at the unrestricted phase contradicts the same paragraph.
 */
export function stageText(stage, unlocked) {
  const safeStage = Math.min(Math.max(Number(stage) || 0, 0), STAGES.length - 1)
  const current = STAGES[safeStage]
  const next = STAGES[safeStage + 1]
  const names = Array.isArray(unlocked) ? unlocked : []
  const lines = [`Tool disclosure phase: **${current.name}** (${safeStage + 1}/${STAGES.length}).`]
  const guide = STAGE_GUIDES[safeStage]
  if (guide !== undefined) lines.push(guide)
  if (next === undefined) {
    // The final phase installs no restriction, so naming a partial list here
    // would contradict the next line and mislead the model about its reach.
    lines.push('Unlocked now: every tool in the registry.')
    lines.push('All tools are unlocked; the full registry is available.')
    return lines.join('\n')
  }
  lines.push(`Unlocked now: ${names.length > 0 ? names.join(', ') : '(routing tools only)'}.`)
  lines.push(
    `Next phase "${next.name}" unlocks: ${[...next.tools, ...META_TOOLS.slice(3)].join(', ')}.`,
    'Advance by completing this phase, then call router_advance.',
  )
  return lines.join('\n')
}

/** Tool result text for the status report. */
export function describeMode(mode, modelId) {
  const band = bandFor(mode)
  const shown = mode === MODE_WEAK ? 'weak (self-routing)' : `${band} (${clamp01(mode)})`
  return `${shown}${isFlashModel(modelId) ? ', flash persona' : ''}`
}

/* -------------------------------------------------------------- delivery gate */

/** Evidence kinds the delivery gate accepts. */
export const EVIDENCE_KINDS = ['file', 'page', 'image', 'run', 'test', 'text', 'external', 'numeric']

/**
 * Validate an evidence manifest without touching the filesystem.
 *
 * Returns `{ failures, hints }`: `failures` block delivery, `hints` do not. The
 * filesystem half (does the target exist and is it non-empty) belongs to the
 * caller, which reports it through `exists` — a function the test suite can
 * stub and the host binds to a real stat.
 */
export function validateEvidence(items, options = {}) {
  const { url } = options
  const exists = typeof options.exists === 'function' ? options.exists : () => true
  const failures = []
  const hints = []

  if (!Array.isArray(items) || items.length === 0) {
    failures.push('missing evidence items — provide at least one {label, kind, target?, result?, reviewed?}')
    return { failures, hints }
  }

  for (const item of items) {
    const label = String(item?.label ?? '').trim()
    const kind = String(item?.kind ?? '').trim()
    if (label === '') { failures.push('empty label'); continue }
    if (!EVIDENCE_KINDS.includes(kind)) { failures.push(`bad kind: ${kind}`); continue }

    if (kind === 'run' || kind === 'text') {
      if (String(item?.result ?? '').trim() === '') failures.push(`${kind} evidence without result`)
      continue
    }
    if (kind === 'numeric') {
      const result = String(item?.result ?? '').trim()
      if (result === '' || !/^-?[\d.eE+-]+$/.test(result)) {
        failures.push('numeric evidence needs a numeric result (e.g. minr=2.07)')
      }
      continue
    }
    if (kind === 'external') {
      const hasTarget = String(item?.target ?? '').trim() !== ''
      const hasResult = String(item?.result ?? '').trim() !== ''
      if (!hasTarget && !hasResult) failures.push('external evidence needs target or result')
      if (hasTarget && !exists(String(item.target).trim())) failures.push(`external target missing: ${item.target}`)
      continue
    }

    const target = String(item?.target ?? '').trim()
    if (target === '') { failures.push(`${kind} evidence without target`); continue }
    if (!exists(target)) failures.push(`target missing or empty: ${target}`)
    if ((kind === 'page' || kind === 'image') && item?.reviewed !== true) {
      failures.push(`visual not reviewed: ${label}`)
    }
  }

  if (url !== undefined && url !== null && String(url).trim() !== '') {
    const reviewed = items.some((item) => ['page', 'image', 'external'].includes(String(item?.kind)) && item?.reviewed === true)
    if (!reviewed) failures.push('page deliverable needs at least one reviewed visual evidence (page/image/external)')
  }

  if (items.every((item) => String(item?.kind) !== 'numeric')) {
    hints.push(
      'if this deliverable has a measurable invariant (a conserved quantity, a count, a radius, '
      + 'compile success), add a numeric evidence item (kind=numeric, result=<number>) so '
      + '"I think it works" becomes "I verified it". Non-blocking.',
    )
  }

  return { failures, hints }
}
