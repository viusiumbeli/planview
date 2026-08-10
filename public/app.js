import { buildOutline } from './outline.js'

const tree = document.getElementById('tree')
const doc = document.getElementById('doc')
const planHeader = document.getElementById('plan-header')
const planTitle = document.getElementById('plan-title')
const planMeta = document.getElementById('plan-meta')
const rail = document.getElementById('rail')
const outline = document.getElementById('outline')
const status = document.getElementById('status')
const lockInput = document.getElementById('lock-input')
const approve = document.getElementById('approve')
const approveNote = document.getElementById('approve-note')
const approveButtons = document.getElementById('approve-buttons')

function store(key) {
  let data = {}
  try {
    data = JSON.parse(localStorage.getItem(key)) ?? {}
  } catch {
    data = {}
  }
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v
      localStorage.setItem(key, JSON.stringify(data))
    },
  }
}

// mtime as of the last time each plan was shown here, so a rewritten plan flags as new again.
const seen = store('planview.seen')
const collapsed = store('planview.collapsed')

let selectedId = null
let selectedPlan = null
let latest = { groups: [], older: [], awaiting: {} }
let showAll = false

const awaitingOn = (planId) => latest.awaiting?.[planId]

const timeOf = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

const flatten = (data) => [
  ...data.groups.flatMap((g) => g.plans.flatMap((p) => [p, ...p.children])),
  ...data.older,
]

/* ---------- sidebar ---------- */

function planButton(plan, isChild) {
  const button = document.createElement('button')
  button.className = `plan${isChild ? ' child' : ''}${plan.id === selectedId ? ' selected' : ''}`

  // Title and badges share one grid cell so the time can sit right-aligned in the other.
  const label = document.createElement('span')
  label.className = 'label'
  label.append(plan.title)
  if (plan.agentName) label.append(badge(plan.agentName))
  // A plan whose session is blocked is worth spotting without opening it.
  if (awaitingOn(plan.id)) label.append(badge('awaiting', 'awaiting'))
  if (plan.id !== selectedId && seen.get(plan.id) !== plan.mtime) label.append(badge('new', 'new'))
  button.append(label)

  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = timeOf(plan.mtime)
  button.append(time)

  button.addEventListener('click', () => open(plan))
  return button
}

function badge(text, extra = '') {
  const el = document.createElement('span')
  el.className = `badge ${extra}`.trim()
  el.textContent = text
  return el
}

function groupSection(key, label, plans, open) {
  const details = document.createElement('details')
  details.className = 'group'
  details.open = open

  const summary = document.createElement('summary')
  summary.textContent = `${label} (${plans.length})`
  details.append(summary)

  for (const plan of plans) {
    details.append(planButton(plan, false))
    for (const child of plan.children ?? []) details.append(planButton(child, true))
  }
  return details
}

function render(data) {
  tree.replaceChildren()

  for (const group of data.groups) {
    const section = groupSection(group.key, group.label, group.plans, !collapsed.get(group.key))
    section.addEventListener('toggle', () => collapsed.set(group.key, !section.open))
    tree.append(section)
  }

  if (data.older.length) {
    const section = groupSection('older', 'Older', showAll ? data.older : [], showAll)
    section.querySelector('summary').textContent = `Older (${data.older.length})`
    section.addEventListener('toggle', () => {
      showAll = section.open
      render(latest)
    })
    tree.append(section)
  }
}

/* ---------- reading pane ---------- */

async function open(plan) {
  const res = await fetch(`/api/plan?id=${encodeURIComponent(plan.id)}`)
  if (!res.ok) {
    doc.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'empty',
        textContent: `Could not read this plan (${res.status}).`,
      }),
    )
    // The old outline points at headings that are gone now, so its links would do nothing.
    clearOutline()
    return
  }

  const article = document.createElement('article')
  article.className = 'markdown'
  article.innerHTML = marked.parse(await res.text())

  wrapCodeBlocks(article)
  // Tables are what reliably overflow; each gets its own scroll container so the page never does.
  for (const table of article.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-scroll'
    table.replaceWith(wrap)
    wrap.append(table)
  }

  const keepScroll = plan.id === selectedId ? doc.scrollTop : 0
  doc.replaceChildren(article)
  doc.scrollTop = keepScroll

  showHeader(plan)
  renderOutline(article)

  selectedId = plan.id
  selectedPlan = plan
  seen.set(plan.id, plan.mtime)
  document.title = `${plan.title} — planview`
  renderApprove(plan)
  render(latest)
}

function showHeader(plan) {
  planHeader.hidden = false
  planTitle.textContent = plan.title
  planTitle.title = plan.title

  const time = document.createElement('span')
  time.textContent = timeOf(plan.mtime)

  const file = document.createElement('span')
  file.className = 'file'
  file.textContent = `${plan.id}.md`

  planMeta.replaceChildren(time, ...(plan.agentName ? [badge(plan.agentName)] : []), file)
}

/* ---------- approving a plan ---------- */

function renderApprove(plan) {
  const entry = plan && awaitingOn(plan.id)
  approve.hidden = !entry
  if (!entry) {
    approveButtons.replaceChildren()
    approveNote.textContent = ''
    return
  }

  // Options are read off the live terminal, so the buttons say exactly what the prompt says. Their
  // wording varies by build and context, and guessing it is what broke the first attempt.
  if (!entry.options?.length) {
    approveButtons.replaceChildren()
    approveNote.className = ''
    approveNote.textContent = 'reading the prompt…'
    return
  }

  approveNote.textContent = 'waiting in the terminal'
  approveNote.className = ''
  approveButtons.replaceChildren(
    ...entry.options.map((option) => {
      const button = document.createElement('button')
      // The option the prompt already has its cursor on is the one Enter would pick.
      button.className = `choice${option.selected ? ' primary' : ''}`
      button.textContent = option.label
      button.addEventListener('click', () => send(plan, entry.token, option))
      return button
    }),
  )
}

async function send(plan, token, option) {
  for (const button of approveButtons.querySelectorAll('button')) button.disabled = true
  approveNote.textContent = 'sending…'

  let res
  try {
    res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The label goes along so the server can refuse if the prompt changed since this was drawn.
      body: JSON.stringify({ planId: plan.id, token, ordinal: option.n, label: option.label }),
    })
  } catch {
    return fail('planview is not reachable')
  }

  if (res.ok) {
    const { chose } = await res.json().catch(() => ({}))
    approveNote.textContent = `sent — ${chose ?? 'answered'}`
    approveButtons.replaceChildren()
    return
  }

  // 409 is the expected, safe outcome when the prompt was already answered in the terminal.
  // Fall back to text: a body that is not JSON must still say something, or a status like 400 shows
  // up as a bare number with the reason thrown away.
  const body = await res.clone().json().catch(() => null)
  const reason = body?.error ?? (await res.text().catch(() => '')).trim()
  fail(reason || `failed (${res.status})`)
}

function fail(message) {
  approveNote.textContent = message
  approveNote.className = 'error'
  approveButtons.replaceChildren()
}

function wrapCodeBlocks(article) {
  for (const pre of article.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    // marked's `language-*` class has to be read before highlightElement rewrites the class list.
    const lang = code?.className.match(/language-([\w-]+)/)?.[1]

    const wrap = document.createElement('div')
    wrap.className = 'code'
    pre.replaceWith(wrap)
    if (lang) {
      const label = document.createElement('div')
      label.className = 'code-lang'
      label.textContent = lang
      wrap.append(label)
    }
    wrap.append(pre)

    if (code) hljs.highlightElement(code)
  }
}

/* ---------- outline rail ---------- */

let spy = []

function clearOutline() {
  spy = []
  outline.replaceChildren()
  rail.hidden = true
}

function renderOutline(article) {
  const headings = [...article.querySelectorAll('h2, h3')]
  const entries = buildOutline(
    headings.map((el) => ({ level: Number(el.tagName[1]), text: el.textContent })),
  )

  outline.replaceChildren()
  spy = entries.map((entry, i) => {
    headings[i].id = entry.id

    const link = document.createElement('a')
    link.href = `#${entry.id}`
    link.dataset.level = String(entry.level)
    link.textContent = entry.text
    link.addEventListener('click', (event) => {
      event.preventDefault()
      headings[i].scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    outline.append(link)

    return { heading: headings[i], link }
  })

  // A plan with no sections has nothing to navigate, so the rail gets out of the way.
  rail.hidden = spy.length === 0
  highlight()
}

function highlight() {
  const line = doc.getBoundingClientRect().top + 100
  let active = spy.length ? spy[0] : null
  for (const entry of spy) {
    if (entry.heading.getBoundingClientRect().top > line) break
    active = entry
  }
  for (const entry of spy) entry.link.classList.toggle('active', entry === active)
}

let queued = false
doc.addEventListener('scroll', () => {
  if (queued) return
  queued = true
  requestAnimationFrame(() => {
    queued = false
    highlight()
  })
})

/* ---------- live updates ---------- */

async function refresh() {
  latest = await (await fetch('/api/plans')).json()

  const newest = latest.groups[0]?.plans[0]
  // Revised-in-place counts as a change too, so a plan edited while open re-renders.
  const changed = newest && (newest.id !== selectedId || newest.mtime !== seen.get(newest.id))

  if (changed && !lockInput.checked) {
    await open(newest)
    return
  }
  render(latest)
  // The hook registering an approval arrives as an SSE change without the plan itself changing, so
  // the header controls have to be refreshed here too, not only when a plan is opened.
  if (selectedPlan) renderApprove(flatten(latest).find((p) => p.id === selectedId) ?? selectedPlan)

  // The hook fires at PreToolUse — BEFORE the prompt is drawn — so the first read of the screen
  // usually finds no options yet, and no further SSE event is coming. Poll until they show up.
  const blank = Object.values(latest.awaiting ?? {}).some((a) => !a.options?.length)
  if (blank) retryForOptions()
  else retries = 0
}

let retries = 0
let retryTimer = null

function retryForOptions() {
  if (retryTimer || retries >= 20) return
  retries++
  retryTimer = setTimeout(() => {
    retryTimer = null
    refresh()
  }, 800)
}

function connect() {
  const events = new EventSource('/events')
  events.addEventListener('open', () => status.classList.remove('offline'))
  events.addEventListener('message', refresh)
  events.addEventListener('error', () => {
    status.classList.add('offline')
    events.close()
    // Every reconnect refetches, so a change missed while disconnected is never lost.
    setTimeout(() => {
      connect()
      refresh()
    }, 1500)
  })
}

lockInput.addEventListener('change', refresh)
await refresh()
connect()
