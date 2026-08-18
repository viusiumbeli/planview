import { api } from '../lib/api.js'
import { connectSse } from '../lib/bus.js'
import { createApprove } from './approve.js'
import { createComposer } from './input.js'
import { createScreen } from './screen.js'
import { createScrollback } from './scrollback.js'
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
  const title = el('sess-title')
  const meta = el('sess-meta')
  const info = el('sess-info')
  const approveStrip = el('approve-strip')
  const actions = el('sess-actions')

  let snapshot = { windows: [], activeSessionId: null, pendingBySession: {} }
  let viewSid = null
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
    mapNote: el('map-note'),
  })

  const screen = createScreen({
    frame: el('frame'),
    ageEl: el('frame-age'),
    paneChips: el('pane-chips'),
    rawToggle: el('raw-toggle'),
    rawBanner: el('raw-banner'),
    quickKeys: [
      [el('key-esc'), 'escape'],
      [el('key-ctrlc'), 'ctrl-c'],
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
      title.textContent = viewSid ? 'session not in the tree' : 'no session'
      meta.replaceChildren()
      info.replaceChildren()
      actions.replaceChildren()
      approveStrip.hidden = true
      return
    }

    title.textContent = node.name || node.id.slice(0, 8)
    title.title = node.title ?? ''
    meta.replaceChildren()
    const cwd = document.createElement('span')
    cwd.className = 'cwd'
    cwd.textContent = node.cwd ?? ''
    const fg = document.createElement('span')
    fg.textContent = (node.foreground ?? []).join(' ')
    meta.append(cwd, fg)

    renderInfo(node)
    renderActions(node)
    renderApprove()
  }

  function renderInfo(node) {
    info.replaceChildren()
    const rows = [
      ['status', `${node.status ?? 'idle'}${node.statusBlink ? ' · blink' : ''}`],
      ['cwd', node.cwd ?? '—', 'mono'],
      ['running', (node.foreground ?? []).join(' ') || 'shell', 'mono'],
      ...(node.unseen ? [['unseen', String(node.unseen)]] : []),
      ...(node.flagged ? [['flagged', 'yes']] : []),
      ['id', node.id.slice(0, 8), 'mono'],
    ]
    for (const [term, value, cls] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = term
      const dd = document.createElement('dd')
      if (cls) dd.className = cls
      dd.textContent = value
      info.append(dt, dd)
    }
  }

  function renderActions(node) {
    actions.replaceChildren()

    const chip = (label, onClick) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'chip'
      button.textContent = label
      button.addEventListener('click', onClick)
      actions.append(button)
      return button
    }

    chip('rename', () => {
      const input = document.createElement('input')
      input.className = 'rename-input'
      input.value = node.name ?? ''
      input.addEventListener('keydown', async (event) => {
        if (event.key === 'Escape') return renderActions(node)
        if (event.key !== 'Enter') return
        try {
          await api.rename(node.id, input.value.trim())
        } catch (err) {
          composerNote(err.message)
        }
        renderActions(node)
      })
      actions.replaceChildren(input)
      input.focus()
      input.select()
    })

    chip(node.flagged ? 'unflag' : 'flag ⚑', async () => {
      try {
        await api.flag(node.id, 'toggle')
      } catch (err) {
        composerNote(err.message)
      }
    })

    if (node.unseen) {
      chip('mark seen', async () => {
        try {
          await api.seen(node.id)
        } catch (err) {
          composerNote(err.message)
        }
      })
    }

    // Two-step close: the first click arms, the second within 3s fires. No native dialogs.
    const close = chip('close session', async () => {
      if (!close.classList.contains('armed')) {
        close.classList.add('armed')
        close.textContent = 'really close?'
        setTimeout(() => {
          close.classList.remove('armed')
          close.textContent = 'close session'
        }, 3000)
        return
      }
      try {
        await api.close(node.id)
      } catch (err) {
        composerNote(err.message)
      }
    })
  }

  function renderApprove() {
    const planId = snapshot.pendingBySession?.[viewSid]
    const entry = awaiting.get(planId)
    const wasHidden = approveStrip.hidden
    approveStrip.hidden = !entry
    if (entry) {
      approveChip.render({ id: planId }, entry)
      // Appearing grows the feed; if the reader was at the bottom, keep them there.
      if (wasHidden) scrollback.withPin(() => {})
    } else {
      approveChip.clear()
    }
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
          renderInfo(nodeOf(viewSid) ?? {})
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
    if (screen.rawActive()) return

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
