import { api } from '../lib/api.js'
import { connectSse } from '../lib/bus.js'
import { renderMarkdown } from '../lib/markdown.js'
import { createApprove } from './approve.js'
import { createComposer } from './input.js'
import { createScreen } from './screen.js'
import { createScrollback } from './scrollback.js'
import { dotClass } from './status-dot.js'
import { createSessionTree } from './tree.js'

/**
 * The whole page: agterm's sessions, the feed of the one you are looking at, and the plans that
 * appear inside that feed. FULL-mirror semantics, as chosen: the page shows the ACTIVE agterm
 * session; clicking a session here selects it in the desktop app, and selecting one in the desktop
 * app steers this page. The web page is the terminal window, not a second one.
 */
export async function initSessions({ awaiting }) {
  const el = (id) => document.getElementById(id)
  const sessTree = el('sess-tree')
  const offline = el('agterm-offline')
  const dot = el('sess-dot')
  const title = el('sess-title')
  const meta = el('sess-meta')
  const approveStrip = el('approve-strip')
  const approvePlan = el('approve-plan')
  const menuButton = el('sess-menu-button')
  const menu = el('sess-menu')

  let snapshot = { windows: [], activeSessionId: null, pendingBySession: {} }
  let viewSid = null
  let shownPlanId = null
  let seenTimer = null

  /* ---------- components ---------- */

  const tree = createSessionTree({
    container: sessTree,
    onPick: pick,
    onNew: async () => {
      // A new session next to the current one, seeded with its directory — no dialog to dismiss.
      try {
        await api.newSession({ cwd: nodeOf(viewSid)?.cwd })
      } catch (err) {
        composerNote(err.message)
      }
    },
  })

  // The past (transcript log) and the live frame share one scroll container — the unified feed.
  const scrollback = createScrollback({
    container: el('term-scroll'),
    past: el('past'),
    topSentinel: el('past-top'),
    pill: el('live-pill'),
    note: el('feed-note'),
  })

  const screen = createScreen({
    frame: el('frame'),
    statusEl: el('frame-status'),
    paneChips: el('pane-chips'),
    keyPad: [
      [el('key-up'), 'up'],
      [el('key-down'), 'down'],
      [el('key-enter'), 'enter'],
      [el('key-esc'), 'escape'],
      [el('key-ctrlc'), 'ctrl-c'],
      [el('key-shift-tab'), 'shift-tab'],
    ],
    noteError: composerNote,
    withPin: (mutate) => scrollback.withPin(mutate),
    getBusy: () => {
      const node = nodeOf(viewSid)
      return Boolean(node && (node.status === 'active' || node.statusBlink))
    },
  })

  createComposer({
    form: el('composer'),
    textarea: el('composer-input'),
    sendButton: el('composer-send'),
    note: el('composer-note'),
    getSid: () => viewSid,
  })

  const approveChip = createApprove({
    note: el('approve-note'),
    buttons: el('approve-buttons'),
  })

  function composerNote(message) {
    const note = el('composer-note')
    note.className = 'error'
    note.textContent = message
  }

  /* ---------- data ---------- */

  const nodeOf = (sid) => {
    for (const window of snapshot.windows) {
      for (const workspace of window.workspaces) {
        for (const session of workspace.sessions) if (session.id === sid) return session
      }
    }
    return null
  }

  async function refreshTree() {
    let data
    try {
      data = await api.tree()
    } catch {
      offline.hidden = false
      return
    }
    offline.hidden = true
    snapshot = data
    tree.render(data, { activeSessionId: data.activeSessionId, pendingBySession: data.pendingBySession })

    // The mirror follows agterm: whatever is active there is what this page shows.
    if (data.activeSessionId && data.activeSessionId !== viewSid) {
      show(data.activeSessionId)
    } else {
      renderCurrent()
      // A split appearing, a rename, a pane change — the open panels re-sync to the fresh node.
      syncPanels()
    }
  }

  function pick(sid) {
    // Full mirror: picking here selects in the desktop app too. Optimistically switch now; the
    // tree.changed event confirms (or corrects) us.
    api.select(sid).catch((err) => composerNote(err.message))
    show(sid)
  }

  function show(sid) {
    viewSid = sid
    renderCurrent()
    syncPanels()
    clearTimeout(seenTimer)
    seenTimer = setTimeout(() => {
      if (viewSid === sid && (nodeOf(sid)?.unseen ?? 0) > 0) api.seen(sid).catch(() => {})
    }, 1000)
  }

  /* ---------- rendering ---------- */

  function renderCurrent() {
    const node = nodeOf(viewSid)
    if (!node) {
      dot.className = 'dot'
      title.textContent = viewSid ? 'session not in the tree' : 'no session'
      title.removeAttribute('title')
      meta.replaceChildren()
      menuButton.hidden = true
      closeMenu()
      approveStrip.hidden = true
      return
    }

    dot.className = dotClass(node)
    dot.title = `${node.status ?? 'idle'}${node.statusBlink ? ' · blink' : ''}`
    title.textContent = node.name || node.id.slice(0, 8)
    // Everything that used to fill a whole column now lives in one tooltip.
    title.title = [node.title, node.cwd, node.id].filter(Boolean).join('\n')
    menuButton.hidden = false

    const parts = [['cwd', node.cwd ?? ''], ['fg', (node.foreground ?? []).join(' ') || 'shell']]
    meta.replaceChildren(
      ...parts.map(([kind, text]) => {
        const span = document.createElement('span')
        span.className = kind === 'cwd' ? 'cwd' : ''
        span.textContent = text
        return span
      }),
      ...(node.flagged ? [Object.assign(document.createElement('span'), { className: 'flagmark', textContent: '⚑' })] : []),
      ...(node.unseen ? [Object.assign(document.createElement('span'), { className: 'unseen', textContent: String(node.unseen) })] : []),
    )

    if (!menu.hidden) renderMenu(node)
    renderApprove()
  }

  /* ---------- actions menu ---------- */

  // Rare actions do not deserve permanent screen space, so they live behind ⋯ in the header.
  function renderMenu(node) {
    menu.replaceChildren()

    const item = (label, onClick) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'menu-item'
      button.textContent = label
      button.addEventListener('click', onClick)
      menu.append(button)
      return button
    }

    const run = async (action) => {
      try {
        await action()
        closeMenu()
      } catch (err) {
        composerNote(err.message)
        closeMenu()
      }
    }

    item('переименовать', () => {
      const input = document.createElement('input')
      input.className = 'rename-input'
      input.value = node.name ?? ''
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') return renderMenu(node)
        if (event.key === 'Enter') run(() => api.rename(node.id, input.value.trim()))
      })
      menu.replaceChildren(input)
      input.focus()
      input.select()
    })

    item(node.flagged ? 'снять флаг' : 'пометить флагом ⚑', () => run(() => api.flag(node.id, 'toggle')))
    if (node.unseen) item('сбросить бейдж', () => run(() => api.seen(node.id)))

    // Two-step close: the first click arms, the second within 3s fires. No native dialogs.
    const close = item('закрыть сессию', () => {
      if (!close.classList.contains('armed')) {
        close.classList.add('armed')
        close.textContent = 'точно закрыть?'
        setTimeout(() => {
          if (!close.isConnected) return
          close.classList.remove('armed')
          close.textContent = 'закрыть сессию'
        }, 3000)
        return
      }
      run(() => api.close(node.id))
    })
  }

  function closeMenu() {
    menu.hidden = true
    menuButton.classList.remove('selected')
  }

  menuButton.addEventListener('click', (event) => {
    event.stopPropagation()
    if (!menu.hidden) return closeMenu()
    const node = nodeOf(viewSid)
    if (!node) return
    renderMenu(node)
    menu.hidden = false
    menuButton.classList.add('selected')
  })

  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      // Escape only reaches here while the menu is open; in keys mode the frame has focus and
      // Escape belongs to the terminal.
      event.stopPropagation()
      closeMenu()
    }
  })

  function renderApprove() {
    const planId = snapshot.pendingBySession?.[viewSid]
    const entry = awaiting.get(planId)
    const wasHidden = approveStrip.hidden
    approveStrip.hidden = !entry

    if (!entry) {
      approveChip.clear()
      approvePlan.replaceChildren()
      shownPlanId = null
      scrollback.setPendingPlan(null)
      return
    }

    approveChip.render({ id: planId }, entry)
    scrollback.setPendingPlan(planId)
    // Appearing grows the feed; if the reader was at the bottom, keep them there.
    if (wasHidden) scrollback.withPin(() => {})
    // The terminal frame only ever shows the tail of a plan, so the plan itself comes along in
    // full — scrolling up from the buttons then walks the plan, not somebody's history. Guarded by
    // id because /api/plans refreshes every 800ms while the options are still being read.
    if (planId === shownPlanId) return
    shownPlanId = planId
    fetch(`/api/plan?id=${encodeURIComponent(planId)}`)
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        if (shownPlanId !== planId) return
        // No plan file (it can be deleted) — the buttons still work, which is what matters.
        approvePlan.replaceChildren(...(text ? [planLabel(), renderMarkdown(text)] : []))
        if (text) scrollback.withPin(() => {})
      })
      .catch(() => {})
  }

  function planLabel() {
    const label = document.createElement('div')
    label.className = 'plan-label'
    label.textContent = 'plan · ждёт ответа'
    return label
  }

  /* ---------- the one panel ---------- */

  function syncPanels() {
    if (document.visibilityState === 'visible' && viewSid) {
      screen.show(viewSid, nodeOf(viewSid))
      scrollback.show(viewSid)
    } else {
      screen.hide()
      scrollback.hide()
    }
  }

  /* ---------- live events ---------- */

  connectSse('/api/term/events', {
    onOpen: refreshTree,
    onMessage: (msg) => {
      if (msg.type === 'session.status') {
        tree.patchStatus(msg)
        const node = nodeOf(msg.sessionId)
        if (node) {
          node.status = msg.status
          node.statusBlink = msg.blink
          if (msg.name) node.name = msg.name
        }
        if (msg.sessionId === viewSid) {
          if (msg.name) title.textContent = msg.name
          dot.className = dotClass({ status: msg.status, statusBlink: msg.blink })
          dot.title = `${msg.status ?? 'idle'}${msg.blink ? ' · blink' : ''}`
          // active↔idle flips how much of the live frame shows, even without a new frame.
          screen.rerender()
        }
        return
      }
      if (msg.type === 'tree.changed' || msg.type === 'notify') return void refreshTree()
      if (msg.type === 'reset') {
        // The event ring was lost — everything known may be stale. Full resync.
        refreshTree()
        screen.reopen()
        return
      }
      if (msg.type === 'agterm') {
        offline.hidden = msg.up
        if (msg.up) refreshTree()
      }
    },
    onDown: () => {
      offline.hidden = false
    },
  })

  // The approve chip's options are read live off the terminal and arrive via /api/plans.
  awaiting.onUpdate(renderApprove)

  document.addEventListener('visibilitychange', syncPanels)

  /* ---------- keyboard: j/k walk, n = next needing attention ---------- */

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (target.closest?.('input, textarea, [contenteditable]')) return

    if (event.key === 'j' || event.key === 'k') {
      const ids = tree.flatIds()
      if (!ids.length) return
      const at = Math.max(0, ids.indexOf(viewSid))
      const next = ids[(at + (event.key === 'j' ? 1 : ids.length - 1)) % ids.length]
      pick(next)
    }
    if (event.key === 'n') {
      const ids = tree.flatIds()
      const at = Math.max(0, ids.indexOf(viewSid))
      const ordered = [...ids.slice(at + 1), ...ids.slice(0, at + 1)]
      const next = ordered.find((id) => ['blocked', 'completed'].includes(tree.statusOf(id)))
      if (next) pick(next)
    }
  })

  /* ---------- mode lifecycle ---------- */

  await refreshTree()

  return { refreshTree }
}
