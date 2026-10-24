/**
 * Integration test: drive apply() with a fake Cordis context and assert the
 * plugin wires its hooks and restricts tools the way the real host expects.
 *
 * The fake `tools.restrict` mirrors `dsh-tools` semantics closely enough to
 * exercise both the happy path and the unknown-name recovery path:
 *   - rejection when given an empty filter
 *   - rejection naming every global tool it does know
 *   - intersection of successive restrictions
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, name as pluginName, inject } from '../lib/index.js'

const KNOWN = [
  'read', 'write', 'edit', 'glob', 'grep', 'ops_bash', 'pwsh', 'todo_write',
  'ask_user_question', 'present', 'working_directory', 'compress', 'acp_status',
  'decompress', 'search_context', 'router_status', 'router_mode', 'router_advance',
  'router_begin', 'tools_catalog', 'tools_help', 'delivery_check',
  'web_search', 'skill', 'exit_plan_mode', 'read_image', 'job_list',
]

/** Minimal stand-in for the agent-scoped tool registry. */
function fakeAgent({ known = KNOWN, rejectUnknown = true } = {}) {
  const restrictions = []
  const agent = {
    session: { header: {}, snapshotEvents: () => [], append() {}, deriveMessages: () => [] },
  }
  agent.ctx = {
    tools: {
      // `view(scope)` is what tools_catalog reads: it must project the same
      // registry the restriction path validates against.
      view() {
        const visible = new Map()
        for (const toolName of known) {
          visible.set(toolName, {
            name: toolName,
            description: `the ${toolName} tool.`,
            parameters: { type: 'object', properties: { path: { type: 'string', description: 'a path' } } },
          })
        }
        return { visible, knownNames: new Set(known), restrictableNames: new Set(known) }
      },
      restrict(filter) {
        if (filter.allow === undefined && filter.deny === undefined) {
          throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny`')
        }
        const unknown = (filter.allow ?? []).filter((toolName) => !known.includes(toolName))
        if (rejectUnknown && unknown.length > 0) {
          throw new Error(
            `tools.restrict() names unknown global tool(s) ${unknown.map((n) => `"${n}"`).join(', ')}; `
            + `known global tools: ${known.map((n) => `"${n}"`).join(', ')}`,
          )
        }
        let active = true
        restrictions.push({ allow: [...(filter.allow ?? [])], isActive: () => active })
        return () => { active = false }
      },
    },
  }
  return { agent, restrictions }
}

/** Minimal stand-in for the Cordis plugin context. */
function fakeCtx() {
  const handlers = new Map()
  const registered = []
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    logger: { warn() {} },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, handlers, registered, fire: (event, ...args) => handlers.get(event)?.map((fn) => fn(...args)) }
}

function sessionWith(events) {
  return { header: {}, snapshotEvents: () => events, append() {}, deriveMessages: () => [] }
}

test('declares the two services it needs', () => {
  assert.equal(pluginName, 'dsh-router')
  assert.deepEqual([...inject].sort(), ['systemPrompt', 'tools'])
})

test('registers every routing and disclosure tool with output+render', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const names = registered.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'delivery_check',
    'router_advance',
    'router_begin',
    'router_mode',
    'router_status',
    'tools_catalog',
    'tools_help',
  ])
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.output, `${tool.name} must declare output`)
    assert.ok(tool.output.schema, `${tool.name} must declare output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} must declare output.render`)
  }
})

test('pre-step restricts a phase-0 agent to the alignment tools', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const { agent, restrictions } = fakeAgent()
  agent.session = sessionWith([
    { type: 'user/message', data: { content: 'hello', source: { kind: 'user' } } },
  ])

  await handlers.get('agent/pre-step')[0]({ agent }, () => Promise.resolve({ kind: 'enter' }))

  assert.equal(restrictions.length, 1)
  const allowed = restrictions[0].allow
  assert.ok(allowed.includes('read'), 'phase 0 reads')
  assert.ok(allowed.includes('grep'))
  assert.ok(!allowed.includes('write'), 'phase 0 must not write')
  assert.ok(!allowed.includes('ops_bash'), 'phase 0 must not shell out')
  assert.ok(allowed.includes('router_advance'), 'the escape hatch is always available')
})

test('pre-step lifts the restriction at the final phase', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const { agent, restrictions } = fakeAgent()
  agent.session = sessionWith([
    { type: 'user/message', data: { content: 'build it', source: { kind: 'user' } } },
    // The real completion chain: align, lock the plan, then pass the gate.
    { type: 'tool/call', data: { name: 'ask_user_question' } },
    { type: 'tool/call', data: { name: 'exit_plan_mode' } },
    { type: 'tool/call', data: { name: 'delivery_check' } },
  ])

  await handlers.get('agent/pre-step')[0]({ agent }, () => Promise.resolve({ kind: 'enter' }))

  // A fresh agent at the final phase installs nothing, so nothing is caged.
  assert.equal(restrictions.length, 0)
})

test('phase-0 restriction narrows instead of failing when a name is unknown', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  // A host missing `grep` and every web tool: the first allow set is rejected,
  // then the recovery path narrows to the names the host reported.
  const known = KNOWN.filter((n) => n !== 'grep' && !n.startsWith('web_'))
  const { agent, restrictions } = fakeAgent({ known })
  agent.session = sessionWith([
    { type: 'user/message', data: { content: 'hello', source: { kind: 'user' } } },
  ])

  await handlers.get('agent/pre-step')[0]({ agent }, () => Promise.resolve({ kind: 'enter' }))

  assert.equal(restrictions.length, 1, 'recovered instead of giving up')
  assert.ok(!restrictions[0].allow.includes('grep'))
  assert.ok(restrictions[0].allow.includes('read'))
})

test('an unreadable known-tool report leaves the agent ungated', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const { agent, restrictions } = fakeAgent({ known: [], rejectUnknown: true })
  // Reject everything, and reject with a message that carries no tool list.
  agent.ctx.tools.restrict = () => { throw new Error('nope') }
  agent.session = sessionWith([
    { type: 'user/message', data: { content: 'hello', source: { kind: 'user' } } },
  ])

  await handlers.get('agent/pre-step')[0]({ agent }, () => Promise.resolve({ kind: 'enter' }))

  assert.equal(restrictions.length, 0, 'fails open, never cages the agent')
})

test('phases:false still rewrites the persona but never touches tools', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'react', phases: false })
  assert.equal(handlers.has('agent/pre-step'), false, 'no pre-step hook when gating is off')

  const { agent } = fakeAgent()
  agent.session = sessionWith([])
  const assembly = { sections: [{ name: 'base', text: 'base prompt' }, { name: 'persona', text: 'old persona' }] }

  const out = await handlers.get('system-prompt/assemble')[0](assembly, { agent }, () => Promise.resolve(assembly))

  const names = out.sections.map((section) => section.name)
  assert.ok(!names.includes('persona'), 'old persona is stripped')
  const persona = out.sections.find((section) => section.name === 'router-persona')
  assert.ok(persona, 'router persona installed')
  assert.match(persona.text, /hands-on/)
  assert.ok(names.includes('router-stage'), 'standing phase declaration installed')
})

test('a subagent is left alone', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'react', phases: true })
  const { agent, restrictions } = fakeAgent()
  agent.session = { header: { parentSession: 'parent' }, snapshotEvents: () => [], append() {}, deriveMessages: () => [] }

  await handlers.get('agent/pre-step')[0]({ agent }, () => Promise.resolve({ kind: 'enter' }))
  const assembly = { sections: [] }
  const out = await handlers.get('system-prompt/assemble')[0](assembly, { agent }, () => Promise.resolve(assembly))

  assert.equal(restrictions.length, 0)
  assert.equal(out, assembly, 'assembly passes through untouched')
})

test('router_mode changes the persona for the next assembly', async () => {
  const { ctx, handlers, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: false })
  const { agent } = fakeAgent()
  agent.session = sessionWith([
    { type: 'user/message', data: { content: '修复登录报错', source: { kind: 'user' } } },
  ])

  const tool = registered.find((entry) => entry.name === 'router_mode')
  await tool.execute({ mode: 'react' }, { agent })
  const assembly = { sections: [] }
  const out = await handlers.get('system-prompt/assemble')[0](assembly, { agent }, () => Promise.resolve(assembly))
  assert.match(out.sections.find((s) => s.name === 'router-persona').text, /hands-on/)

  const status = await registered.find((entry) => entry.name === 'router_status').execute({}, { agent })
  assert.match(status.text, /mode: react/)
})

test('router_advance moves the gate forward and reports the marker', async () => {
  const { ctx, handlers, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const { agent, restrictions } = fakeAgent()
  agent.session = sessionWith([
    { type: 'user/message', data: { content: 'hello', source: { kind: 'user' } } },
  ])

  await handlers.get('agent/pre-step')[0]({ agent }, () => Promise.resolve({ kind: 'enter' }))
  const result = await registered.find((entry) => entry.name === 'router_advance').execute({}, { agent })

  assert.match(result.text, /phase → 2\/4/)
  assert.equal(restrictions.length, 2, 'the advance installed a wider set immediately')
  const widened = restrictions[1].allow
  assert.ok(widened.includes('todo_write'), 'phase 1 unlocks planning')
  assert.ok(widened.includes('read'), 'phase 1 keeps reading')
  assert.ok(!widened.includes('write'), 'phase 1 still does not write')
})

test('tools_catalog reads the live registry, not a hardcoded list', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: false })
  const { agent } = fakeAgent()
  agent.session = sessionWith([])

  const catalog = await registered.find((entry) => entry.name === 'tools_catalog').execute({}, { agent })
  assert.match(catalog.text, /visible tool\(s\)/)
  assert.match(catalog.text, /read/)
  // Phase marks come from the phase table, so the model can see where a tool lands.
  assert.match(catalog.text, /\[phase 1\]/)

  // A query narrows; a query matching nothing says so instead of dumping all.
  const filtered = await registered.find((entry) => entry.name === 'tools_catalog').execute({ query: 'wr' }, { agent })
  assert.match(filtered.text, /write/)
  assert.doesNotMatch(filtered.text, /- read/)
  const none = await registered.find((entry) => entry.name === 'tools_catalog').execute({ query: 'zzz' }, { agent })
  assert.match(none.text, /No visible tool matches/)
})

test('tools_help returns one complete spec and marks its phase', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: false })
  const { agent } = fakeAgent()
  agent.session = sessionWith([])

  const help = await registered.find((entry) => entry.name === 'tools_help').execute({ name: 'write' }, { agent })
  assert.match(help.text, /^write — unlocked at phase 3/)
  assert.match(help.text, /path: string/)
  assert.match(help.text, /the write tool\./)

  const missing = await registered.find((entry) => entry.name === 'tools_help').execute({ name: 'nope' }, { agent })
  assert.match(missing.text, /No visible tool named "nope"/)
})

test('delivery_check fails an absent file and passes a real one', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: false })
  const { agent } = fakeAgent()
  const tool = registered.find((entry) => entry.name === 'delivery_check')

  const missing = await tool.execute({ file: '', evidence: { items: [] } }, { agent })
  assert.match(missing.text, /FAIL/)
  assert.match(missing.text, /missing file parameter/)

  const absent = await tool.execute({ file: 'does/not/exist.txt', evidence: { items: [] } }, { agent })
  assert.match(absent.text, /FAIL/)
  assert.match(absent.text, /file-exists/)

  // The plugin's own manifest is a real, non-empty, UTF-8 file.
  const real = await tool.execute({
    file: new URL('../package.json', import.meta.url).pathname.replace(/^\//, ''),
    evidence: { items: [{ label: 'manifest', kind: 'file', target: new URL('../package.json', import.meta.url).pathname.replace(/^\//, '') }, { label: 'n', kind: 'numeric', result: '30' }] },
  }, { agent })
  assert.match(real.text, /PASS/)
  assert.match(real.text, /encoding-utf8/)
})

test('delivery_check rejects an evidence manifest with no items', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: false })
  const { agent } = fakeAgent()
  const tool = registered.find((entry) => entry.name === 'delivery_check')
  const file = new URL('../package.json', import.meta.url).pathname.replace(/^\//, '')

  const out = await tool.execute({ file, evidence: { items: [] } }, { agent })
  assert.match(out.text, /FAIL/)
  assert.match(out.text, /missing evidence items/)
  assert.match(out.text, /do not report completion/)
})

test('router_begin reports the phase and its guidance', async () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const { agent } = fakeAgent()
  agent.session = sessionWith([])

  const out = await registered.find((entry) => entry.name === 'router_begin').execute({}, { agent })
  assert.match(out.text, /Bootstrap confirmed — phase 1\/4/)
  assert.match(out.text, /^Phase: understanding/m)
})

test('the assemble hook installs every guidance section', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'weak', phases: false })
  const { agent } = fakeAgent()
  agent.session = sessionWith([])
  const assembly = { sections: [{ name: 'base', text: 'base' }] }

  const out = await handlers.get('system-prompt/assemble')[0](assembly, { agent }, () => Promise.resolve(assembly))
  const names = out.sections.map((section) => section.name)
  for (const expected of ['router-persona', 'router-decl', 'router-stage', 'router-proactivity', 'base']) {
    assert.ok(names.includes(expected), `missing section ${expected}`)
  }
  const decl = out.sections.find((s) => s.name === 'router-decl')
  assert.match(decl.text, /revealed in phases/)
  const proactivity = out.sections.find((s) => s.name === 'router-proactivity')
  assert.match(proactivity.text, /reversible/)
  // The base prompt survives: this plugin adds guidance, it does not replace it.
  assert.ok(names.includes('base'))
})

test('repeated assemblies never duplicate a section', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { mode: 'react', phases: false })
  const { agent } = fakeAgent()
  agent.session = sessionWith([])

  let assembly = { sections: [{ name: 'base', text: 'base' }] }
  for (let i = 0; i < 3; i++) {
    assembly = await handlers.get('system-prompt/assemble')[0](assembly, { agent }, () => Promise.resolve(assembly))
  }
  const names = assembly.sections.map((section) => section.name)
  assert.equal(names.filter((n) => n === 'router-stage').length, 1)
  assert.equal(names.filter((n) => n === 'router-decl').length, 1)
  assert.equal(names.filter((n) => n === 'router-persona').length, 1)
})
