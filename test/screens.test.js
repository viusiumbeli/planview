import test from 'node:test'
import assert from 'node:assert/strict'

import { createScreens } from '../src/screens.js'
import { AgcError } from '../src/agc.js'

const SESSION = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'

// session.text answers from a mutable `screen` box; every call is counted.
function fakeAgc(box) {
  const calls = []
  return {
    calls,
    async request(cmd, options) {
      calls.push({ cmd, ...options })
      if (box.error) throw box.error
      return { text: box.text }
    },
  }
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const fastScreens = (agc) =>
  createScreens({ agc, activeMs: 10, idleMs: 10, boostMs: 5, errorMs: 10, lines: 60 })

test('the first subscriber gets the first frame; identical frames are not re-pushed', async () => {
  const box = { text: 'frame one' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  const frames = []
  const unsubscribe = screens.subscribe(SESSION, {}, (f) => frames.push(f))
  await tick()

  assert.equal(frames.length, 1)
  assert.equal(frames[0].text, 'frame one')
  assert.ok(agc.calls.length > 1, 'kept polling')

  box.text = 'frame two'
  await tick()
  unsubscribe()

  assert.equal(frames.length, 2)
  assert.equal(frames[1].text, 'frame two')
})

test('a second subscriber shares the poller and gets the held frame immediately', async () => {
  const box = { text: 'shared' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  const a = []
  const b = []
  const ua = screens.subscribe(SESSION, {}, (f) => a.push(f))
  await tick()
  const ub = screens.subscribe(SESSION, {}, (f) => b.push(f))

  assert.equal(b.length, 1, 'held frame arrives synchronously')
  assert.equal(b[0].text, 'shared')

  ua()
  ub()
})

test('the last unsubscribe stops the poller', async () => {
  const box = { text: 'x' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  const unsubscribe = screens.subscribe(SESSION, {}, () => {})
  await tick()
  unsubscribe()
  const after = agc.calls.length
  await tick()

  assert.equal(agc.calls.length, after, 'no polls after the last unsubscribe')
})

test('a vanished session pushes a terminal gone frame and stops', async () => {
  const box = { text: 'x' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  const frames = []
  screens.subscribe(SESSION, {}, (f) => frames.push(f))
  await tick()
  box.error = new AgcError('notFound', 'no such session')
  await tick()
  const after = agc.calls.length
  await tick()

  assert.ok(frames.some((f) => f.gone), 'gone frame delivered')
  assert.equal(agc.calls.length, after, 'poller stopped')
})

test('a transient failure keeps polling instead of giving up', async () => {
  const box = { text: 'x' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  const frames = []
  const unsubscribe = screens.subscribe(SESSION, {}, (f) => frames.push(f))
  await tick()
  box.error = new AgcError('down', 'agterm is not running')
  await tick()
  box.error = null
  box.text = 'recovered'
  await tick(40)
  unsubscribe()

  assert.equal(frames.at(-1).text, 'recovered')
})

test('frame() serves a fresh cached frame without another read, and reads when stale', async () => {
  const box = { text: 'cached' }
  const agc = fakeAgc(box)
  const screens = createScreens({ agc, activeMs: 60_000, idleMs: 60_000, lines: 60 })

  const unsubscribe = screens.subscribe(SESSION, {}, () => {})
  await tick()
  const polls = agc.calls.length
  const cached = await screens.frame(SESSION, {})
  assert.equal(cached.text, 'cached')
  assert.equal(agc.calls.length, polls, 'served from the live poller')

  // A different line count cannot be served from the poller's frame.
  await screens.frame(SESSION, { lines: 10 })
  assert.equal(agc.calls.at(-1).args.lines, 10)
  unsubscribe()
})

test('the requested pane rides along to session.text', async () => {
  const box = { text: 'x' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  const unsubscribe = screens.subscribe(SESSION, { pane: 'scratch' }, () => {})
  await tick()
  unsubscribe()

  assert.equal(agc.calls[0].args.pane, 'scratch')
})

test('stopAll halts every poller', async () => {
  const box = { text: 'x' }
  const agc = fakeAgc(box)
  const screens = fastScreens(agc)

  screens.subscribe(SESSION, {}, () => {})
  screens.subscribe(SESSION, { pane: 'right' }, () => {})
  await tick()
  screens.stopAll()
  const after = agc.calls.length
  await tick()

  assert.equal(agc.calls.length, after)
})
