import { api } from '../lib/api.js'

/**
 * The approve chip, extracted so the Plans header and the session rail mount the same logic.
 * Options are read off the live terminal, so the buttons say exactly what the prompt says. Their
 * wording varies by build and context, and guessing it is what broke the first attempt.
 */
export function createApprove({ note, buttons }) {
  function clear() {
    buttons.replaceChildren()
    note.textContent = ''
    note.className = ''
  }

  function render(plan, entry) {
    if (!entry) return clear()

    if (!entry.options?.length) {
      buttons.replaceChildren()
      note.className = ''
      note.textContent = 'reading the prompt…'
      return
    }

    note.textContent = 'waiting in the terminal'
    note.className = ''
    buttons.replaceChildren(
      ...entry.options.map((option) => {
        const button = document.createElement('button')
        // The option the prompt already has its cursor on is the one Enter would pick.
        button.className = `choice${option.selected ? ' primary' : ''}`
        button.textContent = option.label
        button.addEventListener('click', () => send(plan, entry.token, option))
        return button
      }),
    )
  }

  async function send(plan, token, option) {
    for (const button of buttons.querySelectorAll('button')) button.disabled = true
    note.textContent = 'sending…'

    try {
      // The label goes along so the server can refuse if the prompt changed since this was drawn.
      const { chose } = await api.approve(plan.id, token, option)
      note.textContent = `sent — ${chose ?? 'answered'}`
      buttons.replaceChildren()
    } catch (err) {
      // 409 is the expected, safe outcome when the prompt was already answered in the terminal.
      fail(err.message)
    }
  }

  function fail(message) {
    note.textContent = message
    note.className = 'error'
    buttons.replaceChildren()
  }

  return { render, clear }
}
