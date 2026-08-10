import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'

import { scan, PLANS_DIR } from './scan.js'
import { buildTree } from './store.js'
import { createWatcher } from './watcher.js'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

export function createServer({ plansDir = PLANS_DIR, watch = true } = {}) {
  const clients = new Set()

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      await route(url, req, res, { plansDir, clients })
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', String(err))
    }
  })

  if (watch) {
    const watcher = createWatcher(plansDir)
    watcher.on('changed', () => {
      for (const client of clients) client.write('data: {"type":"changed"}\n\n')
    })
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

async function route(url, req, res, { plansDir, clients }) {
  if (url.pathname === '/') return sendFile(res, join(PUBLIC_DIR, 'index.html'))

  if (url.pathname === '/api/plans') {
    const tree = buildTree(await scan(plansDir), Date.now())
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(tree))
  }

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

async function sendFile(res, path) {
  const type = TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
  try {
    send(res, 200, type, await readFile(path))
  } catch {
    send(res, 404, 'text/plain', 'not found')
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}
