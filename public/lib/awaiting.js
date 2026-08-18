import { connectSse } from './bus.js'

/**
 * Which plans are waiting for an answer, and the live options to answer them with.
 *
 * The approval prompt's wording varies by build and context, so the server reads the options off
 * the terminal rather than hardcoding them — they arrive in /api/plans' `awaiting` map along with
 * the single-use token. This also owns the daemon-connection dot: /events is the plan side's SSE.
 */
export function initAwaiting({ statusDot } = {}) {
  const listeners = new Set()
  let awaiting = {}

  // The ExitPlanMode hook fires at PreToolUse — BEFORE the prompt is drawn — so the first read of
  // the screen usually finds no options yet, and no further SSE event is coming. Poll until they
  // show up, then stop.
  let retries = 0
  let retryTimer = null

  const retryForOptions = () => {
    if (retryTimer || retries >= 20) return
    retries++
    retryTimer = setTimeout(() => {
      retryTimer = null
      refresh()
    }, 800)
  }

  async function refresh() {
    try {
      const data = await (await fetch('/api/plans')).json()
      awaiting = data.awaiting ?? {}
    } catch {
      return
    }
    if (Object.values(awaiting).some((entry) => !entry.options?.length)) retryForOptions()
    else retries = 0
    for (const listener of listeners) listener(awaiting)
  }

  connectSse('/events', {
    onOpen: () => {
      statusDot?.classList.remove('offline')
      // Every reconnect refetches, so a prompt raised while disconnected is never missed.
      refresh()
    },
    onMessage: refresh,
    onDown: () => statusDot?.classList.add('offline'),
  })

  return {
    get: (planId) => (planId ? awaiting[planId] : undefined),
    onUpdate(listener) {
      listeners.add(listener)
    },
    refresh,
  }
}
