import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createServer } from '../src/server.js'
import { createTerm } from '../src/term.js'
import { createAgc } from '../src/agc.js'
import { createClaudeMap } from '../src/claude-map.js'
import { fakeAgtermSocket } from './helpers/fake-agterm.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/plans')
const TRANSCRIPT_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/transcripts/basic.jsonl')
const WID = 'CF859395-8AFF-4E69-AC65-105D183E5C16'
const SID = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'
const CLAUDE = '59d9aaf9-a623-4c76-bdec-d7b46a6d0aac'

// A whole fake agterm: the tree, a mutable screen, and a log of every mutating command.
function agtermScript(state) {
  return (req) => {
    switch (req?.cmd) {
      case 'events.read':
        return { ok: true, result: { events: { run: 'run-1', next: 1, items: [] } } }
      case 'window.list':
        return { ok: true, result: { windows: [{ id: WID, name: 'window 1', open: true, active: true }] } }
      case 'tree':
        return {
          ok: true,
          result: {
            tree: {
              workspaces: [
                {
                  id: 'ws-1',
                  name: 'work',
                  active: true,
                  sessions: [
                    { id: SID, name: '✳ busy', title: '✳ busy', cwd: state.cwd, active: true, status: 'active' },
                  ],
                },
              ],
            },
          },
        }
      case 'session.text':
        if (state.gone) return { ok: false, error: `no such session: ${req.target}` }
        return { ok: true, result: { text: state.screen } }
      case 'session.new':
        state.mutations.push(req)
        return { ok: true, result: { id: SID } }
      case 'workspace.new':
        state.mutations.push(req)
        return { ok: true, result: { id: 'ws-2' } }
      default:
        state.mutations.push(req)
        return { ok: true, result: {} }
    }
  }
}

async function withTerm(fn, { state } = {}) {
  const box = state ?? { screen: 'hello screen', cwd: '/tmp/nowhere', mutations: [] }
  const fake = await fakeAgtermSocket(agtermScript(box))

  const dir = await mkdtemp(join(tmpdir(), 'planview-term-routes-'))
  const projectsDir = join(dir, 'projects')
  await mkdir(projectsDir, { recursive: true })
  const claudeMap = createClaudeMap({
    statePath: join(dir, 'claude-map.json'),
    projectsDir,
    psScan: async () => new Map(),
  })

  const term = createTerm({ agc: createAgc({ socketPath: fake.socketPath }), claudeMap })
  const server = createServer({ plansDir: FIXTURES, watch: false, term })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn({ base, box, fake, projectsDir, claudeMap })
  } finally {
    await server.shutdown()
    await fake.close()
  }
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  })

test('GET /api/term/tree returns the composed structure with the active session marked', async () => {
  await withTerm(async ({ base }) => {
    const res = await fetch(`${base}/api/term/tree`)
    const tree = await res.json()

    assert.equal(res.status, 200)
    assert.equal(tree.windows[0].id, WID)
    assert.equal(tree.windows[0].workspaces[0].sessions[0].id, SID)
    assert.equal(tree.activeSessionId, SID)
    assert.deepEqual(tree.pendingBySession, {})
  })
})

test('the tree maps a blocked session to its pending plan', async () => {
  await withTerm(async ({ base }) => {
    await post(base, '/api/pending', { planId: 'atomic-sparking-yeti', agtermSessionId: SID })
    const tree = await (await fetch(`${base}/api/term/tree`)).json()

    assert.deepEqual(tree.pendingBySession, { [SID]: 'atomic-sparking-yeti' })
  })
})

test('without a term, /api/term/* answers 503 and nothing else changes', async () => {
  const server = createServer({ plansDir: FIXTURES, watch: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const res = await fetch(`${base}/api/term/tree`)
    assert.equal(res.status, 503)
    assert.match((await res.json()).error, /not enabled/)
    assert.equal((await fetch(`${base}/api/plans`)).status, 200)
  } finally {
    await server.shutdown()
  }
})

test('a request under an unrecognized Host is refused before any route runs', async () => {
  await withTerm(async ({ base }) => {
    const { port } = new URL(base)
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/plans', headers: { host: 'evil.example.com' } },
        (res) => resolve(res.statusCode),
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  })
})

test('GET screen returns the live frame with a hash', async () => {
  await withTerm(async ({ base }) => {
    const res = await fetch(`${base}/api/term/sessions/${SID}/screen`)
    const frame = await res.json()

    assert.equal(res.status, 200)
    assert.equal(frame.text, 'hello screen')
    assert.match(frame.hash, /^[0-9a-f]{40}$/)
  })
})

test('a vanished session maps notFound to 404', async () => {
  const state = { screen: '', cwd: '/tmp/x', mutations: [], gone: true }
  await withTerm(
    async ({ base }) => {
      const res = await fetch(`${base}/api/term/sessions/${SID}/screen`)
      assert.equal(res.status, 404)
    },
    { state },
  )
})

test('POST type encodes text server-side and boosts nothing on error', async () => {
  await withTerm(async ({ base, box }) => {
    const ok = await post(base, `/api/term/sessions/${SID}/type`, {
      text: 'line one\nline two',
      mode: 'claude',
      submit: true,
    })
    assert.equal(ok.status, 200)
    const typed = box.mutations.find((m) => m.cmd === 'session.type')
    assert.equal(typed.target, SID)
    assert.equal(typed.args.text, 'line one\\\rline two\r')

    const bad = await post(base, `/api/term/sessions/${SID}/type`, { text: 'a\nb' })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /mode/)

    const badKey = await post(base, `/api/term/sessions/${SID}/type`, { keys: ['boom'] })
    assert.equal(badKey.status, 400)

    const badPane = await post(base, `/api/term/sessions/${SID}/type`, { text: 'x', pane: 'middle' })
    assert.equal(badPane.status, 400)
  })
})

test('named keys reach the wire as escape bytes', async () => {
  await withTerm(async ({ base, box }) => {
    await post(base, `/api/term/sessions/${SID}/type`, { keys: ['escape'] })
    await post(base, `/api/term/sessions/${SID}/type`, { keys: ['ctrl-c'] })

    const [esc, ctrlc] = box.mutations.filter((m) => m.cmd === 'session.type')
    assert.equal(esc.args.text, '\x1b')
    assert.equal(ctrlc.args.text, '\x03')
  })
})

test('a cross-site POST to any term mutation is refused', async () => {
  await withTerm(async ({ base, box }) => {
    for (const path of [`/api/term/sessions/${SID}/type`, `/api/term/sessions/${SID}/select`]) {
      const res = await post(base, path, { text: 'x' }, { 'sec-fetch-site': 'cross-site' })
      assert.equal(res.status, 403, path)
    }
    assert.deepEqual(box.mutations, [])
  })
})

test('session ops go to the wire with explicit uuid targets', async () => {
  await withTerm(async ({ base, box }) => {
    await post(base, `/api/term/sessions/${SID}/select`, {})
    await post(base, `/api/term/sessions/${SID}/seen`, {})
    await post(base, `/api/term/sessions/${SID}/rename`, { name: 'renamed' })
    await post(base, `/api/term/sessions/${SID}/flag`, { mode: 'on' })

    const cmds = box.mutations.map((m) => [m.cmd, m.target])
    assert.deepEqual(cmds, [
      ['session.select', SID],
      ['session.seen', SID],
      ['session.rename', SID],
      ['session.flag', SID],
    ])
    assert.equal(box.mutations[2].args.name, 'renamed')
    assert.equal(box.mutations[3].args.mode, 'on')
  })
})

test('closing needs an explicit confirm', async () => {
  await withTerm(async ({ base, box }) => {
    const refused = await post(base, `/api/term/sessions/${SID}/close`, {})
    assert.equal(refused.status, 400)
    assert.equal(box.mutations.length, 0)

    const ok = await post(base, `/api/term/sessions/${SID}/close`, { confirm: true })
    assert.equal(ok.status, 200)
    assert.equal(box.mutations[0].cmd, 'session.close')
  })
})

test('creating a session forwards the camelCase wire args agtermctl uses', async () => {
  await withTerm(async ({ base, box }) => {
    const res = await post(base, '/api/term/sessions', {
      cwd: '/tmp/proj',
      workspaceName: 'work',
      name: 'fresh',
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { id: SID })

    const created = box.mutations.find((m) => m.cmd === 'session.new')
    assert.deepEqual(created.args, {
      cwd: '/tmp/proj',
      workspaceName: 'work',
      createWorkspace: true,
      name: 'fresh',
    })
  })
})

test('an invalid session id never reaches the socket', async () => {
  await withTerm(async ({ base, box }) => {
    const res = await post(base, '/api/term/sessions/active/select', {})
    assert.equal(res.status, 400)
    assert.deepEqual(box.mutations, [])
  })
})

test('history serves shaped entries once the hook has registered the transcript', async () => {
  await withTerm(async ({ base, box, projectsDir }) => {
    // The transcript must live under the projects dir and match the session's cwd slug.
    box.cwd = '/tmp/proj'
    const projectDir = join(projectsDir, '-tmp-proj')
    await mkdir(projectDir, { recursive: true })
    const path = join(projectDir, `${CLAUDE}.jsonl`)
    const { readFile } = await import('node:fs/promises')
    await writeFile(path, await readFile(TRANSCRIPT_FIXTURE))

    const registered = await post(base, '/api/term/claude-session', {
      agtermSessionId: SID,
      claudeSessionId: CLAUDE,
      transcriptPath: path,
      cwd: '/tmp/proj',
    })
    assert.equal(registered.status, 200)

    const res = await fetch(`${base}/api/term/sessions/${SID}/history?limit=100`)
    const history = await res.json()

    assert.equal(res.status, 200)
    assert.equal(history.source.confidence, 'hook')
    assert.equal(history.source.claudeSessionId, CLAUDE)
    assert.deepEqual(
      history.entries.map((e) => e.uuid),
      ['u1', 'a1', 'u2', 'a2', 'u3'],
    )
  })
})

test('history for an unmapped session is a 404 with a reason', async () => {
  await withTerm(async ({ base }) => {
    const res = await fetch(`${base}/api/term/sessions/${SID}/history`)
    assert.equal(res.status, 404)
    assert.match((await res.json()).error, /no transcript/)
  })
})

// The first chunk of an SSE response is often just the `retry:` line; data arrives whenever the
// server has some. Read complete blocks until one matches, bounded so a broken stream fails fast.
async function readSse(res, until, timeoutMs = 5000) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const step = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), deadline - Date.now())),
    ])
    if (step === 'timeout' || step.done) break
    buffer += decoder.decode(step.value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() // an incomplete trailing block stays in the buffer
    for (const block of blocks) {
      if (!block.startsWith('data: ')) continue
      const parsed = JSON.parse(block.slice(6))
      if (until(parsed)) return parsed
    }
  }
  throw new Error('no matching SSE data arrived in time')
}

test('the term SSE stream opens with the agterm reachability', async () => {
  await withTerm(async ({ base }) => {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/term/events`, { signal: controller.signal })
    assert.match(res.headers.get('content-type'), /text\/event-stream/)

    const hello = await readSse(res, (m) => m.type === 'agterm')
    assert.equal(typeof hello.up, 'boolean')
    controller.abort()
  })
})

test('the screen stream delivers the first frame and stops on disconnect', async () => {
  await withTerm(async ({ base }) => {
    const controller = new AbortController()
    const res = await fetch(`${base}/api/term/sessions/${SID}/screen/stream`, { signal: controller.signal })

    const frame = await readSse(res, (m) => typeof m.text === 'string')
    assert.equal(frame.text, 'hello screen')
    controller.abort()
  })
})
