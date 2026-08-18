import test from 'node:test'
import assert from 'node:assert/strict'

import { entryRows } from '../public/sessions/termlog.js'

const entry = (role, blocks, offset = 42) => ({ role, ts: 't', offset, blocks })

test('a user prompt reads like a terminal prompt, continuations aligned', () => {
  const rows = entryRows(entry('user', [{ kind: 'text', i: 0, text: 'сделай хорошо\nи побыстрее', truncated: false }]))

  assert.equal(rows.length, 1)
  assert.equal(rows[0].cls, 't-user')
  assert.equal(rows[0].text, '> сделай хорошо\n  и побыстрее')
  assert.equal(rows[0].more, null)
})

test('assistant text gets the ⏺ bullet and two-space continuations', () => {
  const rows = entryRows(entry('assistant', [{ kind: 'text', i: 0, text: 'Готово.\nВторая строка', truncated: false }]))

  assert.equal(rows[0].cls, 't-asst')
  assert.equal(rows[0].text, '⏺ Готово.\n  Вторая строка')
})

test('a tool call is a one-line label with the first input line, full input behind expand', () => {
  const input = '{\n "command": "ls -la",\n "description": "List files"\n}'
  const rows = entryRows(entry('assistant', [{ kind: 'tool_use', i: 1, name: 'Bash', text: input, truncated: false }]))

  assert.equal(rows[0].cls, 't-tool')
  assert.match(rows[0].text, /^⏺ Bash\(\{…\)$/)
  assert.match(rows[0].more.hidden, /^ {2}\{\n {2} "command": "ls -la",/)
})

test('a tool result shows its first lines with the ⎿ elbow, the rest folded with a count', () => {
  const text = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n')
  const rows = entryRows(entry('user', [{ kind: 'tool_result', i: 0, toolUseId: 't', isError: false, text, truncated: false }]))

  assert.equal(rows[0].cls, 't-result')
  assert.equal(rows[0].text, '  ⎿  l1\n     l2\n     l3\n     l4\n     l5')
  assert.equal(rows[0].more.label, '… +2 строк')
  assert.equal(rows[0].more.hidden, '     l6\n     l7')
})

test('a short result folds nothing and an empty one still says something', () => {
  const short = entryRows(entry('user', [{ kind: 'tool_result', i: 0, isError: false, text: 'ok', truncated: false }]))
  assert.equal(short[0].more, null)

  const empty = entryRows(entry('user', [{ kind: 'tool_result', i: 0, isError: false, text: '', truncated: false }]))
  assert.equal(empty[0].text, '  ⎿  (пустой результат)')
})

test('an error result is flagged, not styled away', () => {
  const rows = entryRows(entry('user', [{ kind: 'tool_result', i: 0, isError: true, text: 'boom', truncated: false }]))
  assert.equal(rows[0].err, true)
})

test('thinking is one dim line until expanded', () => {
  const rows = entryRows(entry('assistant', [{ kind: 'thinking', i: 0, text: 'секретные мысли', truncated: false }]))

  assert.equal(rows[0].cls, 't-think')
  assert.equal(rows[0].text, '✻ thinking…')
  assert.equal(rows[0].more.hidden, '  секретные мысли')
})

test('a plan row hands the renderer raw markdown, not log text', () => {
  const md = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'
  const [row] = entryRows(entry('assistant', [{ kind: 'plan', i: 0, planId: 'quiet-pebble', text: md, truncated: false }]))

  assert.equal(row.cls, 't-plan')
  assert.equal(row.text, md, 'no prefixes or indentation — it gets rendered as a document')
  assert.deepEqual(row.plan, { planId: 'quiet-pebble', truncated: false })
  assert.equal(row.more, null)
  // The plan's full text comes from /api/plan by id, so the block-fetch address is not used here.
  assert.equal(row.fetch, null)
})

test('a truncated plan says so, so the renderer can fetch the file', () => {
  const [row] = entryRows(entry('assistant', [{ kind: 'plan', i: 2, planId: 'big', text: 'clip', truncated: true }]))

  assert.deepEqual(row.plan, { planId: 'big', truncated: true })
})

test('a server-truncated block carries its fetch address for /history/block', () => {
  const rows = entryRows(
    entry('user', [{ kind: 'tool_result', i: 3, isError: false, text: 'clipped', truncated: true, fullLength: 9000 }], 4242),
  )
  assert.deepEqual(rows[0].fetch, { offset: 4242, block: 3 })

  const whole = entryRows(entry('user', [{ kind: 'text', i: 0, text: 'x', truncated: false }]))
  assert.equal(whole[0].fetch, null)
})
