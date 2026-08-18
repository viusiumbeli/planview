import { createHash } from 'node:crypto'

/**
 * Live screen mirroring: ref-counted pollers over `session.text`, one per (session, pane) that at
 * least one browser is actually watching. There is no terminal-output stream in agterm — polling
 * flattened frames is the only read path — so the poller's job is making that cheap: frames are
 * hash-diffed (identical frames cost subscribers nothing), the cadence follows how alive the
 * session looks, and an unwatched session is never polled at all.
 */
export function createScreens({
  agc,
  lines = 200,
  activeMs = 500,
  idleMs = 2000,
  boostMs = 300,
  boostWindowMs = 5000,
  errorMs = 3000,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const entries = new Map()
  const hints = new Map() // sessionId → {status, blink} fed by the pump

  const keyOf = (sessionId, pane) => `${sessionId}:${pane ?? ''}`

  const busyHint = (sessionId) => {
    const hint = hints.get(sessionId)
    return Boolean(hint && (hint.blink || hint.status === 'active'))
  }

  const cadence = (entry, framesMoving) => {
    if (now() < entry.boostUntil) return boostMs
    return framesMoving || busyHint(entry.sessionId) ? activeMs : idleMs
  }

  const push = (entry, frame) => {
    for (const fn of entry.subscribers) {
      try {
        fn(frame)
      } catch {
        // one broken subscriber must not starve the rest
      }
    }
  }

  const remove = (entry) => {
    entry.stopped = true
    if (entry.timer) clearTimeoutFn(entry.timer)
    entry.timer = null
    entries.delete(keyOf(entry.sessionId, entry.pane))
  }

  const schedule = (entry, ms) => {
    if (entry.stopped) return
    if (entry.timer) clearTimeoutFn(entry.timer)
    entry.timer = setTimeoutFn(() => {
      entry.timer = null
      poll(entry)
    }, ms)
  }

  async function poll(entry) {
    if (entry.stopped || entry.polling) return
    entry.polling = true
    try {
      const result = await agc.request('session.text', {
        target: entry.sessionId,
        args: { lines, pane: entry.pane },
      })
      if (entry.stopped) return

      const text = result.text ?? ''
      const hash = createHash('sha1').update(text).digest('hex')
      const changed = hash !== entry.lastHash
      entry.at = now()
      if (changed) {
        entry.lastHash = hash
        entry.lastText = text
        push(entry, { text, hash, at: entry.at })
      }
      // Two identical frames in a row on a quiet session → decay to the idle cadence.
      const framesMoving = changed || entry.prevChanged
      entry.prevChanged = changed
      schedule(entry, cadence(entry, framesMoving))
    } catch (err) {
      if (entry.stopped) return
      if (err?.code === 'notFound') {
        // The session is gone for good; a terminal frame tells every watcher why the stream ended.
        push(entry, { gone: true, at: now() })
        remove(entry)
        return
      }
      schedule(entry, errorMs)
    } finally {
      entry.polling = false
    }
  }

  // A pending long wait is cut short when something suggests the screen is moving again.
  const nudge = (entry, ms = 50) => {
    if (entry.stopped || entry.polling) return
    if (entry.timer) schedule(entry, ms)
  }

  const entriesOf = (sessionId) => [...entries.values()].filter((e) => e.sessionId === sessionId)

  return {
    /**
     * Watch a (session, pane). The current frame, if one is already held, arrives synchronously;
     * the returned function unsubscribes, and the last unsubscribe stops the poller.
     */
    subscribe(sessionId, { pane } = {}, onFrame) {
      const key = keyOf(sessionId, pane)
      let entry = entries.get(key)
      if (!entry) {
        entry = {
          sessionId,
          pane,
          subscribers: new Set(),
          timer: null,
          polling: false,
          stopped: false,
          lastText: null,
          lastHash: null,
          prevChanged: false,
          at: 0,
          boostUntil: 0,
        }
        entries.set(key, entry)
        poll(entry)
      } else if (entry.lastText !== null) {
        onFrame({ text: entry.lastText, hash: entry.lastHash, at: entry.at })
      }
      entry.subscribers.add(onFrame)
      return () => {
        entry.subscribers.delete(onFrame)
        if (!entry.subscribers.size) remove(entry)
      }
    },

    /** One frame now. Served from a live poller when fresh enough, else read directly. */
    async frame(sessionId, { pane, lines: wantLines } = {}) {
      const entry = entries.get(keyOf(sessionId, pane))
      const usable = entry && entry.lastText !== null && (!wantLines || wantLines === lines)
      if (usable && now() - entry.at < activeMs) {
        return { text: entry.lastText, hash: entry.lastHash, at: entry.at }
      }
      const result = await agc.request('session.text', {
        target: sessionId,
        args: { lines: wantLines ?? lines, pane },
      })
      const text = result.text ?? ''
      return { text, hash: createHash('sha1').update(text).digest('hex'), at: now() }
    },

    /** The pump's status events land here so a working session is polled at the fast cadence. */
    setHint(sessionId, { status, blink } = {}) {
      const wasBusy = busyHint(sessionId)
      hints.set(sessionId, { status, blink })
      if (!wasBusy && busyHint(sessionId)) {
        for (const entry of entriesOf(sessionId)) nudge(entry)
      }
    },

    /** Right after input is typed the next frames matter most — echo should feel immediate. */
    boost(sessionId) {
      for (const entry of entriesOf(sessionId)) {
        entry.boostUntil = now() + boostWindowMs
        nudge(entry)
      }
    },

    stopAll() {
      for (const entry of [...entries.values()]) remove(entry)
    },
  }
}
