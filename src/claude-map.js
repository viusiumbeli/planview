import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { isSessionId } from './pending.js'

/**
 * Which Claude Code transcript belongs to which agterm session. agterm has no such mapping — the
 * terminal knows a PTY, not a conversation — so it is assembled here from four sources, best
 * first, and every answer carries its `confidence` so the UI can stay honest about a guess:
 *
 *   hook     — the SessionStart hook POSTed {claudeSessionId, transcriptPath} from inside the
 *              session; exact, survives daemon restarts via claude-map.json
 *   restore  — the tree node's pinned `claude --resume <uuid>` names the session outright
 *   ps       — a live `claude` process whose env carries this AGTERM_SESSION_ID (macOS lets
 *              `ps eww` read a same-user process env), transcript picked by freshness
 *   guessed  — newest transcript in the session's cwd project dir; a label, not a promise
 */

const HOME = process.env.HOME ?? '/tmp'
const DEFAULT_STATE = join(HOME, '.local', 'state', 'planview', 'claude-map.json')
const DEFAULT_PROJECTS = join(HOME, '.claude', 'projects')

// ~/.claude/projects encodes a cwd by replacing every non-alphanumeric with a dash.
const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-')

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** agterm session id → live claude pid, read from the processes' own environments. */
export async function defaultPsScan() {
  const pids = (await run('pgrep', ['-x', 'claude'])).split(/\s+/).filter(Boolean)
  const map = new Map()
  await Promise.all(
    pids.map(async (pid) => {
      const env = await run('ps', ['eww', '-o', 'command=', '-p', pid])
      const match = /AGTERM_SESSION_ID=([0-9a-fA-F-]{36})/.exec(env)
      if (match) map.set(match[1].toUpperCase(), Number(pid))
    }),
  )
  return map
}

function run(bin, args) {
  return new Promise((resolvePromise) => {
    let out = ''
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return resolvePromise('')
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise(out)
    })
  })
}

export function createClaudeMap({
  statePath = DEFAULT_STATE,
  projectsDir = DEFAULT_PROJECTS,
  psScan = defaultPsScan,
  now = Date.now,
  resolveTtlMs = 15_000,
} = {}) {
  let entries = null // agtermSessionId → {claudeSessionId, transcriptPath, cwd, at}
  const memo = new Map() // agtermSessionId → {at, value} — ps scans are spawns, not free

  async function load() {
    if (entries) return entries
    entries = new Map()
    try {
      const data = JSON.parse(await readFile(statePath, 'utf8'))
      for (const [key, value] of Object.entries(data.entries ?? {})) entries.set(key, value)
    } catch {
      // First run, or an unreadable file — start empty rather than refuse to start.
    }
    return entries
  }

  async function save() {
    await mkdir(dirname(statePath), { recursive: true }).catch(() => {})
    await writeFile(statePath, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }, null, 2))
  }

  const projectDirFor = (cwd) => join(projectsDir, projectSlug(cwd))

  async function newestTranscript(dir) {
    let names
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return null
    }
    let best = null
    await Promise.all(
      names.map(async (name) => {
        try {
          const info = await stat(join(dir, name))
          if (!best || info.mtimeMs > best.mtimeMs) best = { path: join(dir, name), mtimeMs: info.mtimeMs }
        } catch {}
      }),
    )
    return best?.path ?? null
  }

  return {
    /** The SessionStart hook's registration. Loopback-trusted like /api/pending, but the path is
     * still confined to the transcripts tree — this daemon must not become a generic file reader. */
    async register({ agtermSessionId, claudeSessionId, transcriptPath, cwd }) {
      if (!isSessionId(agtermSessionId) || !isSessionId(claudeSessionId)) return null
      if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return null
      const path = resolve(transcriptPath)
      if (!path.startsWith(resolve(projectsDir) + sep)) return null

      await load()
      entries.set(agtermSessionId.toUpperCase(), {
        claudeSessionId: claudeSessionId.toLowerCase(),
        transcriptPath: path,
        cwd: typeof cwd === 'string' ? cwd : undefined,
        at: now(),
      })
      memo.delete(agtermSessionId.toUpperCase())
      await save()
      return true
    },

    /** The transcript for an agterm session, or null. `treeNode` is the live tree's session node. */
    async resolve(agtermSessionId, treeNode) {
      const key = agtermSessionId.toUpperCase()
      const cached = memo.get(key)
      if (cached && now() - cached.at < resolveTtlMs) return cached.value

      const value = await lookup(key, treeNode)
      memo.set(key, { at: now(), value })
      return value
    },
  }

  async function lookup(key, treeNode) {
    await load()

    const hooked = entries.get(key)
    if (hooked && (await exists(hooked.transcriptPath))) return { ...hooked, confidence: 'hook' }

    const restore = /claude\s+--resume\s+([0-9a-fA-F-]{36})/.exec(treeNode?.restoreCommand ?? '')
    if (restore && treeNode?.cwd) {
      const claudeSessionId = restore[1].toLowerCase()
      const path = join(projectDirFor(treeNode.cwd), `${claudeSessionId}.jsonl`)
      if (await exists(path)) {
        return { claudeSessionId, transcriptPath: path, cwd: treeNode.cwd, confidence: 'restore' }
      }
    }

    if (!treeNode?.cwd) return null
    const dir = projectDirFor(treeNode.cwd)

    try {
      const running = await psScan()
      if (running.has(key)) {
        const path = await newestTranscript(dir)
        if (path) return { claudeSessionId: null, transcriptPath: path, cwd: treeNode.cwd, confidence: 'ps' }
      }
    } catch {
      // ps is best-effort; fall through to the plain guess
    }

    const path = await newestTranscript(dir)
    if (path) return { claudeSessionId: null, transcriptPath: path, cwd: treeNode.cwd, confidence: 'guessed' }
    return null
  }
}
