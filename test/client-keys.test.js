import test from 'node:test'
import assert from 'node:assert/strict'

import { keydownToToken, scrollGesture } from '../public/lib/keys.js'

const key = (key, mods = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

test('named keys become the tokens the server knows', () => {
  assert.equal(keydownToToken(key('Enter')), 'enter')
  assert.equal(keydownToToken(key('Escape')), 'escape')
  assert.equal(keydownToToken(key('ArrowUp')), 'up')
  assert.equal(keydownToToken(key('Backspace')), 'backspace')
  assert.equal(keydownToToken(key('Tab', { shiftKey: true })), 'shift-tab')
})

test('printable characters of any script pass through', () => {
  assert.equal(keydownToToken(key('a')), 'a')
  assert.equal(keydownToToken(key('Ж')), 'Ж')
  assert.equal(keydownToToken(key(' ')), ' ')
})

test('ctrl chords are forwarded; meta and alt belong to the browser and the OS', () => {
  assert.equal(keydownToToken(key('c', { ctrlKey: true })), 'ctrl-c')
  assert.equal(keydownToToken(key('c', { metaKey: true })), null)
  assert.equal(keydownToToken(key('ArrowUp', { altKey: true })), null)
  // A ctrl chord on something that is not a letter has no byte to send.
  assert.equal(keydownToToken(key('F5', { ctrlKey: true })), null)
})

test('keys with no terminal meaning are dropped rather than guessed', () => {
  for (const name of ['F5', 'CapsLock', 'Shift', 'Insert']) {
    assert.equal(keydownToToken(key(name)), null, name)
  }
})

test('shift + paging scrolls the feed — the xterm convention for scrollback', () => {
  assert.equal(scrollGesture(key('PageUp', { shiftKey: true })), 'page-up')
  assert.equal(scrollGesture(key('PageDown', { shiftKey: true })), 'page-down')
  assert.equal(scrollGesture(key('Home', { shiftKey: true })), 'top')
  assert.equal(scrollGesture(key('End', { shiftKey: true })), 'bottom')
})

test('unshifted paging is the TUI\'s own, so it is never stolen for scrolling', () => {
  // Claude Code and other TUIs bind these; the feed only claims the shifted variants.
  for (const name of ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp']) {
    assert.equal(scrollGesture(key(name)), null, name)
  }
  // Still forwarded as keystrokes, which is the point.
  assert.equal(keydownToToken(key('PageUp')), 'pageup')
})

test('a scroll gesture needs shift ALONE — no ctrl, meta or alt riding along', () => {
  assert.equal(scrollGesture(key('PageUp', { shiftKey: true, ctrlKey: true })), null)
  assert.equal(scrollGesture(key('PageUp', { shiftKey: true, metaKey: true })), null)
  assert.equal(scrollGesture(key('PageUp', { shiftKey: true, altKey: true })), null)
})
