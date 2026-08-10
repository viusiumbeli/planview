import { randomBytes } from 'node:crypto'

// Plans awaiting approval: which agterm session is blocked on which plan, and a token proving a
// click came from a page that could read /api/plans rather than from a blind cross-site POST.
//
// In memory only. A daemon restart should forget pending prompts — a resurrected one would point at
// a session that has long since moved on.

// A prompt nobody answers stops being clickable rather than staying live forever.
const TTL_MS = 30 * 60_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The only variable that ever reaches agtermctl's argv, so it is checked at the door.
export const isSessionId = (value) => typeof value === 'string' && UUID.test(value)

const PANES = new Set(['left', 'right', 'scratch'])

export function createPending({ makeToken = () => randomBytes(16).toString('hex') } = {}) {
  const entries = new Map()

  const live = (planId, now) => {
    const entry = entries.get(planId)
    if (!entry) return undefined
    if (now - entry.at >= TTL_MS) {
      entries.delete(planId)
      return undefined
    }
    return entry
  }

  return {
    /** Record a blocked session. Returns the token, or null when the hook sent something unusable. */
    register({ planId, sessionId, pane, paneId, socket, cwd }, now) {
      if (!planId || !isSessionId(sessionId)) return null

      const token = makeToken()
      entries.set(planId, {
        planId,
        sessionId,
        // A stale pane role is worse than none: agterm resolves paneId to the pane's live slot.
        pane: PANES.has(pane) ? pane : undefined,
        paneId: typeof paneId === 'string' && paneId ? paneId : undefined,
        socket: typeof socket === 'string' && socket ? socket : undefined,
        cwd,
        token,
        at: now,
      })
      return token
    },

    /** The live entry for a plan, or undefined once it has expired or been consumed. */
    get(planId, now) {
      return live(planId, now)
    },

    /** Plan ids still awaiting approval, so the sidebar can badge them. */
    ids(now) {
      return [...entries.keys()].filter((id) => live(id, now))
    },

    /**
     * Claim a pending approval. The entry is removed on success, so a token is single-use and a
     * double-clicked button cannot send the keystroke twice.
     * A wrong token leaves the entry alone — a stale tab must not be able to cancel a live prompt.
     */
    consume(planId, token, now) {
      const entry = live(planId, now)
      if (!entry || !token || token !== entry.token) return null
      entries.delete(planId)
      return entry
    },

    clear(planId) {
      entries.delete(planId)
    },
  }
}
