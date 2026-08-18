import { AgcError } from '../agc.js'
import { fail, json, readJson, sameOrigin } from '../http.js'
import { encodeInput } from '../keys.js'
import { isSessionId } from '../pending.js'
import { activeSessionOf } from '../tree-cache.js'

// What each agterm failure means to the browser.
const STATUS_BY_CODE = {
  down: 503,
  timeout: 504,
  notFound: 404,
  ambiguous: 400,
  badRequest: 400,
  agterm: 502,
}

const PANES = new Set(['left', 'right', 'scratch'])
const FLAG_MODES = new Set(['on', 'off', 'toggle'])

/** Ring items → the SSE vocabulary the browsers speak. Returns null for kinds handled elsewhere. */
export function translateEvent(item) {
  if (item.kind === 'status') {
    return {
      type: 'session.status',
      sessionId: item.session,
      status: item.payload?.status,
      blink: Boolean(item.payload?.blink),
      pane: item.payload?.pane,
      // The live title rides along on status events, so the sidebar tracks Claude's spinner
      // without a tree refetch.
      name: item.payload?.name,
    }
  }
  if (item.kind === 'notify') {
    return { type: 'notify', sessionId: item.session, title: item.payload?.title, body: item.payload?.body }
  }
  if (item.kind === 'tree.changed' || item.kind === 'session.created' || item.kind === 'session.closed') {
    return { type: 'tree.changed' }
  }
  return null
}

/**
 * Broadcast pump activity to every connected /api/term/events client. Wired once by createServer.
 * tree.changed is coalesced briefly: agterm already coalesces per window, but a multi-window burst
 * (and created+changed pairs) should still cost the browsers one refetch, not three.
 */
export function wireTermEvents(term, termClients, { coalesceMs = 100, setTimeoutFn = setTimeout } = {}) {
  const cast = (message) => {
    const line = `data: ${JSON.stringify(message)}\n\n`
    for (const client of termClients) client.write(line)
  }

  let treeTimer = null
  const castTreeChanged = () => {
    if (treeTimer) return
    treeTimer = setTimeoutFn(() => {
      treeTimer = null
      cast({ type: 'tree.changed' })
    }, coalesceMs)
  }

  term.pump.on('event', (item) => {
    const message = translateEvent(item)
    if (!message) return
    if (message.type === 'tree.changed') castTreeChanged()
    else cast(message)
  })
  term.pump.on('reset', ({ reason }) => cast({ type: 'reset', reason }))
  term.pump.on('up', () => cast({ type: 'agterm', up: true }))
  term.pump.on('down', () => cast({ type: 'agterm', up: false }))
}

export async function termRoute(url, req, res, ctx) {
  try {
    await dispatch(url, req, res, ctx)
  } catch (err) {
    if (err instanceof AgcError) return fail(res, STATUS_BY_CODE[err.code] ?? 502, err.message)
    throw err
  }
}

async function dispatch(url, req, res, { term, pending, now, termClients }) {
  const parts = url.pathname.slice('/api/term/'.length).split('/').filter(Boolean)
  const post = req.method === 'POST'

  // Everything that types into or reorganises a live terminal answers only same-origin pages.
  if (post && !sameOrigin(req)) return fail(res, 403, 'cross-site request refused')

  if (parts[0] === 'tree' && parts.length === 1 && !post) {
    const snapshot = await term.treeCache.snapshot()
    return json(res, {
      ...snapshot,
      activeSessionId: activeSessionOf(snapshot),
      pendingBySession: pendingBySession(pending, now()),
    })
  }

  if (parts[0] === 'state' && parts.length === 1 && !post) {
    return json(res, { ...term.pump.state(), socketPath: term.agc.socketPath })
  }

  if (parts[0] === 'events' && parts.length === 1 && !post) {
    openSse(res, req)
    // The opening message tells a fresh page whether agterm is reachable without waiting for the
    // next flip.
    res.write(`data: ${JSON.stringify({ type: 'agterm', up: term.pump.state().up })}\n\n`)
    termClients.add(res)
    req.on('close', () => termClients.delete(res))
    return
  }

  if (parts[0] === 'sessions' && parts.length === 1 && post) return createSession(req, res, term)
  if (parts[0] === 'sessions' && parts.length >= 2) {
    const sid = parts[1]
    if (!isSessionId(sid)) return fail(res, 400, 'session id must be a uuid')
    return sessionRoute(sid, parts.slice(2).join('/'), url, req, res, { term, post })
  }

  if (parts[0] === 'workspaces' && parts.length === 1 && post) return createWorkspace(req, res, term)
  if (parts[0] === 'workspaces' && parts.length === 3 && post) {
    const wid = parts[1]
    if (!isSessionId(wid)) return fail(res, 400, 'workspace id must be a uuid')
    return workspaceRoute(wid, parts[2], req, res, term)
  }

  if (parts[0] === 'windows' && parts.length === 3 && parts[2] === 'select' && post) {
    const wid = parts[1]
    if (!isSessionId(wid)) return fail(res, 400, 'window id must be a uuid')
    await term.agc.request('window.select', { target: wid })
    return json(res, {})
  }

  if (parts[0] === 'claude-session' && parts.length === 1 && post) {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad json')
    const ok = await term.claudeMap.register({
      agtermSessionId: body.agtermSessionId,
      claudeSessionId: body.claudeSessionId,
      transcriptPath: body.transcriptPath,
      cwd: body.cwd,
    })
    if (!ok) return fail(res, 400, 'need uuid session ids and a transcript path under ~/.claude/projects')
    return json(res, {})
  }

  fail(res, 404, 'not found')
}

/* ---------- per-session routes ---------- */

async function sessionRoute(sid, action, url, req, res, { term, post }) {
  const { agc, screens } = term

  if (action === 'screen' && !post) {
    const pane = paneOf(url)
    if (pane === false) return fail(res, 400, 'pane must be left, right or scratch')
    const lines = intParam(url, 'lines', 1, 1000)
    if (lines === false) return fail(res, 400, 'lines must be a small positive integer')
    return json(res, await screens.frame(sid, { pane, lines }))
  }

  if (action === 'screen/stream' && !post) {
    const pane = paneOf(url)
    if (pane === false) return fail(res, 400, 'pane must be left, right or scratch')
    openSse(res, req)

    // Latest-frame-wins: a slow reader gets the newest frame on drain, intermediate frames are
    // dropped by design — a terminal mirror has no use for history it can no longer show.
    let blocked = false
    let pendingFrame = null
    const push = (frame) => {
      if (blocked) {
        pendingFrame = frame
        return
      }
      if (!res.write(`data: ${JSON.stringify(frame)}\n\n`)) blocked = true
    }
    res.on('drain', () => {
      blocked = false
      if (pendingFrame) {
        const frame = pendingFrame
        pendingFrame = null
        push(frame)
      }
    })

    const unsubscribe = screens.subscribe(sid, { pane }, push)
    req.on('close', unsubscribe)
    return
  }

  if (action === 'type' && post) {
    const body = await readJson(req)
    if (!body) return fail(res, 400, 'bad json')
    const encoded = encodeInput(body)
    if (encoded.error) return fail(res, 400, encoded.error)
    const pane = body.pane === undefined ? undefined : PANES.has(body.pane) ? body.pane : false
    if (pane === false) return fail(res, 400, 'pane must be left, right or scratch')

    await agc.request('session.type', { target: sid, args: { text: encoded.data, pane } })
    screens.boost(sid)
    return json(res, {})
  }

  if (action === 'select' && post) {
    await agc.request('session.select', { target: sid })
    return json(res, {})
  }

  if (action === 'seen' && post) {
    await agc.request('session.seen', { target: sid })
    return json(res, {})
  }

  if (action === 'rename' && post) {
    const body = await readJson(req)
    if (!body || typeof body.name !== 'string') return fail(res, 400, 'need a name')
    await agc.request('session.rename', { target: sid, args: { name: body.name } })
    return json(res, {})
  }

  if (action === 'flag' && post) {
    const body = await readJson(req)
    if (!body || !FLAG_MODES.has(body.mode)) return fail(res, 400, 'mode must be on, off or toggle')
    await agc.request('session.flag', { target: sid, args: { mode: body.mode } })
    return json(res, {})
  }

  if (action === 'close' && post) {
    const body = await readJson(req)
    // Closing kills a live shell; a bare button click must not be able to do it by accident.
    if (!body?.confirm) return fail(res, 400, 'closing a session needs {"confirm":true}')
    await agc.request('session.close', { target: sid })
    return json(res, {})
  }

  if (action === 'history' && !post) return history(sid, url, res, term)
  if (action === 'history/stream' && !post) return historyStream(sid, req, res, term)
  if (action === 'history/block' && !post) return historyBlock(sid, url, res, term)

  fail(res, 404, 'not found')
}

/* ---------- history ---------- */

async function resolveTranscript(sid, term) {
  const snapshot = await term.treeCache.snapshot().catch(() => null)
  const node = snapshot ? findSession(snapshot, sid) : null
  return term.claudeMap.resolve(sid, node)
}

async function history(sid, url, res, term) {
  const source = await resolveTranscript(sid, term)
  if (!source) return fail(res, 404, 'no transcript mapped to this session')

  const before = intParam(url, 'before', 0, Number.MAX_SAFE_INTEGER)
  if (before === false) return fail(res, 400, 'before must be a byte offset')
  const limit = intParam(url, 'limit', 1, 500) ?? 100
  if (limit === false) return fail(res, 400, 'limit must be 1..500')

  const result = await term.transcripts.page(source.transcriptPath, { before, limit })
  return json(res, {
    ...result,
    source: {
      claudeSessionId: source.claudeSessionId ?? null,
      transcriptPath: source.transcriptPath,
      confidence: source.confidence,
    },
  })
}

async function historyStream(sid, req, res, term) {
  const source = await resolveTranscript(sid, term)
  if (!source) return fail(res, 404, 'no transcript mapped to this session')

  openSse(res, req)
  res.write(`data: ${JSON.stringify({ source: { confidence: source.confidence } })}\n\n`)

  // Start at the end of the file: the page the client fetched covers everything before now.
  let offset = Number.MAX_SAFE_INTEGER
  let closed = false
  let queue = Promise.resolve()

  const pushNew = () => {
    // Serialised: a burst of change events must not interleave two tail reads.
    queue = queue.then(async () => {
      if (closed) return
      try {
        const result = await term.transcripts.tail(source.transcriptPath, offset)
        offset = result.offset
        if (result.entries.length || result.gap) {
          res.write(`data: ${JSON.stringify({ entries: result.entries, gap: result.gap ?? false })}\n\n`)
        }
      } catch {
        // Transcript unreadable right now (rotated? deleted?) — the next change retries.
      }
    })
    return queue
  }

  await pushNew() // pins the real starting offset
  const stopWatching = term.transcripts.watchFile(source.transcriptPath, pushNew)
  req.on('close', () => {
    closed = true
    stopWatching()
  })
}

async function historyBlock(sid, url, res, term) {
  const source = await resolveTranscript(sid, term)
  if (!source) return fail(res, 404, 'no transcript mapped to this session')

  const offset = intParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER)
  const block = intParam(url, 'block', 0, 10_000)
  if (offset === false || offset === undefined) return fail(res, 400, 'offset must be a byte offset')
  if (block === false || block === undefined) return fail(res, 400, 'block must be an index')

  let raw
  try {
    raw = await term.transcripts.readLine(source.transcriptPath, offset)
  } catch {
    return fail(res, 404, 'no entry at that offset')
  }
  const content = raw?.message?.content
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const found = blocks[block]
  if (!found) return fail(res, 404, 'no such block in that entry')
  return json(res, { block: found })
}

/* ---------- creation ---------- */

async function createSession(req, res, term) {
  const body = await readJson(req)
  if (!body) return fail(res, 400, 'bad json')
  if (body.workspaceId !== undefined && !isSessionId(body.workspaceId)) {
    return fail(res, 400, 'workspaceId must be a uuid')
  }

  const result = await term.agc.request('session.new', {
    args: {
      cwd: str(body.cwd),
      workspace: body.workspaceId,
      workspaceName: str(body.workspaceName),
      createWorkspace: body.workspaceName !== undefined ? true : undefined,
      name: str(body.name),
      command: str(body.command),
      noSelect: body.noSelect === true ? true : undefined,
    },
  })
  return json(res, { id: result.id })
}

async function createWorkspace(req, res, term) {
  const body = await readJson(req)
  if (!body || typeof body.name !== 'string') return fail(res, 400, 'need a name')
  if (body.windowId !== undefined && !isSessionId(body.windowId)) {
    return fail(res, 400, 'windowId must be a uuid')
  }
  const result = await term.agc.request('workspace.new', {
    args: { name: body.name, window: body.windowId },
  })
  return json(res, { id: result.id })
}

async function workspaceRoute(wid, action, req, res, term) {
  if (action === 'select') {
    await term.agc.request('workspace.select', { target: wid })
    return json(res, {})
  }
  if (action === 'rename') {
    const body = await readJson(req)
    if (!body || typeof body.name !== 'string') return fail(res, 400, 'need a name')
    await term.agc.request('workspace.rename', { target: wid, args: { name: body.name } })
    return json(res, {})
  }
  if (action === 'delete') {
    const body = await readJson(req)
    // Deleting a workspace closes every session in it.
    if (!body?.confirm) return fail(res, 400, 'deleting a workspace needs {"confirm":true}')
    await term.agc.request('workspace.delete', { target: wid })
    return json(res, {})
  }
  fail(res, 404, 'not found')
}

/* ---------- small helpers ---------- */

function openSse(res, req) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write('retry: 1000\n\n')
  req.socket.setNoDelay(true)
}

const str = (value) => (typeof value === 'string' && value ? value : undefined)

/** A query int within [min, max]; undefined when absent, false when present but unusable. */
function intParam(url, name, min, max) {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) return false
  return value
}

/** ?pane= value; undefined when absent, false when junk. */
function paneOf(url) {
  const raw = url.searchParams.get('pane')
  if (raw === null || raw === '') return undefined
  return PANES.has(raw) ? raw : false
}

function findSession(snapshot, sid) {
  for (const window of snapshot.windows) {
    for (const workspace of window.workspaces) {
      for (const session of workspace.sessions) if (session.id === sid) return session
    }
  }
  return null
}

// pending.js keys entries by planId; the tree wants the reverse — which plan is a session blocked
// on — so the browser can badge the session and mount the approve chip from /api/plans data.
function pendingBySession(pending, at) {
  const map = {}
  for (const planId of pending.ids(at)) {
    const entry = pending.get(planId, at)
    if (entry) map[entry.sessionId] = planId
  }
  return map
}
