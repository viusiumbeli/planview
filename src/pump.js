import { EventEmitter } from 'node:events'

import { AgcError } from './agc.js'

/**
 * The event pump: one polling loop over agterm's event ring (`events.read`).
 *
 * The ring is a pull-based cursor scoped to one run of the app: read again immediately after a
 * non-empty page, wait after an empty one. A cursor failure ("event run changed", "cursor
 * expired", "cursor ahead") is a data-loss boundary — the events in the gap are unrecoverable — so
 * it is SURFACED as a 'reset' the browsers answer with a full resync, never silently rebased.
 *
 * Emits:
 *   'event'  — one translated-ready ring item {kind, seq, ts, window, workspace, session, payload}
 *   'reset'  — {reason}: drop everything you know and refetch
 *   'up' / 'down' — agterm reachability flipped
 */
export function createPump({
  agc,
  emptyDelayMs = 250,
  backoffMs = [1000, 5000],
  limit = 500,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const emitter = new EventEmitter()

  let running = false
  let run = null
  let next = null
  let up = false
  let lastError = null
  let timer = null
  let wake = null

  const delay = (ms) =>
    new Promise((resolve) => {
      wake = resolve
      timer = setTimeoutFn(() => {
        timer = null
        wake = null
        resolve()
      }, ms)
    })

  const cancelDelay = () => {
    if (timer) clearTimeoutFn(timer)
    timer = null
    wake?.()
    wake = null
  }

  const isCursorLoss = (err) =>
    err instanceof AgcError && /run changed|cursor expired|cursor.*ahead/i.test(err.message)

  async function loop() {
    let failures = 0
    // After losing the ring (agterm restart, cursor loss while down) the next successful anchor
    // owes the browsers a reset: the world may have changed arbitrarily in the gap.
    let oweReset = null

    while (running) {
      try {
        if (run === null) {
          const { events } = await agc.request('events.read')
          run = events.run
          next = events.next
          failures = 0
          lastError = null
          if (!up) {
            up = true
            emitter.emit('up')
          }
          if (oweReset) {
            const reason = oweReset
            oweReset = null
            emitter.emit('reset', { reason })
          }
          continue
        }

        const { events } = await agc.request('events.read', {
          args: { run, after: String(next), limit },
        })
        next = events.next
        failures = 0
        for (const item of events.items) emitter.emit('event', item)
        if (!events.items.length && running) await delay(emptyDelayMs)
      } catch (err) {
        if (!running) break
        lastError = String(err?.message ?? err)

        if (isCursorLoss(err)) {
          // Reset FIRST, then re-anchor: the order is the contract — clients must know the gap
          // exists before they see events from the new subscription.
          run = null
          emitter.emit('reset', { reason: lastError })
          continue
        }

        // down/timeout/anything unexpected: back off and retry forever — agterm restarts happen.
        if (up) {
          up = false
          emitter.emit('down')
        }
        run = null
        oweReset = lastError
        failures++
        await delay(backoffMs[Math.min(failures - 1, backoffMs.length - 1)])
      }
    }
  }

  return Object.assign(emitter, {
    start() {
      if (running) return
      running = true
      loop().catch(() => {})
    },
    stop() {
      running = false
      cancelDelay()
    },
    state() {
      return { running, up, run, next, lastError }
    },
  })
}
