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
  'web_search', 'skill', 'exit_plan_mode',
]

/** Minimal stand-in for the agent-scoped tool registry. */
function fakeAgent({ known = KNOWN, rejectUnknown = true } = {}) {
  const restrictions = []
  const agent = {
    session: { header: {}, snapshotEvents: () => [], append() {}, deriveMessages: () => [] },
  }
  agent.ctx = {
    tools: {
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

test('registers exactly the three routing tools with output+render', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { mode: 'auto', phases: true })
  const names = registered.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['router_advance', 'router_mode', 'router_status'])
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
    { type: 'tool/call', data: { name: 'todo_write' } },
    { type: 'tool/call', data: { name: 'write' } },
    { type: 'tool/call', data: { name: 'ops_bash' } },
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
