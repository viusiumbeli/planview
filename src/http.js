// Request/response helpers shared by the plan routes in server.js and the terminal routes in
// routes/term.js. Extracted verbatim — behaviour is part of the tested contract.

const MAX_BODY = 64 * 1024

export function readJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) req.destroy()
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        resolve(parsed && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

export function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers })
  res.end(body)
}

// Rejections the browser has to explain to the user. Sending these as text/plain made the client's
// res.json() throw, so the reason was discarded and the UI could only show "failed (400)".
export function fail(res, status, error) {
  return send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error }))
}

export const json = (res, body) =>
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(body))

// A page that can read our JSON has same-origin credentials; this blocks a blind cross-site POST
// from a page that cannot. Browsers that omit the header (older ones) still need a token where one
// exists.
export const sameOrigin = (req) => {
  const site = req.headers['sec-fetch-site']
  return !site || site === 'same-origin'
}
