import http from 'node:http'
import { readFile, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

import { scan, PLANS_DIR } from './scan.js'
import { buildTree } from './store.js'
import { createWatcher } from './watcher.js'
import { createPending } from './pending.js'
import { createAgterm } from './agterm.js'
import { keysFor, parsePrompt } from './prompt.js'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export function createServer({
  plansDir = PLANS_DIR,
  watch = true,
  agterm = createAgterm(),
  pending = createPending(),
  now = Date.now,
} = {}) {
  const clients = new Set()
  const notify = () => {
    for (const client of clients) client.write('data: {"type":"changed"}\n\n')
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      await route(url, req, res, { plansDir, clients, agterm, pending, now, notify })
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', String(err))
    }
  })

  if (watch) {
    const watcher = createWatcher(plansDir)
    watcher.on('changed', notify)
    server.stopWatching = () => watcher.stop()
  }

  // A pinned tab holds its SSE stream open forever, and http.close() waits for open connections.
  // Shutting down has to hang up on the clients first or `planview stop` never returns.
  server.shutdown = () =>
    new Promise((resolve) => {
      server.stopWatching?.()
      for (const client of clients) client.end()
      clients.clear()
      server.close(resolve)
    })

  return server
}

async function route(url, req, res, { plansDir, clients, agterm, pending, now, notify }) {
  if (url.pathname === '/') return sendFile(res, join(PUBLIC_DIR, 'index.html'))

  if (url.pathname === '/api/plans') {
    const at = now()
    const tree = buildTree(await scan(plansDir), at)
    const awaiting = Object.fromEntries(await Promise.all(pending.ids(at).map((id) => offer(id, at))))
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ...tree, awaiting }))
  }

  // The buttons are built from the options actually on screen, read live. The hook fires before the
  // prompt is rendered, so registration cannot know them — and the wording varies by build and
  // context ("Yes, and use auto mode" vs "Yes, auto-accept edits"), so they must not be hardcoded.
  async function offer(id, at) {
    const entry = pending.get(id, at)
    const screen = await agterm.text(entry)
    const prompt = screen === null ? null : parsePrompt(screen)
    // The token rides along so the page can approve; a cross-site script cannot read this response.
    return [id, { token: entry.token, options: prompt?.options ?? [], selected: prompt?.selected }]
  }

  if (url.pathname === '/api/pending') return postPending(req, res, { pending, now, notify })
  if (url.pathname === '/api/approve') return postApprove(req, res, { agterm, pending, now, notify })

  if (url.pathname === '/api/plan') {
    const id = url.searchParams.get('id') ?? ''
    const path = resolve(plansDir, `${id}.md`)
    // An id is a bare filename; anything that resolves outside the plans dir is not ours to serve.
    if (!path.startsWith(resolve(plansDir) + sep)) return send(res, 400, 'text/plain', 'bad id')

    try {
      return send(res, 200, 'text/markdown; charset=utf-8', await readFile(path, 'utf8'))
    } catch {
      return send(res, 404, 'text/plain', 'no such plan')
    }
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 1000\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (url.pathname.startsWith('/static/')) {
    const path = resolve(PUBLIC_DIR, url.pathname.slice('/static/'.length))
    if (!path.startsWith(resolve(PUBLIC_DIR) + sep)) return send(res, 400, 'text/plain', 'bad path')
    return sendFile(res, path)
  }

  send(res, 404, 'text/plain', 'not found')
}

/* ---------- approving a plan ---------- */

// Registration comes from the ExitPlanMode hook, which runs inside the blocked session and is the
// only thing that knows which agterm session is waiting on which plan file.
async function postPending(req, res, { pending, now, notify }) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only')

  const body = await readJson(req)
  if (!body) return fail(res, 400, 'bad json')

  const token = pending.register(
    {
      planId: body.planId,
      sessionId: body.agtermSessionId,
      pane: body.agtermPane,
      paneId: body.agtermPaneId,
      socket: body.agtermSocket,
      cwd: body.cwd,
    },
    now(),
  )
  if (!token) return fail(res, 400, 'need a planId and a uuid agtermSessionId')

  notify()
  return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ token }))
}

async function postApprove(req, res, { agterm, pending, now, notify }) {
  if (req.method !== 'POST') return fail(res, 405, 'POST only')

  // A page that can read /api/plans has the token; this blocks a blind cross-site POST from a page
  // that cannot. Browsers that omit the header (older ones) still need the token.
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin') return fail(res, 403, 'cross-site request refused')

  const body = await readJson(req)
  if (!body) return fail(res, 400, 'bad json')
  if (!Number.isInteger(body.ordinal) || body.ordinal < 1 || body.ordinal > 20) {
    return fail(res, 400, 'ordinal must be a small positive integer')
  }

  const entry = pending.consume(body.planId, body.token, now())
  if (!entry) return fail(res, 403, 'no pending approval for this plan, or a stale token')

  const screen = await agterm.text(entry)
  const keys =
    screen === null
      ? { error: 'could not read that terminal session' }
      : keysFor(screen, body.ordinal, body.label)

  if (keys.error) {
    // Refusing is the whole point: the prompt may have been answered in the terminal already, and
    // sending a keystroke now would land in whatever replaced it.
    log(`refused planId=${body.planId} ordinal=${body.ordinal}: ${keys.error}`, screen)
    notify()
    return fail(res, 409, keys.error)
  }

  const sent = await agterm.type(entry, keys.keys)
  log(
    `sent planId=${body.planId} ordinal=${body.ordinal} label="${keys.label}" ` +
      `keys=${JSON.stringify(keys.keys)} ok=${sent.ok}${sent.error ? ` error=${sent.error}` : ''}`,
  )
  notify()
  if (!sent.ok) return fail(res, 502, sent.error)

  return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ chose: keys.label }))
}

// Why an attempt did what it did. Without this, a consumed token looks identical whether the click
// was refused or sent-and-ignored, which is exactly the ambiguity that cost a debugging cycle.
function log(line, screen) {
  const path = join(process.env.HOME ?? '/tmp', '.local/state/planview/approve.log')
  const body = screen === undefined ? '' : `\n--- screen read ---\n${screen ?? '(unreadable)'}\n---\n`
  appendFile(path, `${new Date().toISOString()} ${line}${body}\n`).catch(() => {})
}

const MAX_BODY = 64 * 1024

function readJson(req) {
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

async function sendFile(res, path) {
  const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
  try {
    // Without this a pinned tab serves whatever it cached: there are no validators to revalidate
    // against, so an edited app.js can go unnoticed indefinitely — which cost a debugging cycle when
    // the tab POSTed an old request shape to a new server. A round trip to 127.0.0.1 is free; being
    // wrong about which build is running is not.
    send(res, 200, type, await readFile(path), { 'cache-control': 'no-store, must-revalidate' })
  } catch {
    send(res, 404, 'text/plain', 'not found')
  }
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers })
  res.end(body)
}

// Rejections the browser has to explain to the user. Sending these as text/plain made the client's
// res.json() throw, so the reason was discarded and the UI could only show "failed (400)".
function fail(res, status, error) {
  return send(res, status, 'application/json; charset=utf-8', JSON.stringify({ error }))
}
