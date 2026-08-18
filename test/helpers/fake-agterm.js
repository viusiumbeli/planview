import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fake agterm control socket for tests: newline-delimited JSON, one request per connection,
 * answer then hang up — exactly the real server's manners.
 *
 * `script` receives each parsed request and returns the response object ({ok:true,result} or
 * {ok:false,error}); it may be async. Every request is also recorded in `requests` so a test can
 * assert what reached the wire.
 */
export async function fakeAgtermSocket(script) {
  const socketPath = join(tmpdir(), `fake-agterm-${randomBytes(6).toString('hex')}.sock`)
  const requests = []

  const server = net.createServer((socket) => {
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', async (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return

      let request = null
      try {
        request = JSON.parse(buffer.slice(0, newline))
      } catch {
        // recorded as null so a test can spot a malformed write
      }
      requests.push(request)

      let response
      try {
        response = await script(request)
      } catch (err) {
        response = { ok: false, error: String(err?.message ?? err) }
      }
      try {
        socket.end(`${JSON.stringify(response)}\n`)
      } catch {
        socket.destroy()
      }
    })
  })

  await new Promise((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
