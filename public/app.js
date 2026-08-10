const tree = document.getElementById('tree')
const pane = document.getElementById('pane')
const status = document.getElementById('status')
const lockInput = document.getElementById('lock-input')

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
let latest = { groups: [], older: [] }
let showAll = false

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

  const title = document.createElement('span')
  title.textContent = plan.title
  button.append(title)

  if (plan.agentName) button.append(badge(plan.agentName))
  if (plan.id !== selectedId && seen.get(plan.id) !== plan.mtime) button.append(badge('new', 'new'))

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
    pane.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'empty',
        textContent: `Could not read this plan (${res.status}).`,
      }),
    )
    return
  }

  const article = document.createElement('article')
  article.className = 'markdown'
  article.innerHTML = marked.parse(await res.text())

  for (const block of article.querySelectorAll('pre code')) hljs.highlightElement(block)
  // Tables are what reliably overflow; each gets its own scroll container so the page never does.
  for (const table of article.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-scroll'
    table.replaceWith(wrap)
    wrap.append(table)
  }

  const keepScroll = plan.id === selectedId ? pane.scrollTop : 0
  pane.replaceChildren(article)
  pane.scrollTop = keepScroll

  selectedId = plan.id
  seen.set(plan.id, plan.mtime)
  document.title = `${plan.title} — planview`
  render(latest)
}

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
