import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parseTitle } from './store.js'

export const PLANS_DIR = join(process.env.HOME, '.claude', 'plans')

export async function scan(dir = PLANS_DIR) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    // No plans directory yet — an empty tree, not an error.
    return []
  }

  const entries = await Promise.all(
    names.filter((n) => n.endsWith('.md')).map((name) => read(dir, name)),
  )
  return entries.filter(Boolean)
}

async function read(dir, name) {
  const path = join(dir, name)
  try {
    const [info, text] = await Promise.all([stat(path), readFile(path, 'utf8')])
    return { id: name.replace(/\.md$/, ''), title: parseTitle(text), mtime: info.mtimeMs }
  } catch {
    // Deleted between listing and reading, or unreadable — drop it rather than break the tree.
    return null
  }
}
