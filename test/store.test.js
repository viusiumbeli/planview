import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTitle, parseFilename, buildTree } from '../src/store.js'

test('parseTitle returns the first H1 without its hashes', () => {
  const text = '# COMD-1348 — Prevent thread blocking\n\n## Context\n\nBody.\n'

  assert.equal(parseTitle(text), 'COMD-1348 — Prevent thread blocking')
})

test('parseTitle returns null when the plan has no H1', () => {
  const text = 'Just a paragraph with no H1 at all.\n\nSecond line.\n'

  assert.equal(parseTitle(text), null)
})

test('parseTitle ignores a hash comment inside a fenced code block', () => {
  const text = '```bash\n# not a title\n```\n\n# The Real Title\n'

  assert.equal(parseTitle(text), 'The Real Title')
})

test('parseFilename treats a plain plan as its own top-level node', () => {
  assert.deepEqual(parseFilename('comd-1348-proud-scott.md'), {
    id: 'comd-1348-proud-scott',
    parentId: null,
    agentName: null,
  })
})

test('parseFilename links a subagent plan to its parent', () => {
  assert.deepEqual(parseFilename('comd-1348-proud-scott-agent-a85b2c4a929924f05.md'), {
    id: 'comd-1348-proud-scott-agent-a85b2c4a929924f05',
    parentId: 'comd-1348-proud-scott',
    agentName: null,
  })
})

test('parseFilename recovers the agent name when the suffix carries one', () => {
  assert.deepEqual(parseFilename('atomic-sparking-yeti-agent-aarchitect2-8e1b71ee7ee1f5dd.md'), {
    id: 'atomic-sparking-yeti-agent-aarchitect2-8e1b71ee7ee1f5dd',
    parentId: 'atomic-sparking-yeti',
    agentName: 'architect2',
  })
})

test('parseFilename keeps a hyphenated agent name intact', () => {
  assert.equal(
    parseFilename('shiny-watching-sunrise-agent-abug-investigator-8e1b71ee7ee1f5dd.md').agentName,
    'bug-investigator',
  )
})

test('parseFilename does not split a plan whose own slug contains "-agent-"', () => {
  assert.deepEqual(parseFilename('review-the-agent-config-happy-fox.md'), {
    id: 'review-the-agent-config-happy-fox',
    parentId: null,
    agentName: null,
  })
})

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const NOW = at(2026, 8, 10, 15, 30)

const entry = (id, mtime, title = id) => ({ id, mtime, title })

test('buildTree groups plans by calendar day, newest day first', () => {
  const tree = buildTree(
    [entry('a', at(2026, 8, 8)), entry('b', at(2026, 8, 10)), entry('c', at(2026, 8, 9))],
    NOW,
  )

  assert.deepEqual(tree.groups.map((g) => g.plans.map((p) => p.id)), [['b'], ['c'], ['a']])
})

test('buildTree labels the two most recent days Today and Yesterday', () => {
  const tree = buildTree([entry('a', at(2026, 8, 10)), entry('b', at(2026, 8, 9))], NOW)

  assert.deepEqual(tree.groups.map((g) => g.label), ['Today', 'Yesterday'])
})

test('buildTree labels an older day with weekday, date and month', () => {
  const tree = buildTree([entry('a', at(2026, 8, 6))], NOW)

  assert.equal(tree.groups[0].label, 'Thu 6 Aug')
})

test('buildTree orders plans within a day newest first', () => {
  const tree = buildTree(
    [entry('early', at(2026, 8, 10, 9)), entry('late', at(2026, 8, 10, 14))],
    NOW,
  )

  assert.deepEqual(tree.groups[0].plans.map((p) => p.id), ['late', 'early'])
})

test('buildTree nests a subagent plan under its parent instead of at top level', () => {
  const tree = buildTree(
    [
      entry('atomic-sparking-yeti', at(2026, 8, 10, 14)),
      entry('atomic-sparking-yeti-agent-a85b2c4a929924f05', at(2026, 8, 10, 13)),
    ],
    NOW,
  )

  assert.deepEqual(tree.groups[0].plans.map((p) => p.id), ['atomic-sparking-yeti'])
  assert.deepEqual(
    tree.groups[0].plans[0].children.map((c) => c.id),
    ['atomic-sparking-yeti-agent-a85b2c4a929924f05'],
  )
})

test('buildTree keeps a subagent plan with its parent across a day boundary', () => {
  const tree = buildTree(
    [
      entry('atomic-sparking-yeti', at(2026, 8, 10, 14)),
      entry('atomic-sparking-yeti-agent-a85b2c4a929924f05', at(2026, 8, 4, 9)),
    ],
    NOW,
  )

  assert.equal(tree.groups.length, 1)
  assert.equal(tree.groups[0].plans[0].children.length, 1)
})

test('buildTree promotes an orphaned subagent plan to top level', () => {
  const tree = buildTree([entry('gone-agent-adeadbeefdeadbeef', at(2026, 8, 10))], NOW)

  assert.deepEqual(tree.groups[0].plans.map((p) => p.id), ['gone-agent-adeadbeefdeadbeef'])
})

test('buildTree exposes the agent name on a nested child', () => {
  const tree = buildTree(
    [
      entry('atomic-sparking-yeti', at(2026, 8, 10, 14)),
      entry('atomic-sparking-yeti-agent-aarchitect2-8e1b71ee7ee1f5dd', at(2026, 8, 10, 13)),
    ],
    NOW,
  )

  assert.equal(tree.groups[0].plans[0].children[0].agentName, 'architect2')
})

test('buildTree keeps plans from the last 7 days in groups', () => {
  const tree = buildTree([entry('recent', at(2026, 8, 4))], NOW)

  assert.deepEqual(tree.groups[0].plans.map((p) => p.id), ['recent'])
  assert.deepEqual(tree.older, [])
})

test('buildTree moves plans beyond the window into a flat older list', () => {
  const tree = buildTree([entry('stale', at(2026, 8, 3)), entry('ancient', at(2026, 7, 13))], NOW)

  assert.deepEqual(tree.groups, [])
  assert.deepEqual(tree.older.map((p) => p.id), ['stale', 'ancient'])
})

test('buildTree keeps an old subagent plan nested under its recent parent', () => {
  const tree = buildTree(
    [
      entry('atomic-sparking-yeti', at(2026, 8, 10)),
      entry('atomic-sparking-yeti-agent-a85b2c4a929924f05', at(2026, 7, 13)),
    ],
    NOW,
  )

  assert.deepEqual(tree.older, [])
  assert.equal(tree.groups[0].plans[0].children.length, 1)
})

test('buildTree falls back to the id when a plan has no title', () => {
  const tree = buildTree([{ id: 'no-heading-quiet-pebble', mtime: NOW, title: null }], NOW)

  assert.equal(tree.groups[0].plans[0].title, 'no-heading-quiet-pebble')
})
