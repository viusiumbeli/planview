import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createServer } from '../src/server.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/plans')

async function withServer(fn, options = {}) {
  const server = createServer({ plansDir: FIXTURES, watch: false, ...options })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    server.stopWatching?.()
  }
}

test('GET / serves the page as HTML', async () => {
  await withServer(async (base) => {
    const res = await fetch(base)

    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
  })
})

test('the page and its assets are sent no-store, so a reload really reloads', async () => {
  // A pinned tab caching an old app.js against a new server is not hypothetical: it produced a 400
  // when the client POSTed a request shape the server had stopped accepting.
  await withServer(async (base) => {
    for (const path of ['/', '/static/app.js', '/static/style.css']) {
      const res = await fetch(`${base}${path}`)

      assert.equal(res.status, 200, path)
      assert.match(res.headers.get('cache-control') ?? '', /no-store/, path)
    }
  })
})

test('GET /api/plans returns the grouped tree as JSON', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plans`)
    const tree = await res.json()

    assert.equal(res.status, 200)
    assert.ok(Array.isArray(tree.groups))
    assert.ok(Array.isArray(tree.older))
  })
})

test('GET /api/plans nests a subagent plan under its parent', async () => {
  await withServer(async (base) => {
    const tree = await (await fetch(`${base}/api/plans`)).json()
    const all = [...tree.groups.flatMap((g) => g.plans), ...tree.older]
    const yeti = all.find((p) => p.id === 'atomic-sparking-yeti')

    assert.equal(yeti.children[0].agentName, 'architect2')
  })
})

test('GET /api/plan returns the raw markdown of one plan', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plan?id=atomic-sparking-yeti`)
    const body = await res.text()

    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/markdown/)
    assert.match(body, /^# COMD-1436/)
  })
})

test('GET /api/plan rejects an id that escapes the plans directory', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plan?id=${encodeURIComponent('../../../etc/hosts')}`)

    assert.equal(res.status, 400)
  })
})

test('GET /api/plan reports a missing plan as 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/plan?id=does-not-exist`)

    assert.equal(res.status, 404)
  })
})

test('GET /events opens an SSE stream', async () => {
  await withServer(async (base) => {
    const controller = new AbortController()
    const res = await fetch(`${base}/events`, { signal: controller.signal })

    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    controller.abort()
  })
})

test('an unknown path is a 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404)
  })
})

test('shutdown completes while an SSE client is still connected', async () => {
  const server = createServer({ plansDir: FIXTURES, watch: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const res = await fetch(`${base}/events`)
  const reader = res.body.getReader()
  reader.read() // hold the stream open, as a pinned browser tab does

  const closed = await Promise.race([
    server.shutdown().then(() => 'closed'),
    new Promise((r) => setTimeout(() => r('timed out'), 2000)),
  ])

  assert.equal(closed, 'closed')
})
