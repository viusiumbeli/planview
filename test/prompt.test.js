import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parsePrompt, keysFor } from '../src/prompt.js'

const UP = '\x1b[A'
const DOWN = '\x1b[B'

// A real `agtermctl session text` capture of the prompt, taken while it was on screen. Everything in
// prompt.js is written against this; the first version guessed the layout and got it wrong.
const REAL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/plan-prompt.txt'), 'utf8')

/** Synthetic prompt for the variants one capture cannot show. */
const prompt = (selected = 1, labels = ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change']) =>
  [
    '   Ready to code?',
    '   Here is Claude\'s plan:',
    '   ...plan body...',
    '  ─────────────────────────',
    '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    ...labels.map((l, i) => `   ${i + 1 === selected ? '❯' : ' '} ${i + 1}. ${l}`),
    '        shift+tab to approve with this feedback',
    '',
    '   ctrl+g to edit in Vim · ~/.claude/plans/some-plan.md',
  ].join('\n')

test('parsePrompt reads the real captured prompt', () => {
  const parsed = parsePrompt(REAL)

  assert.deepEqual(parsed.options, [
    { n: 1, label: 'Yes, and use auto mode', selected: true },
    { n: 2, label: 'Yes, manually approve edits', selected: false },
    { n: 3, label: 'Tell Claude what to change', selected: false },
  ])
  assert.equal(parsed.selected, 1)
})

test('parsePrompt is not fooled by a ❯ or a "Yes…" inside the plan text itself', () => {
  // The captured fixture genuinely contains both above the question line. Anchoring on "Would you
  // like to proceed?" rather than the far-away title is what keeps prose out of the option list.
  assert.match(REAL, /❯ cursor/)
  assert.equal(parsePrompt(REAL).options.length, 3)
})

test('parsePrompt keeps an option whose wording is neither Yes nor No', () => {
  // "Tell Claude what to change" must be counted, or every arrow distance past it is wrong.
  assert.equal(parsePrompt(REAL).options[2].label, 'Tell Claude what to change')
})

test('parsePrompt tracks a cursor the user has already moved', () => {
  assert.equal(parsePrompt(prompt(3)).selected, 3)
})

test('parsePrompt ignores a buffer with no plan prompt in it', () => {
  assert.equal(parsePrompt('~/projects $ npm test\nall good\n'), null)
})

test('parsePrompt rejects an ordinary tool-permission prompt', () => {
  // Same option shape, no "Ready to code?" title — approving it would answer the wrong question.
  const tool = ['   Do you want to proceed?', '   Would you like to proceed?', '   ❯ 1. Yes', '     2. No'].join('\n')

  assert.equal(parsePrompt(tool), null)
})

test('parsePrompt refuses a prompt whose cursor is not visible', () => {
  assert.equal(parsePrompt(prompt(0)), null)
})

test('parsePrompt refuses a prompt showing two cursors', () => {
  const two = prompt(1).replace('   2. Yes, manually', ' ❯ 2. Yes, manually')

  assert.equal(parsePrompt(two), null)
})

test('parsePrompt refuses a list whose ordinals do not run from 1', () => {
  // Miscounted rows mean the cursor would be moved to the wrong place.
  const gap = prompt(1).replace('  3. Tell Claude', '  5. Tell Claude')

  assert.equal(parsePrompt(gap), null)
})

test('parsePrompt uses the last prompt when the screen holds an earlier one', () => {
  const parsed = parsePrompt(`${prompt(1)}\n$ echo done\n${prompt(2, ['Yes, and use auto mode', 'Tell Claude what to change'])}`)

  assert.equal(parsed.options.length, 2)
  assert.equal(parsed.selected, 2)
})

test('keysFor moves down onto a later option and submits', () => {
  assert.deepEqual(keysFor(REAL, 3, 'Tell Claude what to change'), {
    keys: `${DOWN}${DOWN}\r`,
    label: 'Tell Claude what to change',
  })
})

test('keysFor moves up when the cursor sits below the target', () => {
  assert.deepEqual(keysFor(prompt(3), 1, 'Yes, and use auto mode'), {
    keys: `${UP}${UP}\r`,
    label: 'Yes, and use auto mode',
  })
})

test('keysFor submits without moving when the target is already selected', () => {
  assert.deepEqual(keysFor(REAL, 1, 'Yes, and use auto mode'), {
    keys: '\r',
    label: 'Yes, and use auto mode',
  })
})

test('keysFor refuses when the label no longer matches what the button showed', () => {
  // The list is rebuilt per prompt; approving a different option than the one clicked is worse than
  // refusing. This is the guard the first version lacked.
  const result = keysFor(REAL, 1, 'Yes, auto-accept edits')

  assert.match(result.error, /now reads "Yes, and use auto mode"/)
  assert.equal(result.keys, undefined)
})

test('keysFor works without a label when none was supplied', () => {
  assert.equal(keysFor(REAL, 2).label, 'Yes, manually approve edits')
})

test('keysFor refuses an ordinal the prompt does not offer', () => {
  assert.match(keysFor(REAL, 9, undefined).error, /no option 9/)
})

test('keysFor refuses when the prompt is gone', () => {
  assert.match(keysFor('$ ls\nREADME.md\n', 1).error, /no longer on screen/)
})
