import test from 'node:test'
import assert from 'node:assert/strict'

import { createPending, isSessionId } from '../src/pending.js'

const SESSION = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'
const NOW = 1_754_000_000_000

const entry = (planId = 'my-plan') => ({ planId, sessionId: SESSION, pane: 'left', paneId: 'tok' })

test('register returns a token and the entry reads back', () => {
  const pending = createPending()
  const token = pending.register(entry(), NOW)

  assert.match(token, /^[0-9a-f]{32}$/)
  assert.equal(pending.get('my-plan', NOW).sessionId, SESSION)
})

test('consume returns the entry and removes it, so a token is single-use', () => {
  const pending = createPending()
  const token = pending.register(entry(), NOW)

  assert.equal(pending.consume('my-plan', token, NOW).sessionId, SESSION)
  assert.equal(pending.consume('my-plan', token, NOW), null)
})

test('consume rejects a wrong token without discarding the entry', () => {
  // A stale browser tab must not be able to cancel a prompt that is genuinely waiting.
  const pending = createPending()
  const token = pending.register(entry(), NOW)

  assert.equal(pending.consume('my-plan', 'nope', NOW), null)
  assert.equal(pending.consume('my-plan', token, NOW).sessionId, SESSION)
})

test('consume rejects a missing token', () => {
  const pending = createPending()
  pending.register(entry(), NOW)

  assert.equal(pending.consume('my-plan', undefined, NOW), null)
  assert.equal(pending.consume('my-plan', '', NOW), null)
})

test('an entry expires after 30 minutes', () => {
  const pending = createPending()
  const token = pending.register(entry(), NOW)

  assert.ok(pending.get('my-plan', NOW + 29 * 60_000))
  assert.equal(pending.get('my-plan', NOW + 31 * 60_000), undefined)
  assert.equal(pending.consume('my-plan', token, NOW + 31 * 60_000), null)
})

test('several plans can await approval at once', () => {
  const pending = createPending()
  pending.register(entry('plan-a'), NOW)
  pending.register(entry('plan-b'), NOW)

  assert.deepEqual(pending.ids(NOW).sort(), ['plan-a', 'plan-b'])
})

test('ids omits expired entries', () => {
  const pending = createPending()
  pending.register(entry('plan-a'), NOW)
  pending.register(entry('plan-b'), NOW + 20 * 60_000)

  assert.deepEqual(pending.ids(NOW + 31 * 60_000), ['plan-b'])
})

test('register refuses an agterm target that is not a UUID', () => {
  // This value is the only variable that reaches agtermctl's argv.
  const pending = createPending()

  assert.equal(pending.register({ planId: 'p', sessionId: 'active; rm -rf /' }, NOW), null)
  assert.equal(pending.register({ planId: 'p', sessionId: '' }, NOW), null)
  assert.equal(pending.get('p', NOW), undefined)
})

test('register refuses a missing plan id', () => {
  const pending = createPending()

  assert.equal(pending.register({ planId: '', sessionId: SESSION }, NOW), null)
})

test('register drops a pane role it does not recognise', () => {
  const pending = createPending()
  pending.register({ ...entry(), pane: 'sideways' }, NOW)

  assert.equal(pending.get('my-plan', NOW).pane, undefined)
})

test('isSessionId accepts a UUID and rejects anything else', () => {
  assert.equal(isSessionId(SESSION), true)
  assert.equal(isSessionId(SESSION.toLowerCase()), true)
  assert.equal(isSessionId('active'), false)
  assert.equal(isSessionId(`${SESSION} --socket /tmp/x`), false)
  assert.equal(isSessionId(undefined), false)
})
