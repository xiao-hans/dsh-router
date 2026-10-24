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
      'get_goal', 'create_goal', 'update_goal',
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
      'acp_cache', 'acp_read_original_image',
    ],
  },
]

/** Tools available at every stage (routing control, context management, delivery). */
export const ALWAYS = [
  'ask_user_question', 'present', 'working_directory',
  'compress', 'acp_status', 'decompress', 'search_context',
  'router_status', 'router_mode', 'router_advance',
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
 */
export function advanceStage(stage, toolNames, text) {
  const names = Array.isArray(toolNames) ? toolNames : []
  const words = typeof text === 'string' ? text : ''
  let s = stage
  if (s === 0 && (names.includes('todo_write') || /开始开发|进入开发|着手实现|开始实现|write the code/i.test(words))) s = 1
  if (s === 1 && names.some((name) => name === 'write' || name === 'edit')) s = 2
  if (s === 2 && (names.includes('ops_bash') || names.includes('pwsh') || /完成|finished|done|验证/i.test(words))) s = 3
  return Math.min(s, STAGES.length - 1)
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

/** Render the standing stage declaration for the system prompt. */
export function stageText(stage, unlocked) {
  const safeStage = Math.min(Math.max(Number(stage) || 0, 0), STAGES.length - 1)
  const current = STAGES[safeStage]
  const next = STAGES[safeStage + 1]
  const names = Array.isArray(unlocked) ? unlocked : []
  const lines = [
    `Tool disclosure phase: **${current.name}** (${safeStage + 1}/${STAGES.length}).`,
    `Unlocked now: ${names.length > 0 ? names.join(', ') : '(routing tools only)'}.`,
  ]
  if (next !== undefined) {
    lines.push(
      `Next phase "${next.name}" unlocks: ${next.tools.join(', ')}.`,
      `Advance by finishing this phase — or call router_advance when the phase goal is met.`,
    )
  } else {
    lines.push('All tools are unlocked; the full registry is available.')
  }
  return lines.join('\n')
}

/** Tool result text for the status report. */
export function describeMode(mode, modelId) {
  const band = bandFor(mode)
  const shown = mode === MODE_WEAK ? 'weak (self-routing)' : `${band} (${clamp01(mode)})`
  return `${shown}${isFlashModel(modelId) ? ', flash persona' : ''}`
}
