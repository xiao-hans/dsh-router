/**
 * Smoke test for dsh-router/core. Run with: node --test test/core.test.mjs
 * No dependencies; asserts the same tables the plugin installs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALWAYS,
  MODE_MIXED,
  MODE_REACT,
  MODE_SPEC,
  MODE_WEAK,
  STAGES,
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
  assert.equal(advanceStage(0, ['todo_write'], ''), 1)
  assert.equal(advanceStage(0, [], '开始开发吧'), 1)
  assert.equal(advanceStage(0, ['write'], ''), 0)
  assert.equal(advanceStage(1, ['write'], ''), 2)
  assert.equal(advanceStage(2, ['ops_bash'], ''), 3)
  assert.equal(advanceStage(2, [], '完成了'), 3)
  assert.equal(advanceStage(3, ['write'], ''), 3)
})

test('derived stage replays from the log and ignores plugin messages', () => {
  const events = [
    { type: 'user/message', data: { content: 'build a game', source: { kind: 'user' } } },
    { type: 'tool/call', data: { name: 'todo_write' } },
    { type: 'tool/call', data: { name: 'write' } },
    { type: 'tool/call', data: { name: 'ops_bash' } },
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

test('stageText names the current phase and the next unlock', () => {
  const text = stageText(0, allowListFor(0, null))
  assert.match(text, /了解 \/ 对齐/)
  assert.match(text, /Next phase "拟合方案"/)
  assert.match(stageText(3, allowListFor(3, null)), /All tools are unlocked/)
})
