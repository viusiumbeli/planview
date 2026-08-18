import net from 'node:net'
import { join } from 'node:path'

import { isSessionId } from './pending.js'

/**
 * The raw agterm control socket.
 *
 * Wire protocol: newline-delimited JSON over a unix socket, ONE request per connection — agterm
 * answers and hangs up, so a fresh connection per call is the protocol's design, not an
 * inefficiency to fix. Requests look like {"cmd", "target"?, "window"?, "args"?}; responses are
 * {"ok":true,"result":{…}} or {"ok":false,"error":"…"}.
 *
 * @typedef {'down'|'timeout'|'notFound'|'ambiguous'|'badRequest'|'agterm'} AgcErrorCode
 */

const defaultSocket = () =>
  process.env.AGTERM_SOCKET ??
  join(process.env.HOME ?? '/tmp', 'Library', 'Application Support', 'agterm', 'agterm.sock')

// The wire is strictly typed per key — {"lines":"3"} is rejected as an invalid request while the
// events cursor `after` must be a STRING — and unknown keys are silently ignored. Both failure
// modes are invisible without this table: a key missing here is a programming error to fix, not a
// value to forward and hope.
const ARG_TYPES = {
  lines: 'int',
  limit: 'int',
  all: 'bool',
  select: 'bool',
  createWorkspace: 'bool',
  noSelect: 'bool',
  pane: 'string',
  text: 'string',
  run: 'string',
  after: 'string',
  kind: 'string',
  name: 'string',
  to: 'string',
  command: 'string',
  cwd: 'string',
  workspace: 'string',
  workspaceName: 'string',
  window: 'string',
  mode: 'string',
}

export class AgcError extends Error {
  /** @param {AgcErrorCode} code */
  constructor(code, message) {
    super(message)
    this.name = 'AgcError'
    this.code = code
  }
}

const classify = (message) => {
  if (/no such|not found/i.test(message)) return 'notFound'
  if (/ambiguous/i.test(message)) return 'ambiguous'
  if (/invalid request/i.test(message)) return 'badRequest'
  return 'agterm'
}

export function createAgc({
  socketPath = defaultSocket(),
  timeoutMs = 4000,
  connect = (path) => net.createConnection(path),
} = {}) {
  const coerce = (args) => {
    if (args === undefined) return undefined
    const out = {}
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue
      const type = ARG_TYPES[key]
      if (!type) throw new AgcError('badRequest', `unknown agterm arg "${key}"`)
      if (type === 'int' && !Number.isInteger(value)) {
        throw new AgcError('badRequest', `agterm arg "${key}" must be an integer`)
      }
      if (type === 'bool' && typeof value !== 'boolean') {
        throw new AgcError('badRequest', `agterm arg "${key}" must be a boolean`)
      }
      out[key] = type === 'string' ? String(value) : value
    }
    return Object.keys(out).length ? out : undefined
  }

  /**
   * One request, one answer, resolved with the wire's `result` object.
   *
   * `target` (and `window`) must be explicit UUIDs: the wire's default target is "active" — the
   * session the user happens to have focused in the GUI — which is never what a server acting for
   * a browser means. The footgun is closed here, at the transport, not per route.
   */
  const request = (cmd, { target, window: windowId, args } = {}) =>
    new Promise((resolve, reject) => {
      if (target !== undefined && !isSessionId(target)) {
        return reject(new AgcError('badRequest', 'target must be an explicit session uuid'))
      }
      if (windowId !== undefined && !isSessionId(windowId)) {
        return reject(new AgcError('badRequest', 'window must be an explicit window uuid'))
      }

      let payload
      try {
        payload = JSON.stringify({ cmd, target, window: windowId, args: coerce(args) })
      } catch (err) {
        return reject(err)
      }

      let socket
      try {
        socket = connect(socketPath)
      } catch {
        return reject(new AgcError('down', 'agterm is not running'))
      }

      let buffer = ''
      let done = false
      const finish = (fn, value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        socket.destroy()
        fn(value)
      }

      const timer = setTimeout(
        () => finish(reject, new AgcError('timeout', `agterm did not answer "${cmd}" within ${timeoutMs}ms`)),
        timeoutMs,
      )

      const settle = (line) => {
        let parsed
        try {
          parsed = JSON.parse(line)
        } catch {
          return finish(reject, new AgcError('agterm', 'unparseable response from agterm'))
        }
        if (parsed?.ok) return finish(resolve, parsed.result ?? {})
        const message = typeof parsed?.error === 'string' ? parsed.error : 'unknown agterm error'
        finish(reject, new AgcError(classify(message), message))
      }

      socket.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline !== -1) settle(buffer.slice(0, newline))
      })
      // agterm hangs up after answering; a response without a trailing newline still counts.
      socket.on('end', () => {
        if (buffer.trim()) settle(buffer)
        else finish(reject, new AgcError('agterm', 'agterm closed the connection without answering'))
      })
      socket.on('error', (err) => {
        const gone = err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED'
        finish(reject, gone ? new AgcError('down', 'agterm is not running') : new AgcError('agterm', String(err?.message ?? err)))
      })

      socket.write(`${payload}\n`)
    })

  return { request, socketPath }
}
