import test from 'node:test'
import assert from 'node:assert/strict'

import { encodeKey, encodeInput } from '../src/keys.js'

test('named keys map to their escape sequences', () => {
  assert.equal(encodeKey('enter'), '\r')
  assert.equal(encodeKey('escape'), '\x1b')
  assert.equal(encodeKey('up'), '\x1b[A')
  assert.equal(encodeKey('shift-tab'), '\x1b[Z')
  assert.equal(encodeKey('backspace'), '\x7f')
})

test('ctrl-<letter> is computed, not enumerated', () => {
  assert.equal(encodeKey('ctrl-c'), '\x03')
  assert.equal(encodeKey('ctrl-a'), '\x01')
  assert.equal(encodeKey('ctrl-z'), '\x1a')
})

test('single printable characters pass through, any script', () => {
  assert.equal(encodeKey('a'), 'a')
  assert.equal(encodeKey('п'), 'п')
  assert.equal(encodeKey('1'), '1')
})

test('unknown tokens and raw control bytes are refused', () => {
  for (const bad of ['ctrl-C', 'f13', 'meta-x', '\x1b', '\x03', 'ab', '', null, 7]) {
    assert.equal(encodeKey(bad), null, JSON.stringify(bad))
  }
})

test('a keys array concatenates in order', () => {
  assert.deepEqual(encodeInput({ keys: ['up', 'up', 'enter'] }), { data: '\x1b[A\x1b[A\r' })
  assert.deepEqual(encodeInput({ key: 'ctrl-c' }), { data: '\x03' })
})

test('one unknown key fails the whole request, nothing partial', () => {
  const out = encodeInput({ keys: ['up', 'nope', 'enter'] })
  assert.match(out.error, /unknown key "nope"/)
  assert.equal(out.data, undefined)
})

test('single-line text passes through, submit appends Return', () => {
  assert.deepEqual(encodeInput({ text: 'hello world' }), { data: 'hello world' })
  assert.deepEqual(encodeInput({ text: 'hello', submit: true }), { data: 'hello\r' })
})

test('multi-line text in claude mode becomes backslash+Return continuations', () => {
  // session.type submits the shared line buffer on every newline; backslash+Return is Claude
  // Code's line continuation, so the whole message lands in one input box unsubmitted.
  assert.deepEqual(encodeInput({ text: 'a\nb\nc', mode: 'claude' }), { data: 'a\\\rb\\\rc' })
  assert.deepEqual(encodeInput({ text: 'a\r\nb', mode: 'claude', submit: true }), { data: 'a\\\rb\r' })
})

test('multi-line text in raw mode keeps newline = submit', () => {
  assert.deepEqual(encodeInput({ text: 'ls\npwd', mode: 'raw' }), { data: 'ls\rpwd' })
})

test('multi-line text without a mode is refused, never guessed', () => {
  assert.match(encodeInput({ text: 'a\nb' }).error, /mode "claude" or "raw"/)
})

test('control characters are stripped from text — the key path is the only way to send escapes', () => {
  assert.deepEqual(encodeInput({ text: 'safe\x1b]0;evil\x07text' }), { data: 'safe]0;eviltext' })
  assert.deepEqual(encodeInput({ text: 'a\x03b' }), { data: 'ab' })
  // …but tabs survive: they are ordinary typing.
  assert.deepEqual(encodeInput({ text: 'a\tb' }), { data: 'a\tb' })
})

test('text and keys are mutually exclusive, and one of them is required', () => {
  assert.ok(encodeInput({ text: 'x', key: 'enter' }).error)
  assert.ok(encodeInput({}).error)
  assert.ok(encodeInput({ text: 42 }).error)
  assert.ok(encodeInput({ keys: [] }).error)
})
