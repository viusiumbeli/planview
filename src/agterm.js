import { spawn } from 'node:child_process'

// The IO half of approving from the browser: read a session's screen, and send it keystrokes.
//
// Every call goes through spawn with an ARGV ARRAY and no shell, so nothing here can be turned into
// a command by the contents of a request. The only variable that reaches argv is the session id,
// which `isSessionId` in pending.js has already constrained to a UUID.

// Same resolution order the agterm status hook uses: an explicit override, then the bundled binary
// (agtermctl is often never symlinked into PATH), then PATH.
const BUNDLED = '/Applications/agterm.app/Contents/MacOS/agtermctl'
const BIN = process.env.AGTERMCTL || BUNDLED

const TIMEOUT_MS = 4000

export function createAgterm({ bin = BIN } = {}) {
  const run = (args, stdin) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch {
        return resolve({ ok: false, out: '', error: 'agtermctl not runnable' })
      }

      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)

      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', () => {
        clearTimeout(timer)
        resolve({ ok: false, out: '', error: `cannot run ${bin}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ ok: code === 0, out, error: code === 0 ? undefined : err.trim() || `exit ${code}` })
      })

      child.stdin.on('error', () => {})
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    })

  // --target/--socket/--pane are subcommand options, so they follow the subcommand, not precede it.
  // Only `session status`/`restore` accept --pane-id, so the hook's paneId is deliberately not
  // forwarded here — an unknown flag would fail the call outright.
  const target = ({ sessionId, socket, pane }) => [
    '--target',
    sessionId,
    ...(socket ? ['--socket', socket] : []),
    ...(pane ? ['--pane', pane] : []),
  ]

  return {
    /** The session's visible screen, or null when it could not be read. */
    async text(entry, lines = 60) {
      const res = await run(['session', 'text', ...target(entry), '--lines', String(lines)])
      return res.ok ? res.out : null
    },

    /** Send keystrokes. Passed on stdin so control bytes never have to survive argv. */
    async type(entry, keys) {
      return run(['session', 'type', '--stdin', ...target(entry)], keys)
    },
  }
}
