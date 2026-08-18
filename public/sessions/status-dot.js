// The agent-status glyph, shared by the session tree and the session header so both always tell
// the same story: idle hollow, active pulsing, blocked waiting for you, completed done.

export const dotClass = (node) =>
  `dot ${node?.status ?? 'idle'}${node?.statusBlink ? ' blink' : ''}`
