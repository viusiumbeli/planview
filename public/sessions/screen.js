import { api } from '../lib/api.js'
import { store } from '../lib/store.js'

const timeOf = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/**
 * The live frame: one EventSource per shown (session, pane), frames swapped into a <pre> only when
 * they changed (the server hash-diffs, so every message IS a change), plus the key pad — one click,
 * one keystroke, which is all a menu on the terminal's screen needs.
 */
export function createScreen({
  frame,
  statusEl,
  paneChips,
  keyPad,
  noteError,
  withPin = (fn) => fn(),
  getBusy = () => false,
}) {
  const paneStore = store('planview.pane')

  // The feed above the frame already tells the story of everything COMPLETED, so the frame only
  // contributes its bottom: the input box while idle, plus the in-flight streaming while the agent
  // works. It is never uncropped — a plan is read in full above, not as a cut-off second copy.
  const CROP_ACTIVE = 30
  const CROP_IDLE = 12

  let sid = null
  let events = null
  let lastAt = 0
  let lastFullText = null
  let panes = ['left']
  let mirrored = true

  const cropped = () => {
    if (lastFullText === null) return null
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

  /* ---------- key pad ---------- */

  let chain = Promise.resolve()

  for (const [button, key] of keyPad) {
    // Not stealing focus keeps the composer's caret where it was, so a menu answered mid-sentence
    // does not cost you the sentence.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      if (!sid) return
      const target = sid
      // Serialised: the next POST waits for the previous, so two fast clicks keep their order.
      chain = chain
        .then(() => api.type(target, { key }))
        .catch((err) => noteError?.(err.message))
    })
  }

  /* ---------- lifecycle ---------- */

  return {
    show(nextSid, node) {
      const changed = nextSid !== sid
      sid = nextSid
      panes = ['left', ...(node?.split ? ['right'] : []), ...(node?.scratch ? ['scratch'] : [])]
      renderPanes()
      if (changed) {
        frame.textContent = ''
        frame.classList.remove('gone')
        lastAt = 0
        lastFullText = null
      }
      if (changed || !events) openStream()
      tickStatus()
    },

    hide() {
      closeStream()
      tickStatus()
    },

    reopen() {
      if (sid) openStream()
    },

    /** Re-crop from the held frame — the busy hint flipped without a new frame arriving. */
    rerender: render,

    /**
     * Hide the frame while the page offers the very same prompt as buttons: mirroring it too shows
     * the question twice, with the cut-off tail of the plan and the prompt box's blank rows in
     * between. Polling keeps running, so the frame is current the moment it comes back.
     */
    setMirrored(on) {
      if (on === mirrored) return
      mirrored = on
      frame.hidden = !on
    },
  }
}
