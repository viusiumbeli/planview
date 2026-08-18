// Browser input → the byte string session.type injects as keystrokes.
//
// The browser never sends raw escape bytes — it sends NAMED tokens ("enter", "ctrl-c", "up") or
// plain text, and the encoding lives here where it can fail closed: an unknown token is an error,
// not a guess, and control characters are stripped out of text so a page cannot smuggle an OSC
// sequence inside "plain words". The `key` path is the only way to produce an escape byte.

export const KEYS = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  backspace: '\x7f',
  delete: '\x1b[3~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  space: ' ',
}

const CTRL = /^ctrl-([a-z])$/

/** One token → its bytes, or null when the token is not something we are willing to type. */
export function encodeKey(token) {
  if (typeof token !== 'string' || !token) return null
  if (KEYS[token]) return KEYS[token]
  const ctrl = CTRL.exec(token)
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96)
  // A single printable character (any script) passes through — that is how raw-key mode types.
  if ([...token].length === 1 && !/[\x00-\x1f\x7f]/.test(token)) return token
  return null
}

/**
 * The /type request body → { data } to hand to session.type, or { error }.
 *
 * Exactly one of `text` or `key`/`keys` must be present. Multi-line text needs an explicit mode:
 * session.type submits the shared line buffer on every newline, so for a Claude Code session each
 * newline becomes backslash+Return (its line continuation — the worst failure is a visible stray
 * backslash, never a hidden submit), while mode "raw" keeps newline = submit for plain shells.
 */
export function encodeInput({ text, key, keys, mode, submit } = {}) {
  const wantsText = text !== undefined
  const wantsKeys = key !== undefined || keys !== undefined
  if (wantsText === wantsKeys) return { error: 'send either text or key/keys' }

  if (wantsKeys) {
    const tokens = keys !== undefined ? keys : [key]
    if (!Array.isArray(tokens) || !tokens.length) return { error: 'keys must be a non-empty array' }
    if (tokens.length > 64) return { error: 'too many keys in one request' }
    let data = ''
    for (const token of tokens) {
      const encoded = encodeKey(token)
      if (encoded === null) return { error: `unknown key ${JSON.stringify(token)}` }
      data += encoded
    }
    return { data }
  }

  if (typeof text !== 'string') return { error: 'text must be a string' }
  // Normalised first so a windows-style paste cannot sneak a bare \r past the newline handling.
  let clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  clean = clean.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

  if (clean.includes('\n')) {
    if (mode === 'claude') clean = clean.replaceAll('\n', '\\\r')
    else if (mode === 'raw') clean = clean.replaceAll('\n', '\r')
    else return { error: 'multi-line text needs mode "claude" or "raw"' }
  }

  return { data: submit ? `${clean}\r` : clean }
}
