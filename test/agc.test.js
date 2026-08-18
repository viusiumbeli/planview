import test from 'node:test'
import assert from 'node:assert/strict'

import { createAgc, AgcError } from '../src/agc.js'
import { fakeAgtermSocket } from './helpers/fake-agterm.js'

const SESSION = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'

async function withFake(script, fn, options = {}) {
  const fake = await fakeAgtermSocket(script)
  const agc = createAgc({ socketPath: fake.socketPath, ...options })
  try {
    return await fn({ agc, fake })
  } finally {
    await fake.close()
  }
}

test('a request resolves with the result of an ok response', async () => {
  await withFake(
    () => ({ ok: true, result: { windows: [{ id: 'w1' }] } }),
    async ({ agc, fake }) => {
      const result = await agc.request('window.list')

      assert.deepEqual(result, { windows: [{ id: 'w1' }] })
      assert.deepEqual(fake.requests, [{ cmd: 'window.list' }])
    },
  )
})

test('args are coerced to the wire types the socket demands', async () => {
  // {"lines":"3"} is an invalid request and {"after":2650} likewise — the cursor is a string while
  // limit is an int. The client owns that knowledge so no route can get it wrong.
  await withFake(
    () => ({ ok: true, result: {} }),
    async ({ agc, fake }) => {
      await agc.request('events.read', { args: { run: 'r', after: 2650, limit: 5 } })
      await agc.request('session.text', { target: SESSION, args: { lines: 60, all: true, pane: 'left' } })

      assert.deepEqual(fake.requests[0].args, { run: 'r', after: '2650', limit: 5 })
      assert.deepEqual(fake.requests[1].args, { lines: 60, all: true, pane: 'left' })
    },
  )
})

test('a wrongly typed arg is refused before it reaches the wire', async () => {
  await withFake(
    () => ({ ok: true, result: {} }),
    async ({ agc, fake }) => {
      await assert.rejects(agc.request('session.text', { target: SESSION, args: { lines: '60' } }), /integer/)
      await assert.rejects(agc.request('session.text', { target: SESSION, args: { all: 'yes' } }), /boolean/)
      await assert.rejects(agc.request('session.text', { target: SESSION, args: { nonsense: 1 } }), /unknown agterm arg/)
      assert.deepEqual(fake.requests, [])
    },
  )
})

test('the target=active footgun is closed at the transport', async () => {
  // The wire's default target is whatever session the user has focused in the GUI — never what a
  // server acting for a browser means.
  await withFake(
    () => ({ ok: true, result: {} }),
    async ({ agc, fake }) => {
      for (const target of ['active', 'B1453195', 'B1453195-E3AC-4E14-8069; rm -rf /']) {
        await assert.rejects(agc.request('session.select', { target }), (err) => err.code === 'badRequest')
      }
      assert.deepEqual(fake.requests, [])
    },
  )
})

test('undefined args are dropped rather than sent as null', async () => {
  await withFake(
    () => ({ ok: true, result: {} }),
    async ({ agc, fake }) => {
      await agc.request('session.text', { target: SESSION, args: { lines: 60, pane: undefined } })

      assert.deepEqual(fake.requests[0].args, { lines: 60 })
      assert.equal('window' in fake.requests[0], false)
    },
  )
})

test('error responses map onto the taxonomy routes translate to HTTP', async () => {
  const cases = [
    ['no such session: 00000000', 'notFound'],
    ['ambiguous target: 2 candidates', 'ambiguous'],
    ["invalid request: The data couldn't be read", 'badRequest'],
    ['something exploded', 'agterm'],
  ]
  for (const [message, code] of cases) {
    await withFake(
      () => ({ ok: false, error: message }),
      async ({ agc }) => {
        await assert.rejects(agc.request('tree'), (err) => {
          assert.ok(err instanceof AgcError, message)
          assert.equal(err.code, code, message)
          return true
        })
      },
    )
  }
})

test('a missing socket reports agterm as down', async () => {
  const agc = createAgc({ socketPath: '/tmp/planview-no-such-socket.sock' })

  await assert.rejects(agc.request('tree'), (err) => err.code === 'down')
})

test('a server that never answers times out instead of hanging', async () => {
  const fake = await fakeAgtermSocket(() => new Promise(() => {}))
  const agc = createAgc({ socketPath: fake.socketPath, timeoutMs: 80 })
  try {
    await assert.rejects(agc.request('tree'), (err) => err.code === 'timeout')
  } finally {
    await fake.close()
  }
})

test('a response without a trailing newline still resolves', async () => {
  // The real server hangs up after answering; the newline is a courtesy, not the framing.
  const net = await import('node:net')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(tmpdir(), `agc-noln-${process.pid}.sock`)
  const server = net.createServer((socket) => {
    socket.on('data', () => socket.end('{"ok":true,"result":{"x":1}}'))
  })
  await new Promise((resolve) => server.listen(path, resolve))
  const agc = createAgc({ socketPath: path })
  try {
    assert.deepEqual(await agc.request('tree'), { x: 1 })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
