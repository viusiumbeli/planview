import { api } from '../lib/api.js'
import { renderMarkdown } from '../lib/markdown.js'
import { entryRows } from './termlog.js'

// Said in full sentences, in the feed, where the uncertain past begins — not as a chip that
// looks like a button. An exact match (the SessionStart hook registered it) says nothing at all.
const CONFIDENCE_NOTE = {
  restore: 'история сопоставлена по restore-команде сессии',
  ps: 'история сопоставлена по живому процессу claude — возможно, это диалог другой сессии в этом каталоге',
  guessed: 'история — самый свежий транскрипт этого каталога, точное совпадение не подтверждено',
}

/**
 * The past half of the unified terminal feed: the session's transcript rendered as a monospace
 * terminal log ABOVE the live frame, in the one shared scroll container. Newest page first,
 * older pages lazy-load as the top scrolls into view, live entries stream in — appended silently
 * when the reader is pinned to the bottom, offered as a "↓ live" pill when not.
 */
export function createScrollback({ container, past, topSentinel, pill, note }) {
  let sid = null
  let events = null
  let nextBefore = null
  let hasMore = false
  let loadingOlder = false

  const atBottom = () => container.scrollHeight - container.scrollTop - container.clientHeight < 60
  const scrollToBottom = () => {
    container.scrollTop = container.scrollHeight
    pill.hidden = true
  }
  pill.addEventListener('click', scrollToBottom)
  container.addEventListener('scroll', () => {
    if (atBottom()) pill.hidden = true
  })

  /* ---------- rendering ---------- */

  function rowElement(row) {
    const div = document.createElement('div')
    div.className = `t-row ${row.cls}${row.err ? ' t-err' : ''}`

    const text = document.createElement('span')
    text.textContent = row.text
    div.append(text)

    if (row.more || row.fetch) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 't-more'
      button.textContent = row.more?.label ?? 'целиком'
      button.addEventListener('click', async () => {
        if (row.more) text.textContent += `\n${row.more.hidden}`
        if (row.fetch) {
          button.textContent = '…'
          try {
            const { block } = await api.historyBlock(sid, row.fetch.offset, row.fetch.block)
            const full =
              typeof block.text === 'string'
                ? block.text
                : typeof block.content === 'string'
                  ? block.content
                  : typeof block.thinking === 'string'
                    ? block.thinking
                    : JSON.stringify(block.input ?? block.content ?? block, null, 1)
            text.textContent = `${row.text.split('\n')[0]}\n${full.split('\n').map((l) => `  ${l}`).join('\n')}`
          } catch (err) {
            button.textContent = err.message
            return
          }
        }
        button.remove()
      })
      div.append(button)
    }
    return div
  }

  // A plan reads as a document, not as terminal text — tables and nested lists as markup is the
  // one thing the terminal did badly, and the reason this page exists at all.
  function planElement(row) {
    const card = document.createElement('div')
    card.className = 'plan-card'

    const label = document.createElement('div')
    label.className = 'plan-label'
    label.textContent = 'plan'
    card.append(label)

    const body = document.createElement('div')
    body.append(renderMarkdown(row.text))
    card.append(body)

    // The transcript clips a very long plan; the plan file itself has all of it.
    if (row.plan.truncated && row.plan.planId) {
      fetch(`/api/plan?id=${encodeURIComponent(row.plan.planId)}`)
        .then((res) => (res.ok ? res.text() : null))
        .then((full) => full && body.replaceChildren(renderMarkdown(full)))
        .catch(() => {})
    } else if (row.plan.truncated) {
      const note = document.createElement('div')
      note.className = 'plan-clipped'
      note.textContent = '… plan clipped, and its file is gone'
      card.append(note)
    }
    return card
  }

  function entryElement(entry) {
    const section = document.createElement('div')
    section.className = 't-entry'
    if (entry.ts) section.title = new Date(entry.ts).toLocaleString()
    for (const row of entryRows(entry)) {
      section.append(row.plan ? planElement(row) : rowElement(row))
    }
    return section
  }

  /* ---------- loading ---------- */

  async function loadNewest() {
    let page
    try {
      page = await api.history(sid, { limit: 100 })
    } catch (err) {
      // No transcript mapped (or unreadable) — the live frame still works; the past is just empty.
      note.hidden = false
      note.textContent = `история недоступна: ${err.message}`
      return false
    }
    nextBefore = page.nextBefore
    hasMore = page.hasMore

    const confidence = page.source?.confidence
    note.hidden = !CONFIDENCE_NOTE[confidence]
    note.textContent = CONFIDENCE_NOTE[confidence] ?? ''

    for (const entry of page.entries) past.append(entryElement(entry))
    observer.observe(topSentinel)
    return true
  }

  async function loadOlder() {
    if (!hasMore || loadingOlder || !sid) return
    loadingOlder = true
    try {
      const page = await api.history(sid, { before: nextBefore, limit: 100 })
      nextBefore = page.nextBefore
      hasMore = page.hasMore
      const grewBy = () => container.scrollHeight
      const before = grewBy()
      const fragment = document.createDocumentFragment()
      for (const entry of page.entries) fragment.append(entryElement(entry))
      topSentinel.after(fragment)
      // Keep the reader's place: the content above them grew, so the scroll offset must too.
      container.scrollTop += grewBy() - before
    } catch {
      // scrolling further retries
    } finally {
      loadingOlder = false
    }
  }

  const observer = new IntersectionObserver(
    (intersections) => {
      if (intersections.some((entry) => entry.isIntersecting)) loadOlder()
    },
    { root: container },
  )

  function openStream() {
    events?.close()
    events = new EventSource(`/api/term/sessions/${sid}/history/stream`)
    events.addEventListener('message', (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      if (!data.entries?.length) return
      const pinned = atBottom()
      for (const entry of data.entries) past.append(entryElement(entry))
      if (pinned) scrollToBottom()
      else pill.hidden = false
    })
  }

  /* ---------- lifecycle ---------- */

  return {
    async show(nextSid) {
      if (nextSid === sid && events) return
      sid = nextSid
      events?.close()
      events = null
      observer.disconnect()
      for (const el of [...past.children]) if (el !== topSentinel) el.remove()
      pill.hidden = true
      note.hidden = true
      nextBefore = null
      hasMore = false

      if (!sid) return
      const loaded = await loadNewest()
      scrollToBottom()
      if (loaded) openStream()
    },

    hide() {
      events?.close()
      events = null
    },

    /** The live frame is about to change size: keep the bottom pinned iff the reader is there. */
    withPin(mutate) {
      const pinned = atBottom()
      mutate()
      if (pinned) scrollToBottom()
    },
  }
}
