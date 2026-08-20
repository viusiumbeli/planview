// Transcript entry → terminal-styled rows. PURE (no DOM) — covered by node --test.
//
// The goal is the look of the conversation as agterm itself shows it — `>` prompts, `⏺` turns,
// `  ⎿` results — not a chat. Each block becomes one row: `text` is what is visible right away,
// `more` holds the rest for an inline expand, `fetch` marks a block the server truncated (the full
// text lives behind /history/block at {offset, i}).

const indent = (text, first, rest) =>
  text
    .split('\n')
    .map((line, i) => (i === 0 ? first : rest) + line)
    .join('\n')

const firstLine = (text) => text.split('\n', 1)[0]

// What to call a plan in one line of log: its own first heading, else the plan file's name.
const titleOf = (text, planId, limit) => {
  const heading = text.split('\n').find((line) => /^#{1,3}\s+\S/.test(line))
  const title = heading ? heading.replace(/^#{1,3}\s+/, '').trim() : planId || 'план'
  return title.length > limit ? `${title.slice(0, limit).trimEnd()}…` : title
}

/**
 * @param {object} entry shaped history entry {role, ts, offset, blocks}
 * @param {object} [options]
 * @param {number} [options.resultLines] visible lines of a tool result before folding
 * @param {number} [options.labelChars] input preview length in a tool_use label
 * @returns {Array<{cls: string, err: boolean, text: string,
 *                  more: null | {label: string, hidden: string},
 *                  fetch: null | {offset: number, block: number},
 *                  plan?: {planId: string | null, truncated: boolean, title: string}}>}
 */
export function entryRows(entry, { resultLines = 5, labelChars = 100, titleChars = 80 } = {}) {
  const rows = []

  for (const block of entry.blocks ?? []) {
    const fetch = block.truncated ? { offset: entry.offset, block: block.i } : null

    // A plan is not log text: the row carries the raw markdown and lets the renderer draw it as a
    // document — but in the FEED that document is collapsed behind one line, because scrolling back
    // through history should read like a log, not reopen every plan at full height.
    if (block.kind === 'plan') {
      rows.push({
        cls: 't-plan',
        err: false,
        text: block.text,
        more: null,
        fetch: null,
        plan: {
          planId: block.planId ?? null,
          truncated: Boolean(block.truncated),
          title: titleOf(block.text, block.planId, titleChars),
        },
      })
      continue
    }

    if (block.kind === 'text' && entry.role === 'user') {
      rows.push({ cls: 't-user', err: false, text: indent(block.text, '> ', '  '), more: null, fetch })
      continue
    }

    if (block.kind === 'text') {
      rows.push({ cls: 't-asst', err: false, text: indent(block.text, '⏺ ', '  '), more: null, fetch })
      continue
    }

    if (block.kind === 'thinking') {
      rows.push({
        cls: 't-think',
        err: false,
        text: '✻ thinking…',
        more: { label: 'показать', hidden: indent(block.text, '  ', '  ') },
        fetch,
      })
      continue
    }

    if (block.kind === 'tool_use') {
      // The server names what the call is about (a file, a command); the JSON stays behind expand.
      const about = (block.preview ?? firstLine(block.text)).slice(0, labelChars)
      const clipped = about.length < (block.preview ?? block.text).length
      rows.push({
        cls: 't-tool',
        err: false,
        text: `⏺ ${block.name}(${about}${clipped ? '…' : ''})`,
        more: { label: 'вход целиком', hidden: indent(block.text, '  ', '  ') },
        fetch,
      })
      continue
    }

    if (block.kind === 'tool_result') {
      const lines = (block.text || '(пустой результат)').split('\n')
      const visible = lines.slice(0, resultLines)
      const hidden = lines.slice(resultLines)
      rows.push({
        cls: 't-result',
        err: Boolean(block.isError),
        text: indent(visible.join('\n'), '  ⎿  ', '     '),
        more: hidden.length
          ? { label: `… +${hidden.length} строк`, hidden: indent(hidden.join('\n'), '     ', '     ') }
          : null,
        fetch,
      })
      continue
    }

    if (block.kind === 'image') {
      rows.push({ cls: 't-user', err: false, text: '> 🖼 изображение', more: null, fetch: null })
    }
  }

  return rows
}
