import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createTranscripts } from '../src/transcripts.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/transcripts/basic.jsonl')

const transcripts = createTranscripts()

test('page keeps the conversation and drops bookkeeping and sidechain lines', async () => {
  const { entries, skipped, hasMore } = await transcripts.page(FIXTURE)

  assert.deepEqual(
    entries.map((e) => e.uuid),
    ['u1', 'a1', 'u2', 'a2', 'u3', 'plan1'],
  )
  assert.equal(skipped, 0)
  assert.equal(hasMore, false)
})

test('a plan is its own kind, kept whole, carrying the plan file id', async () => {
  // Reading the plan as markdown is the point of planview, so it gets the prose budget and never
  // arrives clipped to a tool-call preview.
  const { entries } = await transcripts.page(FIXTURE)
  const [plan] = entries.at(-1).blocks

  assert.equal(plan.kind, 'plan')
  assert.equal(plan.planId, 'quiet-pebble')
  assert.equal(plan.truncated, false)
  assert.match(plan.text, /^# Plan title/)
  assert.match(plan.text, /\| col \| col2 \|/)
})

test('a plan without a file path still renders; only the fallback id is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'plan.jsonl')
  await writeFile(
    path,
    JSON.stringify({
      type: 'assistant',
      uuid: 'p',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'ExitPlanMode', input: { plan: '# only inline' } }],
      },
    }) + '\n',
  )

  const [{ blocks }] = (await transcripts.page(path)).entries
  assert.equal(blocks[0].kind, 'plan')
  assert.equal(blocks[0].planId, null)
  assert.equal(blocks[0].text, '# only inline')
})

test('an oversized plan is clipped to the prose budget, not the tool budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'big-plan.jsonl')
  const plan = '# huge\n' + 'x'.repeat(20_000)
  await writeFile(
    path,
    JSON.stringify({
      type: 'assistant',
      uuid: 'p',
      timestamp: 't',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'x', name: 'ExitPlanMode', input: { plan, planFilePath: '/p/plans/big.md' } },
        ],
      },
    }) + '\n',
  )

  const tight = createTranscripts({ maxToolBytes: 100, maxTextBytes: 1000 })
  const [{ blocks }] = (await tight.page(path)).entries
  assert.equal(blocks[0].text.length, 1000)
  assert.equal(blocks[0].truncated, true)
  assert.equal(blocks[0].planId, 'big')
})

test('page shapes user text, tool calls, results and thinking into typed blocks', async () => {
  const { entries } = await transcripts.page(FIXTURE)
  const [u1, a1, u2, a2, u3] = entries

  assert.equal(u1.role, 'user')
  assert.deepEqual(u1.blocks, [{ kind: 'text', i: 0, text: 'сделай мне хорошо', truncated: false }])

  assert.equal(a1.role, 'assistant')
  assert.equal(a1.blocks[0].kind, 'text')
  assert.equal(a1.blocks[1].kind, 'tool_use')
  assert.equal(a1.blocks[1].name, 'Bash')
  assert.match(a1.blocks[1].text, /ls -la/)

  assert.equal(u2.blocks[0].kind, 'tool_result')
  assert.equal(u2.blocks[0].toolUseId, 't1')
  assert.equal(u2.blocks[0].isError, false)
  assert.equal(u2.blocks[0].text, 'file1\nfile2')

  assert.equal(a2.blocks[0].kind, 'thinking')
  assert.equal(a2.blocks[1].text, 'Done.')

  // A list-shaped tool_result flattens to its text; is_error survives.
  assert.equal(u3.blocks[0].text, 'boom')
  assert.equal(u3.blocks[0].isError, true)
})

test('backwards pagination walks a file across chunk boundaries without losing lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'long.jsonl')
  const lines = []
  for (let i = 0; i < 30; i++) {
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: `u${i}`,
        timestamp: 't',
        message: { role: 'user', content: `message number ${i} padded ${'x'.repeat(40)}` },
      }),
    )
  }
  await writeFile(path, lines.join('\n') + '\n')

  // A chunk far smaller than a line forces many backwards reads per page.
  const small = createTranscripts({ chunk: 128 })
  const collected = []
  let before
  for (;;) {
    const page = await small.page(path, { before, limit: 7 })
    collected.unshift(...page.entries.map((e) => e.uuid))
    if (!page.hasMore) break
    before = page.nextBefore
  }

  assert.deepEqual(collected, lines.map((_, i) => `u${i}`))
})

test('a trailing line without a newline is held back until it is finished', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'live.jsonl')
  const full = JSON.stringify({ type: 'user', uuid: 'done', timestamp: 't', message: { role: 'user', content: 'hi' } })
  await writeFile(path, `${full}\n{"type":"user","uuid":"half`)

  const page = await transcripts.page(path)
  assert.deepEqual(page.entries.map((e) => e.uuid), ['done'])
  assert.equal(page.skipped, 0)

  const tail = await transcripts.tail(path, 0)
  assert.deepEqual(tail.entries.map((e) => e.uuid), ['done'])
  assert.equal(tail.offset, full.length + 1)
})

test('tail resumes from its returned offset and sees only what was appended', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'tail.jsonl')
  const line = (uuid) =>
    JSON.stringify({ type: 'user', uuid, timestamp: 't', message: { role: 'user', content: uuid } }) + '\n'
  await writeFile(path, line('one'))

  const first = await transcripts.tail(path, 0)
  assert.deepEqual(first.entries.map((e) => e.uuid), ['one'])

  await appendFile(path, line('two'))
  const second = await transcripts.tail(path, first.offset)
  assert.deepEqual(second.entries.map((e) => e.uuid), ['two'])
})

test('a tail that fell too far behind skips ahead and says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'behind.jsonl')
  const line = (uuid) =>
    JSON.stringify({ type: 'user', uuid, timestamp: 't', message: { role: 'user', content: 'x'.repeat(100) } }) + '\n'
  await writeFile(path, line('old1') + line('old2') + line('new1') + line('new2'))

  const tiny = createTranscripts({ maxTailBytes: 2 * line('newX').length })
  const result = await tiny.tail(path, 0)

  assert.equal(result.gap, true)
  assert.ok(result.entries.length < 4, 'the backlog was not fully replayed')
  assert.equal(result.entries.at(-1).uuid, 'new2')
})

test('oversized tool payloads are clipped and flagged, and readLine recovers the full line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'big.jsonl')
  const bigOutput = 'y'.repeat(10_000)
  const entryLine = JSON.stringify({
    type: 'user',
    uuid: 'big',
    timestamp: 't',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: bigOutput }] },
  })
  await writeFile(path, entryLine + '\n')

  const clipped = createTranscripts({ maxToolBytes: 100 })
  const { entries } = await clipped.page(path)
  assert.equal(entries[0].blocks[0].truncated, true)
  assert.equal(entries[0].blocks[0].text.length, 100)
  assert.equal(entries[0].blocks[0].fullLength, bigOutput.length)

  const raw = await clipped.readLine(path, entries[0].offset)
  assert.equal(raw.message.content[0].content, bigOutput)
})

test('a malformed line is counted, not fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'bad.jsonl')
  const good = JSON.stringify({ type: 'user', uuid: 'ok', timestamp: 't', message: { role: 'user', content: 'hi' } })
  await writeFile(path, `not json at all\n${good}\n`)

  const page = await transcripts.page(path)
  assert.deepEqual(page.entries.map((e) => e.uuid), ['ok'])
  assert.equal(page.skipped, 1)
})

test('watchFile fires on append and stops cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'planview-transcripts-'))
  const path = join(dir, 'watched.jsonl')
  await writeFile(path, '')

  let fired = 0
  const stop = transcripts.watchFile(path, () => fired++, { debounceMs: 10, pollMs: 100 })
  await appendFile(path, 'x\n')
  await new Promise((resolve) => setTimeout(resolve, 250))
  stop()
  const seen = fired
  await appendFile(path, 'y\n')
  await new Promise((resolve) => setTimeout(resolve, 150))

  assert.ok(seen >= 1, 'change noticed')
  assert.equal(fired, seen, 'quiet after stop')
})
