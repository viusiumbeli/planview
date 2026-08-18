import test from 'node:test'
import assert from 'node:assert/strict'

import { createTreeCache, activeSessionOf } from '../src/tree-cache.js'

const WID = 'CF859395-8AFF-4E69-AC65-105D183E5C16'
const CLOSED = '21CFFE2A-7A6F-45C0-9961-E9464C1BDC58'
const SID = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'

function fakeAgc() {
  const calls = []
  return {
    calls,
    async request(cmd, options = {}) {
      calls.push({ cmd, ...options })
      if (cmd === 'window.list') {
        return {
          windows: [
            { id: WID, name: 'window 1', open: true, active: true },
            { id: CLOSED, name: 'window 2', open: false, active: false },
          ],
        }
      }
      if (cmd === 'tree') {
        return {
          tree: {
            workspaces: [
              { id: 'ws', name: 'work', active: true, sessions: [{ id: SID, name: 's', active: true }] },
            ],
          },
        }
      }
      throw new Error(`unexpected ${cmd}`)
    },
  }
}

test('snapshot composes open windows and never asks about closed ones', async () => {
  // Asking `tree` for a closed window silently answers with the active window's tree, which would
  // duplicate every session in the snapshot.
  const agc = fakeAgc()
  const cache = createTreeCache({ agc })
  const snapshot = await cache.snapshot()

  assert.equal(snapshot.windows.length, 1)
  assert.equal(snapshot.windows[0].id, WID)
  assert.equal(snapshot.windows[0].workspaces[0].sessions[0].id, SID)
  assert.deepEqual(
    agc.calls.map((c) => c.cmd),
    ['window.list', 'tree'],
  )
  assert.equal(agc.calls[1].window, WID)
})

test('a burst of callers shares one wire round trip', async () => {
  const agc = fakeAgc()
  const cache = createTreeCache({ agc })

  const [a, b, c] = await Promise.all([cache.snapshot(), cache.snapshot(), cache.snapshot()])

  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(agc.calls.filter((call) => call.cmd === 'window.list').length, 1)
})

test('the cache serves within the TTL and refetches after invalidate', async () => {
  let clock = 1000
  const agc = fakeAgc()
  const cache = createTreeCache({ agc, staleMs: 2000, now: () => clock })

  await cache.snapshot()
  clock += 100
  await cache.snapshot()
  assert.equal(agc.calls.filter((call) => call.cmd === 'window.list').length, 1, 'served from cache')

  cache.invalidate()
  await cache.snapshot()
  assert.equal(agc.calls.filter((call) => call.cmd === 'window.list').length, 2, 'refetched')

  clock += 3000
  await cache.snapshot()
  assert.equal(agc.calls.filter((call) => call.cmd === 'window.list').length, 3, 'TTL expired')
})

test('a failed fetch is not cached as truth', async () => {
  let fails = 1
  const agc = {
    async request(cmd) {
      if (fails > 0 && cmd === 'window.list') {
        fails--
        throw new Error('boom')
      }
      if (cmd === 'window.list') return { windows: [{ id: WID, name: 'w', open: true, active: true }] }
      return { tree: { workspaces: [] } }
    },
  }
  const cache = createTreeCache({ agc })

  await assert.rejects(cache.snapshot(), /boom/)
  // allow the rejection handler to clear the poisoned entry
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = await cache.snapshot()
  assert.equal(snapshot.windows.length, 1)
})

test('activeSessionOf finds the active session in the active window', async () => {
  const agc = fakeAgc()
  const cache = createTreeCache({ agc })
  assert.equal(activeSessionOf(await cache.snapshot()), SID)
  assert.equal(activeSessionOf({ windows: [] }), null)
})
