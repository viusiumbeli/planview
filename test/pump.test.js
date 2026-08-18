import test from 'node:test'
import assert from 'node:assert/strict'

import { createPump } from '../src/pump.js'
import { AgcError } from '../src/agc.js'

// A scriptable agc: each call to request('events.read') shifts the next canned answer. An answer
// can be a result object or an AgcError to reject with.
function fakeAgc(answers) {
  const calls = []
  return {
    calls,
    socketPath: '(fake)',
    async request(cmd, options = {}) {
      calls.push({ cmd, ...options })
      const next = answers.shift()
      if (next === undefined) return new Promise(() => {}) // starve: the test is done observing
      if (next instanceof Error) throw next
      return next
    },
  }
}

const page = (run, next, items = []) => ({ events: { run, next, items } })

// Waits until the pump has settled by watching the call log grow quiet.
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

test('anchors without a cursor, then polls with run and a STRING cursor', async () => {
  const agc = fakeAgc([page('r1', 10), page('r1', 10)])
  const pump = createPump({ agc, emptyDelayMs: 5 })
  pump.start()
  await settle()
  pump.stop()

  assert.deepEqual(agc.calls[0], { cmd: 'events.read' })
  assert.deepEqual(agc.calls[1], { cmd: 'events.read', args: { run: 'r1', after: '10', limit: 500 } })
})

test('emits each item and repolls immediately after a non-empty page', async () => {
  const items = [
    { kind: 'status', seq: 11, session: 's1', payload: { status: 'active' } },
    { kind: 'tree.changed', seq: 12 },
  ]
  const agc = fakeAgc([page('r1', 10), page('r1', 12, items)])
  const pump = createPump({ agc, emptyDelayMs: 60_000 }) // an empty-page delay would stall the test
  const seen = []
  pump.on('event', (item) => seen.push(item))
  pump.start()
  await settle()
  pump.stop()

  assert.deepEqual(seen, items)
  // The poll after the non-empty page went out without waiting for the 60s empty delay.
  assert.equal(agc.calls.length >= 3, true)
  assert.equal(agc.calls[2].args.after, '12')
})

test('cursor loss emits reset BEFORE re-anchoring', async () => {
  const agc = fakeAgc([
    page('r1', 10),
    new AgcError('agterm', 'event run changed'),
    page('r2', 3),
  ])
  const pump = createPump({ agc, emptyDelayMs: 5 })
  const order = []
  pump.on('reset', ({ reason }) => order.push(`reset:${reason}`))
  pump.on('event', () => order.push('event'))
  pump.start()
  await settle()
  pump.stop()

  assert.deepEqual(order, ['reset:event run changed'])
  // After the reset the pump re-anchored: a fresh no-cursor read, then polling on the new run.
  assert.deepEqual(agc.calls[2], { cmd: 'events.read' })
  assert.equal(agc.calls[3].args.run, 'r2')
})

test('down → backoff and retry; recovery emits up then reset', async () => {
  const agc = fakeAgc([
    page('r1', 10),
    new AgcError('down', 'agterm is not running'),
    page('r2', 0),
    page('r2', 0),
  ])
  const pump = createPump({ agc, emptyDelayMs: 5, backoffMs: [5, 10] })
  const order = []
  pump.on('up', () => order.push('up'))
  pump.on('down', () => order.push('down'))
  pump.on('reset', () => order.push('reset'))
  pump.start()
  await settle(80)
  pump.stop()

  assert.deepEqual(order, ['up', 'down', 'up', 'reset'])
  assert.equal(pump.state().up, true)
})

test('state reports the cursor and the last error', async () => {
  const agc = fakeAgc([page('r1', 42)])
  const pump = createPump({ agc, emptyDelayMs: 60_000 })
  pump.start()
  await settle()
  const state = pump.state()
  pump.stop()

  assert.equal(state.running, true)
  assert.equal(state.run, 'r1')
  assert.equal(state.next, 42)
  assert.equal(state.lastError, null)
})

test('stop cuts a pending empty-page delay short', async () => {
  const agc = fakeAgc([page('r1', 10), page('r1', 10)])
  const pump = createPump({ agc, emptyDelayMs: 60_000 })
  pump.start()
  await settle()
  const before = Date.now()
  pump.stop()
  await settle(10)
  assert.ok(Date.now() - before < 1000)
  assert.equal(pump.state().running, false)
})
