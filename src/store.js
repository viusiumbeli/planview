const AGENT_MARKER = '-agent-'

// Claude names a subagent plan `<parent>-agent-a[<agent-name>-]<16 hex>`. The trailing hex is what
// distinguishes a real suffix from a plan whose own slug happens to contain "-agent-".
const AGENT_SUFFIX = /^a(?:([a-z0-9-]*)-)?[0-9a-f]{16}$/

export function parseFilename(filename) {
  const id = filename.replace(/\.md$/, '')
  const at = id.lastIndexOf(AGENT_MARKER)
  if (at === -1) return { id, parentId: null, agentName: null }

  const suffix = AGENT_SUFFIX.exec(id.slice(at + AGENT_MARKER.length))
  if (!suffix) return { id, parentId: null, agentName: null }

  return { id, parentId: id.slice(0, at), agentName: suffix[1] ?? null }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayKey = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

const WINDOW_DAYS = 7

const daysAgo = (ms, now) => Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)

const dayLabel = (ms, now) => {
  const days = daysAgo(ms, now)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'

  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

const startOfDay = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const newestFirst = (a, b) => b.mtime - a.mtime

export function buildTree(entries, now) {
  const present = new Set(entries.map((e) => e.id))
  const nodes = new Map()
  const roots = []

  for (const e of [...entries].sort(newestFirst)) {
    const { parentId, agentName } = parseFilename(e.id)
    const node = { ...e, title: e.title ?? e.id, agentName, children: [] }
    nodes.set(e.id, node)
    // An orphan — parent deleted — stands on its own rather than vanishing from the tree.
    if (!(parentId && present.has(parentId))) roots.push(node)
  }

  for (const node of nodes.values()) {
    const { parentId } = parseFilename(node.id)
    if (parentId && nodes.has(parentId)) nodes.get(parentId).children.push(node)
  }
  for (const node of nodes.values()) node.children.sort(newestFirst)

  const byDay = new Map()
  const older = []
  for (const node of roots) {
    // Only roots age out — a child follows its parent however old it is.
    if (daysAgo(node.mtime, now) >= WINDOW_DAYS) {
      older.push(node)
      continue
    }
    const key = dayKey(node.mtime)
    if (!byDay.has(key)) byDay.set(key, { key, label: dayLabel(node.mtime, now), plans: [] })
    byDay.get(key).plans.push(node)
  }

  return { groups: [...byDay.values()], older }
}

export function parseTitle(text) {
  const withoutFences = text.replace(/^```[\s\S]*?^```/gm, '')
  const match = withoutFences.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}
