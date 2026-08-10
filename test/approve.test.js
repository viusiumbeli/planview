import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createServer } from '../src/server.js'
import { createPending } from '../src/pending.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures/plans')
const SESSION = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'
const PLAN = 'atomic-sparking-yeti'
const DOWN = '\x1b[B'

// The real captured prompt: cursor on 1, options "Yes, and use auto mode" / "Yes, manually approve
// edits" / "Tell Claude what to change".
const READY = readFileSync(join(HERE, 'fixtures/plan-prompt.txt'), 'utf8')
const ANSWERED = '~/personal/planview $ npm test\nall good\n'

/** Records every agtermctl call so a test can assert that nothing was typed. */
function fakeAgterm({ screen = READY, typeOk = true } = {}) {
  const calls = []
  return {
    calls,
    typed: () => calls.filter((c) => c.cmd === 'type'),
    text: async (entry) => {
      calls.push({ cmd: 'text', entry })
      return screen
    },
    type: async (entry, keys) => {
      calls.push({ cmd: 'type', entry, keys })
      return { ok: typeOk, error: typeOk ? undefined : 'session is gone' }
    },
  }
}

async function withServer(fn, { agterm = fakeAgterm(), pending = createPending() } = {}) {
  const server = createServer({ plansDir: FIXTURES, watch: false, agterm, pending })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn({ base, agterm, pending })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    server.stopWatching?.()
  }
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(body),
  })

const register = (base, planId = PLAN) =>
  post(base, '/api/pending', { planId, agtermSessionId: SESSION, agtermPane: 'left' })

const approve = (base, token, ordinal, label) =>
  post(base, '/api/approve', { planId: PLAN, token, ordinal, label })

test('the hook registers a pending approval and gets a token back', async () => {
  await withServer(async ({ base }) => {
    const res = await register(base)
    const { token } = await res.json()

    assert.equal(res.status, 200)
    assert.match(token, /^[0-9a-f]{32}$/)
  })
})

test('/api/plans offers the options actually on screen, not hardcoded ones', async () => {
  await withServer(async ({ base }) => {
    const before = await (await fetch(`${base}/api/plans`)).json()
    assert.deepEqual(before.awaiting, {})

    const { token } = await (await register(base)).json()
    const after = await (await fetch(`${base}/api/plans`)).json()

    assert.equal(after.awaiting[PLAN].token, token)
    assert.deepEqual(
      after.awaiting[PLAN].options.map((o) => o.label),
      ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'],
    )
    assert.equal(after.awaiting[PLAN].selected, 1)
  })
})

test('/api/plans offers no options when the prompt cannot be read, so no buttons are drawn', async () => {
  const agterm = fakeAgterm({ screen: ANSWERED })
  await withServer(
    async ({ base }) => {
      await register(base)
      const tree = await (await fetch(`${base}/api/plans`)).json()

      assert.deepEqual(tree.awaiting[PLAN].options, [])
    },
    { agterm },
  )
})

test('the hook is refused when its agterm target is not a uuid', async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, '/api/pending', { planId: PLAN, agtermSessionId: 'active; rm -rf /' })

    assert.equal(res.status, 400)
  })
})

test('approving sends the keystrokes that land on the chosen option', async () => {
  await withServer(async ({ base, agterm }) => {
    const { token } = await (await register(base)).json()
    const res = await approve(base, token, 3, 'Tell Claude what to change')

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { chose: 'Tell Claude what to change' })

    const [typed] = agterm.typed()
    assert.equal(typed.keys, `${DOWN}${DOWN}\r`)
    assert.equal(typed.entry.sessionId, SESSION)
    assert.equal(typed.entry.pane, 'left')
  })
})

test('approving the already-selected option submits without moving the cursor', async () => {
  await withServer(async ({ base, agterm }) => {
    const { token } = await (await register(base)).json()
    await approve(base, token, 1, 'Yes, and use auto mode')

    assert.equal(agterm.typed()[0].keys, '\r')
  })
})

test('a label that no longer matches the prompt is refused, and nothing is typed', async () => {
  // The exact bug that broke the first version: the button said "auto-accept edits" while the prompt
  // offered "and use auto mode". Refusing beats approving something else.
  await withServer(async ({ base, agterm }) => {
    const { token } = await (await register(base)).json()
    const res = await approve(base, token, 1, 'Yes, auto-accept edits')

    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /now reads "Yes, and use auto mode"/)
    assert.deepEqual(agterm.typed(), [])
  })
})

test('a prompt already answered in the terminal is refused, and nothing is typed', async () => {
  const agterm = fakeAgterm({ screen: ANSWERED })
  await withServer(
    async ({ base }) => {
      const { token } = await (await register(base)).json()
      const res = await approve(base, token, 1, 'Yes, and use auto mode')

      assert.equal(res.status, 409)
      assert.match((await res.json()).error, /no longer on screen/)
      assert.deepEqual(agterm.typed(), [])
    },
    { agterm },
  )
})

test('an unreadable session is refused, and nothing is typed', async () => {
  const agterm = fakeAgterm({ screen: null })
  await withServer(
    async ({ base }) => {
      const { token } = await (await register(base)).json()
      const res = await approve(base, token, 1, 'Yes, and use auto mode')

      assert.equal(res.status, 409)
      assert.match((await res.json()).error, /could not read/i)
      assert.deepEqual(agterm.typed(), [])
    },
    { agterm },
  )
})

test('an ordinal the prompt does not offer is refused, and nothing is typed', async () => {
  await withServer(async ({ base, agterm }) => {
    const { token } = await (await register(base)).json()
    const res = await approve(base, token, 7, undefined)

    assert.equal(res.status, 409)
    assert.deepEqual(agterm.typed(), [])
  })
})

test('a wrong token is refused, and nothing is typed', async () => {
  await withServer(async ({ base, agterm }) => {
    await register(base)
    const res = await approve(base, 'deadbeef', 1, 'Yes, and use auto mode')

    assert.equal(res.status, 403)
    assert.deepEqual(agterm.typed(), [])
  })
})

test('a token is single-use, so a double click cannot answer twice', async () => {
  await withServer(async ({ base, agterm }) => {
    const { token } = await (await register(base)).json()

    assert.equal((await approve(base, token, 1, 'Yes, and use auto mode')).status, 200)
    assert.equal((await approve(base, token, 1, 'Yes, and use auto mode')).status, 403)
    assert.equal(agterm.typed().length, 1)
  })
})

test('a cross-site request is refused, and nothing is typed', async () => {
  await withServer(async ({ base, agterm }) => {
    const { token } = await (await register(base)).json()
    const res = await post(
      base,
      '/api/approve',
      { planId: PLAN, token, ordinal: 1, label: 'Yes, and use auto mode' },
      { 'sec-fetch-site': 'cross-site' },
    )

    assert.equal(res.status, 403)
    assert.deepEqual(agterm.typed(), [])
  })
})

test('every rejection carries a JSON reason the browser can show', async () => {
  // Sending these as text/plain made the client's res.json() throw, so the UI could only say
  // "failed (400)" — which is what made a stale-cache bug expensive to find.
  await withServer(async ({ base }) => {
    const { token } = await (await register(base)).json()

    const cases = [
      ['bad ordinal', approve(base, token, 0, 'x')],
      ['stale token', approve(base, 'deadbeef', 1, 'x')],
      ['wrong label', approve(base, token, 1, 'Yes, auto-accept edits')],
      ['bad target', post(base, '/api/pending', { planId: PLAN, agtermSessionId: 'nope' })],
    ]

    for (const [name, request] of cases) {
      const res = await request

      assert.match(res.headers.get('content-type') ?? '', /application\/json/, name)
      assert.equal(typeof (await res.json()).error, 'string', name)
    }
  })
})

test('a nonsense ordinal is refused before the token is even spent', async () => {
  await withServer(async ({ base, agterm, pending }) => {
    const { token } = await (await register(base)).json()

    for (const ordinal of [0, -1, 999, 1.5, '1', null]) {
      assert.equal((await approve(base, token, ordinal, 'x')).status, 400, `ordinal ${ordinal}`)
    }
    assert.deepEqual(agterm.typed(), [])
    // Still live, so it can be approved properly.
    assert.ok(pending.get(PLAN, Date.now()))
  })
})

test('approving a plan nothing is waiting on is refused', async () => {
  await withServer(async ({ base, agterm }) => {
    const res = await approve(base, 'x', 1, 'Yes, and use auto mode')

    assert.equal(res.status, 403)
    assert.deepEqual(agterm.typed(), [])
  })
})

test('a failure from agtermctl is reported rather than swallowed', async () => {
  const agterm = fakeAgterm({ typeOk: false })
  await withServer(
    async ({ base }) => {
      const { token } = await (await register(base)).json()
      const res = await approve(base, token, 1, 'Yes, and use auto mode')

      assert.equal(res.status, 502)
      assert.match((await res.json()).error, /session is gone/)
    },
    { agterm },
  )
})

test('malformed json is refused', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/approve`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
      body: 'not json',
    })

    assert.equal(res.status, 400)
  })
})

test('GET on the approve endpoint is rejected', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/approve`)).status, 405)
  })
})
