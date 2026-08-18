import { createAgc } from './agc.js'
import { createClaudeMap } from './claude-map.js'
import { createPump } from './pump.js'
import { createScreens } from './screens.js'
import { createTranscripts } from './transcripts.js'
import { createTreeCache } from './tree-cache.js'

/**
 * Composition root for the terminal-mirror subsystem. createServer takes the whole thing as one
 * injectable `term` option — tests pass a term built on a fake socket, and the default of null
 * keeps every existing test (and any box without agterm) running with /api/term/* answering 503.
 */
export function createTerm({
  agc = createAgc(),
  claudeMap = createClaudeMap(),
  transcripts = createTranscripts(),
  now = Date.now,
} = {}) {
  const treeCache = createTreeCache({ agc, now })
  const pump = createPump({ agc })
  const screens = createScreens({ agc, now })

  // Structure changed → the cached snapshot is a lie. Status flips deliberately do NOT invalidate:
  // they arrive several a second while an agent works, the browsers patch them in place, and the
  // TTL already bounds how stale a fresh snapshot can be.
  const structural = new Set(['tree.changed', 'session.created', 'session.closed'])
  pump.on('event', (item) => {
    if (structural.has(item.kind)) treeCache.invalidate()
    if (item.kind === 'status' && item.session) {
      screens.setHint(item.session, { status: item.payload?.status, blink: item.payload?.blink })
    }
  })
  pump.on('reset', () => treeCache.invalidate())

  return {
    agc,
    treeCache,
    pump,
    screens,
    claudeMap,
    transcripts,
    start() {
      pump.start()
    },
    stop() {
      pump.stop()
      screens.stopAll()
    },
  }
}
