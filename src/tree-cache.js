/**
 * A cached snapshot of agterm's window → workspace → session structure.
 *
 * The wire cost of a snapshot is one `window.list` plus one `tree` per open window, so callers
 * hitting /api/term/tree in a burst (every browser tab refetches on the same tree.changed event)
 * should share one round trip. The pump invalidates on tree.changed/session.created/closed; the
 * TTL is a backstop for anything that changes without an event.
 *
 * Closed windows are skipped deliberately: asking `tree` for a closed window silently answers with
 * the ACTIVE window's tree (verified live), which would duplicate sessions in the snapshot.
 */
export function createTreeCache({ agc, staleMs = 2000, now = Date.now } = {}) {
  let cached = null // { at, promise }

  const fetchSnapshot = async () => {
    const { windows = [] } = await agc.request('window.list')
    const open = windows.filter((w) => w.open)
    const trees = await Promise.all(open.map((w) => agc.request('tree', { window: w.id })))

    return {
      windows: open.map((w, i) => ({
        id: w.id,
        name: w.name,
        active: Boolean(w.active),
        workspaces: trees[i].tree?.workspaces ?? [],
      })),
    }
  }

  return {
    /** The current structure; concurrent callers share one in-flight fetch. */
    snapshot() {
      if (cached && now() - cached.at < staleMs) return cached.promise
      const promise = fetchSnapshot()
      cached = { at: now(), promise }
      // A failed fetch must not linger as a poisoned cache entry.
      promise.catch(() => {
        if (cached?.promise === promise) cached = null
      })
      return promise
    },

    invalidate() {
      cached = null
    },
  }
}

/** The active session's id in the active window, or null. */
export function activeSessionOf(snapshot) {
  for (const window of snapshot.windows) {
    if (!window.active) continue
    for (const workspace of window.workspaces) {
      for (const session of workspace.sessions) if (session.active) return session.id
    }
  }
  return null
}
