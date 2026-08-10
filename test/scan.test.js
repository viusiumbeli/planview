import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { scan } from '../src/scan.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/plans')

test('scan reads every plan in the directory', async () => {
  const entries = await scan(FIXTURES)

  assert.equal(entries.length, 7)
})

test('scan takes each title from the H1', async () => {
  const entries = await scan(FIXTURES)
  const yeti = entries.find((e) => e.id === 'atomic-sparking-yeti')

  assert.equal(yeti.title, 'COMD-1436 — CPA2.1 Partner program admin API — impact analysis & plan')
})

test('scan preserves a non-ASCII title verbatim', async () => {
  const entries = await scan(FIXTURES)
  const doctor = entries.find((e) => e.id === 'doctor-cleanup-misty-goose')

  assert.equal(doctor.title, '/doctor — чистка постоянного контекста (группы A–D)')
})

test('scan reports a null title for a plan with no H1', async () => {
  const entries = await scan(FIXTURES)
  const bare = entries.find((e) => e.id === 'no-heading-quiet-pebble')

  assert.equal(bare.title, null)
})

test('scan returns an mtime for every plan', async () => {
  const entries = await scan(FIXTURES)

  assert.ok(entries.every((e) => Number.isFinite(e.mtime)))
})

test('scan returns an empty list when the plans directory does not exist', async () => {
  assert.deepEqual(await scan(join(FIXTURES, 'nope')), [])
})
