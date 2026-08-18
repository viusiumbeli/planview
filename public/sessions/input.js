import { api } from '../lib/api.js'

/**
 * The composer: writing a prompt to the session's agent. Enter sends, Shift+Enter breaks a line —
 * multi-line is the SERVER's problem (it types Claude's backslash+Return continuations), the
 * textarea just sends real newlines. Optimistic: the box clears on send and the draft comes back
 * on failure, with the server's reason shown.
 */
export function createComposer({ form, textarea, sendButton, note, getSid }) {
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

  let sending = false

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const sid = getSid()
    const text = textarea.value
    if (!sid || !text.trim() || sending) return

    sending = true
    sendButton.disabled = true
    textarea.value = ''
    autoGrow()
    note.className = ''
    note.textContent = 'sending…'

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

  return {
    focus: () => textarea.focus(),
  }
}
