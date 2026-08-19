import { api } from '../lib/api.js'
import { keydownToToken, scrollGesture } from '../lib/keys.js'
import { store } from '../lib/store.js'

const timeOf = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/**
 * The live frame: one EventSource per shown (session, pane), frames swapped into a <pre> only
 * when they changed (the server hash-diffs, so every message IS a change), plus the raw-key mode
 * that turns the frame into a keyboard hole straight into the terminal.
 */
export function createScreen({
  frame,
  statusEl,
  paneChips,
  quickKeys,
  noteError,
  onModeChange = () => {},
  onScrollFeed = () => {},
  withPin = (fn) => fn(),
  getBusy = () => false,
}) {
  const paneStore = store('planview.pane')

  // The feed above the frame already tells the story of everything COMPLETED, so the frame only
  // contributes its bottom: the input box while idle, plus the in-flight streaming while the agent
  // works. Raw mode uncrops — driving a TUI needs the whole screen.
  const CROP_ACTIVE = 30
  const CROP_IDLE = 12

  let sid = null
  let sessionName = ''
  let events = null
  let lastAt = 0
  let lastFullText = null
  let raw = false
  let rawIdleTimer = null
  let panes = ['left']

  const cropped = () => {
    if (lastFullText === null) return null
    if (raw) return lastFullText
    const lines = lastFullText.split('\n').slice(-(getBusy() ? CROP_ACTIVE : CROP_IDLE))
    while (lines.length && !lines[0].trim()) lines.shift()
    return lines.join('\n')
  }

  const render = () => {
    const text = cropped()
    if (text === null || frame.textContent === text) return
    // The frame lives at the bottom of the shared feed scroller; swapping its content changes the
    // feed's height, so the pin-to-bottom decision belongs to the feed, not to us.
    withPin(() => {
      frame.textContent = text
    })
  }

  /* ---------- stream ---------- */

  function openStream() {
    closeStream()
    if (!sid) return
    // With one pane, omitting the param reads the visible pane (== main). With several, the chip
    // choice must be explicit or "main" would silently follow the terminal's focus.
    const pane = panes.length > 1 ? currentPane() : null
    const url = `/api/term/sessions/${sid}/screen/stream${pane ? `?pane=${pane}` : ''}`
    // Native EventSource reconnection (the server sends retry: 1000) — a blip just goes stale
    // for a moment rather than tearing the view down.
    events = new EventSource(url)
    events.addEventListener('message', (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      if (data.gone) {
        frame.textContent = 'this session is gone'
        frame.classList.add('gone')
        return
      }
      frame.classList.remove('gone')
      lastAt = data.at
      lastFullText = data.text
      render()
      tickStatus()
    })
  }

  function closeStream() {
    events?.close()
    events = null
  }

  const connState = () => (events ? (events.readyState === EventSource.OPEN ? 'live' : 'connecting') : 'off')

  // Nothing to say while the mirror keeps up: a clock reading "all fine" is noise. It speaks only
  // when the frame has gone stale or the stream is reconnecting.
  function tickStatus() {
    if (!sid || !events) {
      statusEl.hidden = true
      return
    }
    if (connState() !== 'live') {
      statusEl.hidden = false
      statusEl.textContent = 'переподключение…'
      return
    }
    const age = lastAt ? Date.now() - lastAt : 0
    const stale = lastAt && age > 4000
    statusEl.hidden = !stale
    if (stale) statusEl.textContent = `кадр ${Math.round(age / 1000)}s назад · ${timeOf(lastAt)}`
  }
  setInterval(tickStatus, 1000)

  /* ---------- panes ---------- */

  const currentPane = () => {
    const saved = sid ? paneStore.get(sid) : null
    return panes.includes(saved) ? saved : 'left'
  }

  function renderPanes() {
    paneChips.replaceChildren()
    if (panes.length < 2) return
    for (const pane of panes) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = `chip${pane === currentPane() ? ' selected' : ''}`
      chip.textContent = pane === 'left' ? 'main' : pane === 'right' ? 'split' : 'scratch'
      chip.addEventListener('click', () => {
        paneStore.set(sid, pane)
        renderPanes()
        openStream()
      })
      paneChips.append(chip)
    }
  }

  /* ---------- raw keys ---------- */

  let queue = []
  let flushTimer = null
  let chain = Promise.resolve()

  const flush = () => {
    flushTimer = null
    if (!queue.length || !sid) return
    const batch = queue
    queue = []
    const target = sid
    // Serialised: the next POST waits for the previous, so keystroke order is guaranteed.
    chain = chain
      .then(() => api.type(target, { keys: batch }))
      .catch((err) => noteError?.(err.message))
  }

  const enqueue = (token) => {
    queue.push(token)
    if (queue.length >= 16) return flush()
    if (!flushTimer) flushTimer = setTimeout(flush, 50)
  }

  const armIdleDrop = () => {
    clearTimeout(rawIdleTimer)
    // A live shared buffer must not keep a silent hot mic.
    rawIdleTimer = setTimeout(() => setRaw(false), 60_000)
  }

  function setRaw(on) {
    raw = on
    frame.tabIndex = on ? 0 : -1
    frame.classList.toggle('raw-on', on)
    if (on) {
      // Plain focus() scrolls the frame into view, which threw the reader to the bottom of the feed
      // the moment they switched modes while reading a plan.
      frame.focus({ preventScroll: true })
      armIdleDrop()
    } else {
      clearTimeout(rawIdleTimer)
    }
    // The input row owns the "what happens when I type" question, so it renders the answer.
    onModeChange(on, sessionName)
    // Raw mode uncrops the frame (and leaving it re-crops).
    render()
  }

  frame.addEventListener('blur', () => setRaw(false))
  frame.addEventListener('keydown', (event) => {
    if (!raw) return
    // Reading the past has to stay possible while the keyboard belongs to the terminal.
    const gesture = scrollGesture(event)
    if (gesture) {
      event.preventDefault()
      armIdleDrop()
      onScrollFeed(gesture)
      return
    }
    // Escape passes THROUGH to the terminal (it is Claude's interrupt); leaving raw mode is a
    // click or the toggle, never a key the TUI might need.
    const token = keydownToToken(event)
    event.preventDefault()
    if (token) {
      enqueue(token)
      armIdleDrop()
    }
  })

  for (const [button, key] of quickKeys) {
    // Keeping focus on the frame is what lets Esc/^C work DURING keys mode instead of ending it.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      if (!sid) return
      api.type(sid, { key }).catch((err) => noteError?.(err.message))
    })
  }

  /* ---------- lifecycle ---------- */

  return {
    show(nextSid, node) {
      const changed = nextSid !== sid
      sid = nextSid
      sessionName = node?.name ?? ''
      panes = ['left', ...(node?.split ? ['right'] : []), ...(node?.scratch ? ['scratch'] : [])]
      renderPanes()
      if (changed) {
        frame.textContent = ''
        frame.classList.remove('gone')
        lastAt = 0
        lastFullText = null
        setRaw(false)
      }
      if (changed || !events) openStream()
      tickStatus()
    },

    hide() {
      closeStream()
      setRaw(false)
      tickStatus()
    },

    reopen() {
      if (sid) openStream()
    },

    /** Re-crop from the held frame — the busy hint flipped without a new frame arriving. */
    rerender: render,

    setRaw,
    rawActive: () => raw,
  }
}
