import test from 'node:test'
import assert from 'node:assert/strict'

import { slugify, buildOutline } from '../public/outline.js'

test('slugify lowercases and joins words with dashes', () => {
  assert.equal(slugify('Step 1 — Confirm the cause'), 'step-1-confirm-the-cause')
})

test('slugify collapses runs of punctuation into a single dash', () => {
  assert.equal(slugify('What the evidence rules out: ~/.claude/plans/*.md'), 'what-the-evidence-rules-out-claude-plans-md')
})

test('slugify strips inline markdown left in the heading text', () => {
  assert.equal(slugify('The `MenuBarExtra` **bug**'), 'the-menubarextra-bug')
})

test('slugify keeps non-Latin letters, since plan headings are sometimes Russian', () => {
  assert.equal(slugify('Контекст задачи'), 'контекст-задачи')
})

test('slugify falls back to a usable id when nothing survives', () => {
  assert.equal(slugify('— ---'), 'section')
})

test('buildOutline preserves heading order and level', () => {
  const outline = buildOutline([
    { level: 2, text: 'Context' },
    { level: 3, text: 'The incident' },
    { level: 2, text: 'Verification' },
  ])

  assert.deepEqual(outline, [
    { level: 2, text: 'Context', id: 'context' },
    { level: 3, text: 'The incident', id: 'the-incident' },
    { level: 2, text: 'Verification', id: 'verification' },
  ])
})

test('buildOutline gives repeated headings distinct ids', () => {
  const outline = buildOutline([
    { level: 3, text: 'Verification' },
    { level: 3, text: 'Verification' },
    { level: 3, text: 'Verification' },
  ])

  assert.deepEqual(
    outline.map((h) => h.id),
    ['verification', 'verification-2', 'verification-3'],
  )
})

test('buildOutline on a plan with no headings is empty', () => {
  assert.deepEqual(buildOutline([]), [])
})
