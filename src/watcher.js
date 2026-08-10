import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Emits `changed` when the plans directory changes.
 *
 * fs.watch alone is not enough: macOS drops events when a file is replaced atomically, which is
 * exactly how a plan gets rewritten. The poll is the backstop, the watch is what makes it feel
 * instant.
 */
export function createWatcher(dir, { debounceMs = 150, pollMs = 2000, watchFactory = watch } = {}) {
  const emitter = new EventEmitter()
  let timer = null
  let stopped = false

  // Captured eagerly, so a write landing before the first tick is seen as a change rather than
  // being absorbed into the baseline.
  let fingerprint = null
  const baseline = fingerprintOf(dir).then((f) => (fingerprint ??= f))

  // Both paths funnel through one comparison, so a change the watch and the poll both notice is
  // still a single `changed`. Serialised through a promise chain so two checks cannot race on
  // the fingerprint and emit twice.
  let queue = Promise.resolve()
  const check = () => {
    queue = queue.then(async () => {
      await baseline
      const next = await fingerprintOf(dir)
      if (next === fingerprint) return
      fingerprint = next
      if (!stopped) emitter.emit('changed')
    })
    return queue
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(check, debounceMs)
  }

  let handle = null
  try {
    handle = watchFactory(dir, () => !stopped && schedule())
  } catch {
    // Directory missing — the poll will pick it up once it appears.
  }

  const poll = setInterval(check, pollMs)

  emitter.stop = () => {
    stopped = true
    clearTimeout(timer)
    clearInterval(poll)
    handle?.close()
    emitter.removeAllListeners()
  }

  return emitter
}

async function fingerprintOf(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort()
    const stamps = await Promise.all(
      names.map(async (n) => {
        try {
          return `${n}:${(await stat(join(dir, n))).mtimeMs}`
        } catch {
          return `${n}:gone`
        }
      }),
    )
    return stamps.join('|')
  } catch {
    return ''
  }
}
