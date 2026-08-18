// keydown → the named token the server's keys.js understands. PURE — covered by node --test.
//
// Named tokens, never raw bytes: the server owns the escape-sequence table and validates against
// it, so this mapping can afford to drop anything it does not recognise.

const NAMED = {
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
}

export function keydownToToken({ key, ctrlKey, metaKey, altKey, shiftKey }) {
  // Meta/alt chords belong to the browser and the OS, not the terminal.
  if (metaKey || altKey) return null
  if (ctrlKey) return /^[a-z]$/.test(key) ? `ctrl-${key}` : null
  if (key === 'Tab' && shiftKey) return 'shift-tab'
  if (NAMED[key]) return NAMED[key]
  // A single printable character, any script — shift is already applied by the browser.
  if ([...key].length === 1) return key
  return null
}
