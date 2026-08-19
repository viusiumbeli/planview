import { api } from '../lib/api.js'

/**
 * The input row, which owns one question: what happens when you press a key.
 *
 *   ✎ message — the textarea. Enter sends, Shift+Enter breaks a line; multi-line is the SERVER's
 *               problem (it types Claude's backslash+Return continuations), so the box sends real
 *               newlines. Optimistic: it clears on send and the draft returns on failure.
 *   ⌨ keys    — every keystroke goes straight into the session; the textarea steps aside for a
 *               strip saying so, and the frame does the capturing (see screen.js).
 */
export function createComposer({
  form,
  textarea,
  sendButton,
  note,
  modeButtons,
  keysStrip,
  getSid,
  onKeysMode,
}) {
  const autoGrow = () => {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`
  }
  textarea.addEventListener('input', autoGrow)

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  /* ---------- modes ---------- */

  let keysMode = false

  const paint = (sessionName) => {
    modeButtons.message.classList.toggle('selected', !keysMode)
    modeButtons.keys.classList.toggle('selected', keysMode)
    form.classList.toggle('keys-mode', keysMode)
    textarea.hidden = keysMode
    sendButton.hidden = keysMode
    keysStrip.hidden = !keysMode
    if (keysMode) {
      keysStrip.textContent =
        `клавиши идут прямо в ${sessionName || 'сессию'} · Shift+PgUp/PgDn — прокрутка · клик мимо выключает`
    } else {
      textarea.focus({ preventScroll: true })
    }
  }

  // The frame is the thing that captures keys, so it owns the mode; these buttons only ask.
  modeButtons.message.addEventListener('click', () => onKeysMode(false))
  modeButtons.keys.addEventListener('click', () => onKeysMode(true))
  // Clicking the strip must not pull focus off the frame, or the mode would end on the click.
  keysStrip.addEventListener('mousedown', (event) => event.preventDefault())
  keysStrip.addEventListener('click', () => onKeysMode(true))

  /* ---------- sending ---------- */

  let sending = false

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const sid = getSid()
    const text = textarea.value
    if (keysMode || !sid || !text.trim() || sending) return

    sending = true
    sendButton.disabled = true
    textarea.value = ''
    autoGrow()
    note.className = ''
    note.textContent = 'отправляю…'

    try {
      await api.type(sid, { text, submit: true, mode: 'claude' })
      // The next frame showing the prompt echoed in the TUI is the real confirmation.
      note.textContent = ''
    } catch (err) {
      textarea.value = text
      autoGrow()
      note.className = 'error'
      note.textContent = err.message
    } finally {
      sending = false
      sendButton.disabled = false
    }
  })

  paint('')

  return {
    /** screen.js reports the truth about the mode; the row renders it. */
    setKeysMode(on, sessionName) {
      keysMode = on
      paint(sessionName)
    },
  }
}
