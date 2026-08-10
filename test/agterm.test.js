import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgterm } from '../src/agterm.js'

const SESSION = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'
const entry = { sessionId: SESSION, pane: 'left', socket: '/tmp/agterm.sock', paneId: 'surface-token' }

// A stub standing in for agtermctl: it records the argv and stdin it was handed, next to itself.
async function withStub(fn, { exit = 0, stdout = 'SCREEN TEXT' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'planview-agterm-'))
  const bin = join(dir, 'agtermctl')
  await writeFile(
    bin,
    [
      '#!/usr/bin/env bash',
      'd=$(dirname "$0")',
      'printf "%s\\n" "$@" > "$d/argv"',
      'cat > "$d/stdin"',
      `printf '%s' ${JSON.stringify(stdout)}`,
      `exit ${exit}`,
    ].join('\n'),
    { mode: 0o755 },
  )

  try {
    return await fn({
      agterm: createAgterm({ bin }),
      argv: async () => (await readFile(join(dir, 'argv'), 'utf8')).trim().split('\n'),
      stdin: () => readFile(join(dir, 'stdin'), 'utf8'),
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('text asks agtermctl for the session buffer and returns it', async () => {
  await withStub(async ({ agterm, argv }) => {
    const out = await agterm.text(entry)

    assert.equal(out, 'SCREEN TEXT')
    assert.deepEqual(await argv(), [
      'session',
      'text',
      '--target',
      SESSION,
      '--socket',
      '/tmp/agterm.sock',
      '--pane',
      'left',
      '--lines',
      '60',
    ])
  })
})

test('text does not pass --pane-id, which session text does not accept', async () => {
  // Only `session status`/`restore` take --pane-id; sending it would fail the call outright.
  await withStub(async ({ agterm, argv }) => {
    await agterm.text(entry)

    assert.equal((await argv()).includes('--pane-id'), false)
  })
})

test('text reports null when agtermctl fails, so the caller refuses rather than guesses', async () => {
  await withStub(
    async ({ agterm }) => {
      assert.equal(await agterm.text(entry), null)
    },
    { exit: 3 },
  )
})

test('type delivers the escape sequences over stdin, not argv', async () => {
  await withStub(async ({ agterm, argv, stdin }) => {
    const res = await agterm.type(entry, '\x1b[B\x1b[B\r')

    assert.equal(res.ok, true)
    assert.deepEqual(await argv(), [
      'session',
      'type',
      '--stdin',
      '--target',
      SESSION,
      '--socket',
      '/tmp/agterm.sock',
      '--pane',
      'left',
    ])
    // The control bytes must survive intact — this is the actual keypress payload.
    assert.equal(await stdin(), '\x1b[B\x1b[B\r')
  })
})

test('type surfaces a failure with agtermctl stderr rather than reporting success', async () => {
  await withStub(
    async ({ agterm }) => {
      const res = await agterm.type(entry, '\r')

      assert.equal(res.ok, false)
      assert.match(res.error, /exit 4|notFound/)
    },
    { exit: 4, stdout: '' },
  )
})

test('a missing agtermctl binary is an error, not a crash', async () => {
  const agterm = createAgterm({ bin: join(tmpdir(), 'planview-no-such-agtermctl') })

  assert.equal(await agterm.text(entry), null)
  assert.equal((await agterm.type(entry, '\r')).ok, false)
})

test('optional fields are omitted when the hook did not supply them', async () => {
  await withStub(async ({ agterm, argv }) => {
    await agterm.text({ sessionId: SESSION })

    assert.deepEqual(await argv(), ['session', 'text', '--target', SESSION, '--lines', '60'])
  })
})
