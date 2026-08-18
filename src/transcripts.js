import { open, stat } from 'node:fs/promises'
import { watch } from 'node:fs'

/**
 * Claude Code JSONL transcripts, read the only way a 12 MB append-only file can afford: backwards,
 * in chunks, by byte offset. A page request never parses more lines than it returns, offsets are
 * opaque cursors to the client, and the trailing line is held back whenever it might still be
 * mid-write.
 *
 * Entry shaping keeps the conversation (user/assistant turns) and drops the bookkeeping types
 * (mode, file-history-*, attachment, …). Sidechain entries — subagent traffic recorded into the
 * same file — are dropped too: interleaving them with the main thread reads as nonsense.
 */
export function createTranscripts({
  chunk = 64 * 1024,
  maxToolBytes = 4 * 1024,
  maxTextBytes = 64 * 1024,
  maxTailBytes = 1024 * 1024,
} = {}) {
  const clip = (value, limit) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
    if (text.length <= limit) return { text, truncated: false }
    return { text: text.slice(0, limit), truncated: true, fullLength: text.length }
  }

  const toolResultText = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((c) => c?.text ?? '').join('\n')
    return ''
  }

  /** One raw JSONL object → a render-ready entry, or null when it is not part of the conversation. */
  function shapeEntry(json, offset) {
    if (!json || typeof json !== 'object' || json.isSidechain) return null

    // `i` is the block's index in the RAW message content — the address /history/block resolves
    // when a truncated block's full text is fetched.
    if (json.type === 'user') {
      const content = json.message?.content
      const blocks = []
      if (typeof content === 'string') {
        blocks.push({ kind: 'text', i: 0, ...clip(content, maxTextBytes) })
      } else if (Array.isArray(content)) {
        content.forEach((block, i) => {
          if (block?.type === 'text') blocks.push({ kind: 'text', i, ...clip(block.text ?? '', maxTextBytes) })
          else if (block?.type === 'tool_result') {
            blocks.push({
              kind: 'tool_result',
              i,
              toolUseId: block.tool_use_id,
              isError: Boolean(block.is_error),
              ...clip(toolResultText(block.content), maxToolBytes),
            })
          } else if (block?.type === 'image') blocks.push({ kind: 'image', i, text: '', truncated: false })
        })
      }
      if (!blocks.length) return null
      return { role: 'user', uuid: json.uuid, ts: json.timestamp, offset, blocks }
    }

    if (json.type === 'assistant') {
      const content = json.message?.content
      const blocks = []
      if (Array.isArray(content)) {
        content.forEach((block, i) => {
          if (block?.type === 'text') blocks.push({ kind: 'text', i, ...clip(block.text ?? '', maxTextBytes) })
          else if (block?.type === 'thinking') blocks.push({ kind: 'thinking', i, ...clip(block.thinking ?? '', maxToolBytes) })
          else if (block?.type === 'tool_use') {
            blocks.push({
              kind: 'tool_use',
              i,
              id: block.id,
              name: block.name,
              ...clip(JSON.stringify(block.input ?? {}, null, 1), maxToolBytes),
            })
          }
        })
      }
      if (!blocks.length) return null
      return { role: 'assistant', uuid: json.uuid, ts: json.timestamp, offset, blocks }
    }

    return null
  }

  /**
   * The `limit` newest raw lines strictly before byte offset `before` (default: end of file),
   * shaped. `nextBefore` pages older; 0 means the top of the file has been reached.
   */
  async function page(path, { before, limit = 100 } = {}) {
    const fh = await open(path, 'r')
    try {
      const size = (await fh.stat()).size
      const end = Math.min(before ?? size, size)
      if (end <= 0) return { entries: [], nextBefore: 0, size, hasMore: false, skipped: 0 }

      let pos = end
      const chunks = []
      let newlines = 0
      while (pos > 0 && newlines <= limit) {
        const start = Math.max(0, pos - chunk)
        const buf = Buffer.alloc(pos - start)
        await fh.read(buf, 0, buf.length, start)
        chunks.unshift(buf)
        for (const byte of buf) if (byte === 10) newlines++
        pos = start
      }
      const data = Buffer.concat(chunks) // bytes [pos, end)

      // Complete lines only. When pos > 0 the bytes before the first newline are the tail of an
      // older line (and possibly a split multibyte character) — they belong to the previous page.
      // Bytes after the last newline are a line still being written — held back, never parsed.
      const lines = []
      let lineStart = pos === 0 ? 0 : -1
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 10) continue
        if (lineStart !== -1 && i > lineStart) lines.push({ start: pos + lineStart, buf: data.subarray(lineStart, i) })
        lineStart = i + 1
      }

      const kept = lines.slice(-limit)
      const entries = []
      let skipped = 0
      for (const line of kept) {
        try {
          const entry = shapeEntry(JSON.parse(line.buf.toString('utf8')), line.start)
          if (entry) entries.push(entry)
        } catch {
          skipped++
        }
      }

      const nextBefore = kept.length ? kept[0].start : 0
      return { entries, nextBefore, size, hasMore: nextBefore > 0, skipped }
    } finally {
      await fh.close()
    }
  }

  /** Everything appended since `fromOffset`, holding back a trailing partial line. */
  async function tail(path, fromOffset = 0) {
    const fh = await open(path, 'r')
    try {
      const size = (await fh.stat()).size
      let from = Math.min(fromOffset, size)
      let gap = false
      // A stream that fell far behind skips ahead rather than allocating the whole backlog; the
      // client is told so it can refetch a page instead of trusting a hole.
      if (size - from > maxTailBytes) {
        from = size - maxTailBytes
        gap = true
      }
      if (size <= from) return { entries: [], offset: from, skipped: 0, gap }

      const buf = Buffer.alloc(size - from)
      await fh.read(buf, 0, buf.length, from)

      let scanStart = 0
      if (gap) {
        // Skipping ahead lands mid-line; drop up to the first newline.
        const firstNl = buf.indexOf(10)
        if (firstNl === -1) return { entries: [], offset: from, skipped: 0, gap }
        scanStart = firstNl + 1
      }

      const entries = []
      let skipped = 0
      let lineStart = scanStart
      let consumed = scanStart
      for (let i = scanStart; i < buf.length; i++) {
        if (buf[i] !== 10) continue
        if (i > lineStart) {
          try {
            const entry = shapeEntry(JSON.parse(buf.subarray(lineStart, i).toString('utf8')), from + lineStart)
            if (entry) entries.push(entry)
          } catch {
            skipped++
          }
        }
        lineStart = i + 1
        consumed = i + 1
      }
      return { entries, offset: from + consumed, skipped, gap }
    } finally {
      await fh.close()
    }
  }

  /** The single raw JSONL object whose line starts at `offset` — the untruncated-block read. */
  async function readLine(path, offset) {
    const fh = await open(path, 'r')
    try {
      const size = (await fh.stat()).size
      let pos = offset
      const parts = []
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(chunk, size - pos))
        await fh.read(buf, 0, buf.length, pos)
        const nl = buf.indexOf(10)
        if (nl !== -1) {
          parts.push(buf.subarray(0, nl))
          break
        }
        parts.push(buf)
        pos += buf.length
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    } finally {
      await fh.close()
    }
  }

  /**
   * Change notification for a live transcript: fs.watch for immediacy, a 1s size poll as the
   * backstop — same belt-and-braces as the plans watcher, and for the same reason (macOS drops
   * events on atomic replace).
   */
  function watchFile(path, onChange, { debounceMs = 100, pollMs = 1000 } = {}) {
    let stopped = false
    let timer = null
    const fire = () => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(() => !stopped && onChange(), debounceMs)
    }

    let handle = null
    try {
      handle = watch(path, fire)
    } catch {
      // File missing right now — the poll notices when it appears.
    }

    let lastSize = null
    const poll = setInterval(async () => {
      try {
        const { size } = await stat(path)
        if (lastSize !== null && size !== lastSize) fire()
        lastSize = size
      } catch {}
    }, pollMs)

    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(poll)
      handle?.close()
    }
  }

  return { page, tail, readLine, watchFile }
}
