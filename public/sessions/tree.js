import { store } from '../lib/store.js'
import { dotClass } from './status-dot.js'

/**
 * The sidebar session tree: windows → workspaces → sessions, with the live status dot, unseen
 * badge, flag and awaiting markers. Rebuilt whole on tree changes (it is dozens of rows and the
 * collapse state lives in localStorage, so rebuilds are loss-free); status flips patch in place.
 */
export function createSessionTree({ container, onPick, onNew }) {
  const collapsed = store('planview.ws-collapsed')
  let extras = { activeSessionId: null, pendingBySession: {} }

  function sessionButton(session) {
    const button = document.createElement('button')
    button.className = `session${session.id === extras.activeSessionId ? ' selected' : ''}`
    button.dataset.sid = session.id
    button.title = session.title ?? session.name ?? ''

    const dot = document.createElement('span')
    dot.className = dotClass(session)
    button.append(dot)

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = session.name || session.title || session.id.slice(0, 8)
    button.append(name)

    const marks = document.createElement('span')
    marks.className = 'marks'
    if (extras.pendingBySession[session.id]) {
      const awaiting = document.createElement('span')
      awaiting.className = 'badge awaiting'
      awaiting.textContent = 'awaiting'
      marks.append(awaiting)
    }
    if (session.flagged) {
      const flag = document.createElement('span')
      flag.className = 'flagmark'
      flag.textContent = '⚑'
      marks.append(flag)
    }
    if (session.unseen) {
      const unseen = document.createElement('span')
      unseen.className = 'unseen'
      unseen.textContent = String(session.unseen)
      marks.append(unseen)
    }
    button.append(marks)

    button.addEventListener('click', () => onPick(session.id))
    return button
  }

  function workspaceSection(workspace) {
    const details = document.createElement('details')
    details.className = 'group'
    details.open = !collapsed.get(workspace.id)

    const summary = document.createElement('summary')
    summary.textContent = `${workspace.name} (${workspace.sessions.length})`
    details.append(summary)
    details.addEventListener('toggle', () => collapsed.set(workspace.id, !details.open))

    for (const session of workspace.sessions) details.append(sessionButton(session))
    return details
  }

  return {
    render(snapshot, nextExtras) {
      extras = nextExtras
      container.replaceChildren()

      for (const window of snapshot.windows) {
        // The window level only earns a row when there is more than one window to tell apart.
        if (snapshot.windows.length > 1) {
          const label = document.createElement('div')
          label.className = 'window-label'
          label.textContent = window.name
          container.append(label)
        }
        for (const workspace of window.workspaces) container.append(workspaceSection(workspace))
      }

      const create = document.createElement('button')
      create.className = 'new-session'
      create.textContent = '+ new session'
      create.addEventListener('click', onNew)
      container.append(create)
    },

    /** A status event patches the row in place — no refetch, no rebuild. */
    patchStatus({ sessionId, status, blink, name }) {
      const button = container.querySelector(`[data-sid="${sessionId}"]`)
      if (!button) return
      button.querySelector('.dot').className = dotClass({ status, statusBlink: blink })
      if (name) button.querySelector('.name').textContent = name
    },

    /** Flat session order, for j/k navigation. */
    flatIds() {
      return [...container.querySelectorAll('[data-sid]')].map((el) => el.dataset.sid)
    },

    statusOf(sid) {
      const dot = container.querySelector(`[data-sid="${sid}"] .dot`)
      return dot ? dot.className.replace(/^dot\s*/, '').replace(/\s*blink$/, '') || 'idle' : 'idle'
    },
  }
}
