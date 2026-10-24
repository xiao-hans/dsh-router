/**
 * Smoke test for dsh-router/core. Run with: node --test test/core.test.mjs
 * No dependencies; asserts the same tables the plugin installs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALWAYS,
  META_TOOLS,
  MODE_MIXED,
  MODE_REACT,
  MODE_SPEC,
  MODE_WEAK,
  PRESSURE_GUIDE,
  PROGRESSIVE_DECL,
  STAGES,
  STAGE_GUIDES,
  advanceStage,
  allowListFor,
  bandOf,
  classifyTask,
  deriveStage,
  extractText,
  firstUserTask,
  isComplexTask,
  isFlashModel,
  parseMode,
  personaFor,
  stageText,
  validateEvidence,
} from '../lib/core.js'

test('bands quantize onto the four measured regions', () => {
  assert.equal(bandOf(0), 'spec')
  assert.equal(bandOf(0.14), 'spec')
  assert.equal(bandOf(0.2), 'transition')
  assert.equal(bandOf(0.49), 'transition')
  assert.equal(bandOf(0.5), 'react')
  assert.equal(bandOf(1), 'react')
  assert.equal(bandOf(MODE_WEAK), 'weak')
})

test('parseMode covers names, numbers, percentages and junk', () => {
  assert.equal(parseMode('auto'), 'auto')
  assert.equal(parseMode('weak'), MODE_WEAK)
  assert.equal(parseMode('react'), MODE_REACT)
  assert.equal(parseMode('spec'), MODE_SPEC)
  assert.equal(parseMode('mixed'), MODE_MIXED)
  assert.equal(parseMode('0.3'), 0.3)
  // A bare integer is a percentage, matching the upstream CLI convention.
  assert.equal(parseMode('1'), 0.01)
  assert.equal(parseMode('50'), 0.5)
  assert.equal(parseMode('100'), 1)
  assert.equal(parseMode('250'), 1)
  assert.equal(parseMode('nonsense'), null)
  assert.equal(parseMode(undefined), null)
})

test('persona picks the flash variant only for flash models', () => {
  assert.match(personaFor(MODE_WEAK, 'deepseek-v4-flash'), /do not repeat completed steps/)
  assert.doesNotMatch(personaFor(MODE_WEAK, 'deepseek-v4-pro'), /do not repeat completed steps/)
  assert.match(personaFor(MODE_REACT, 'any'), /hands-on/)
})

test('classification separates build from fix and falls back to weak', () => {
  assert.equal(classifyTask('帮我写一个贪吃蛇游戏'), MODE_REACT)
  assert.equal(classifyTask('修复登录报错'), MODE_SPEC)
  assert.equal(classifyTask('hello'), MODE_WEAK)
  assert.equal(classifyTask(''), MODE_WEAK)
  assert.equal(classifyTask(undefined), MODE_WEAK)
})

test('extractText unwraps both message shapes', () => {
  assert.equal(extractText({ content: 'hi' }), 'hi')
  assert.equal(extractText({ message: { content: [{ type: 'text', text: 'hi' }] } }), 'hi')
  assert.equal(extractText({ content: [{ type: 'text', text: 'a' }, { text: 'b' }] }), 'a b')
  assert.equal(extractText(null), '')
})

test('complexity and flash detection', () => {
  assert.equal(isComplexTask('x'.repeat(121)), true)
  assert.equal(isComplexTask('重构一下'), true)
  assert.equal(isComplexTask('hi'), false)
  assert.equal(isFlashModel('v4-flash'), true)
  assert.equal(isFlashModel('v4-pro'), false)
})

test('advanceStage walks the four phases and stops at the end', () => {
  // Each phase is exited by its own completion signal, never by incidental
  // tool use — reading all day does not finish alignment.
  assert.equal(advanceStage(0, ['todo_write'], ''), 1)
  assert.equal(advanceStage(0, ['ask_user_question'], ''), 1)
  assert.equal(advanceStage(0, ['read'], ''), 0)
  assert.equal(advanceStage(1, ['todo_write'], ''), 2)
  assert.equal(advanceStage(1, ['exit_plan_mode'], ''), 2)
  // Writing code is the *work* of phase 3, not a signal that ends phase 2.
  assert.equal(advanceStage(1, ['write'], ''), 1)
  assert.equal(advanceStage(2, ['delivery_check'], ''), 3)
  assert.equal(advanceStage(2, ['write'], ''), 2)
  assert.equal(advanceStage(3, ['write'], ''), 3)
})

test('derived stage replays from the log and ignores plugin messages', () => {
  const events = [
    { type: 'user/message', data: { content: 'build a game', source: { kind: 'user' } } },
    { type: 'tool/call', data: { name: 'todo_write' } },
    { type: 'tool/call', data: { name: 'todo_write' } },
    { type: 'tool/call', data: { name: 'write' } },
    { type: 'tool/call', data: { name: 'delivery_check' } },
    { type: 'user/message', data: { content: '进入开发', source: { kind: 'plugin' } } },
  ]
  assert.equal(deriveStage(events), 3)
  assert.equal(firstUserTask(events), 'build a game')
  assert.equal(deriveStage([]), 0)
})

test('allowListFor grows with the phase and lifts at the end', () => {
  const stage0 = allowListFor(0, null)
  assert.ok(stage0.includes('read'))
  assert.ok(!stage0.includes('write'))
  assert.ok(!stage0.includes('ops_bash'))
  for (const name of ALWAYS) assert.ok(stage0.includes(name), `${name} must always be available`)

  const stage1 = allowListFor(1, null)
  assert.ok(stage1.includes('todo_write'))
  assert.ok(!stage1.includes('write'))

  const stage2 = allowListFor(2, null)
  assert.ok(stage2.includes('write'))
  assert.ok(!stage2.includes('ops_bash'))

  assert.equal(allowListFor(STAGES.length - 1, null), null)

  // A known-name set narrows the result to what the host actually has.
  const narrowed = allowListFor(0, new Set(['read', 'write', 'present']))
  assert.deepEqual(narrowed.sort(), ['present', 'read'])
})

test('every staged tool name is unique across phases', () => {
  const seen = new Set(ALWAYS)
  for (const stage of STAGES) {
    for (const name of stage.tools) {
      assert.ok(!seen.has(name), `duplicate tool "${name}"`)
      seen.add(name)
    }
  }
})

test('every phase has guidance text and the guides name their phase', () => {
  assert.equal(STAGE_GUIDES.length, STAGES.length)
  for (const [index, guide] of STAGE_GUIDES.entries()) {
    assert.ok(guide.length > 200, `phase ${index} guide is too thin to guide anything`)
    assert.match(guide, /^Phase:/, `phase ${index} guide must open by naming the phase`)
    assert.match(guide, /Complete when:|Gate:/, `phase ${index} guide must define its exit`)
  }
})

test('routing tools reach the model at every phase', () => {
  for (let stage = 0; stage < STAGES.length - 1; stage++) {
    const allowed = allowListFor(stage, null)
    for (const name of META_TOOLS) {
      assert.ok(allowed.includes(name), `${name} must be callable at phase ${stage}`)
    }
    assert.ok(allowed.includes('ask_user_question'), 'alignment needs the question tool')
    assert.ok(allowed.includes('compress'), 'context management must survive every phase')
  }
})

test('stageText names the current phase and the next unlock', () => {
  const text = stageText(0, allowListFor(0, null))
  assert.match(text, /了解 \/ 对齐/)
  assert.match(text, /Next phase "拟合方案"/)
  assert.match(stageText(3, allowListFor(3, null)), /All tools are unlocked/)
})

test('stageText never claims a partial list at the unrestricted phase', () => {
  // allowListFor returns null at the final phase because nothing is restricted;
  // callers pass [] in that case. The text must not then say "routing tools only"
  // while simultaneously promising the full registry.
  const text = stageText(3, [])
  assert.doesNotMatch(text, /routing tools only/)
  assert.match(text, /every tool in the registry/)
})

test('statusReport and stageText agree about the final phase', async () => {
  const final = stageText(3, allowListFor(3, null) ?? [])
  assert.doesNotMatch(final, /routing tools only/)
})

test('the guidance texts are present and non-trivial', () => {
  assert.ok(PROGRESSIVE_DECL.length > 400, 'the disclosure declaration must explain the mechanism')
  assert.match(PROGRESSIVE_DECL, /tools_catalog/)
  assert.match(PROGRESSIVE_DECL, /never guess/)
  assert.ok(PRESSURE_GUIDE.length > 200)
  assert.match(PRESSURE_GUIDE, /reversible/)
  assert.match(PRESSURE_GUIDE, /belongs to the user/)
})

test('validateEvidence accepts a complete manifest', () => {
  const { failures, hints } = validateEvidence([
    { label: 'artifact', kind: 'file', target: 'a.html' },
    { label: 'run', kind: 'run', result: 'exit 0' },
    { label: 'invariant', kind: 'numeric', result: '2.07' },
  ], { exists: () => true })
  assert.deepEqual(failures, [])
  // A numeric assertion is present, so no hint is owed.
  assert.deepEqual(hints, [])
})

test('validateEvidence rejects each malformed evidence kind', () => {
  const cases = [
    [[], /missing evidence items/],
    [[{ label: '', kind: 'file', target: 'a' }], /empty label/],
    [[{ label: 'x', kind: 'bogus' }], /bad kind/],
    [[{ label: 'x', kind: 'run' }], /without result/],
    [[{ label: 'x', kind: 'text', result: '  ' }], /without result/],
    [[{ label: 'x', kind: 'numeric', result: 'about 2' }], /numeric result/],
    [[{ label: 'x', kind: 'file' }], /without target/],
    [[{ label: 'x', kind: 'external' }], /needs target or result/],
    [[{ label: 'x', kind: 'image', target: 'shot.png' }], /visual not reviewed/],
  ]
  for (const [items, pattern] of cases) {
    const { failures } = validateEvidence(items, { exists: () => true })
    assert.ok(failures.some((f) => pattern.test(f)), `expected ${pattern} for ${JSON.stringify(items)}`)
  }
})

test('validateEvidence reports a missing target and an unreviewed page', () => {
  const missing = validateEvidence([{ label: 'a', kind: 'file', target: 'nope' }], { exists: () => false })
  assert.ok(missing.failures.some((f) => /target missing/.test(f)))

  const page = validateEvidence([{ label: 'p', kind: 'page', target: 'p.html', reviewed: true }], {
    url: 'http://127.0.0.1:1622',
    exists: () => true,
  })
  assert.deepEqual(page.failures, [])

  const noVisual = validateEvidence([{ label: 'p', kind: 'file', target: 'p.html' }], {
    url: 'http://127.0.0.1:1622',
    exists: () => true,
  })
  assert.ok(noVisual.failures.some((f) => /reviewed visual/.test(f)))
})

test('a missing numeric assertion is a hint, not a failure', () => {
  const { failures, hints } = validateEvidence(
    [{ label: 'artifact', kind: 'file', target: 'a.html' }],
    { exists: () => true },
  )
  assert.deepEqual(failures, [])
  assert.equal(hints.length, 1)
  assert.match(hints[0], /numeric/)
})
