import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClaudeMap } from '../src/claude-map.js'

const AGTERM = 'B1453195-E3AC-4E14-8069-14DFBCA75DC2'
const CLAUDE = '59d9aaf9-a623-4c76-bdec-d7b46a6d0aac'
const CWD = '/Users/someone/personal/proj'
const SLUG = '-Users-someone-personal-proj'

async function setup({ psScan = async () => new Map() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'planview-claude-map-'))
  const projectsDir = join(dir, 'projects')
  await mkdir(projectsDir, { recursive: true })
  const map = createClaudeMap({
    statePath: join(dir, 'state', 'claude-map.json'),
    projectsDir,
    psScan,
    resolveTtlMs: 0, // tests want every resolve computed, not memoised
  })
  return { dir, projectsDir, map }
}

const transcript = async (projectsDir, slug, name) => {
  const project = join(projectsDir, slug)
  await mkdir(project, { recursive: true })
  const path = join(project, name)
  await writeFile(path, '{"type":"user","cwd":"' + CWD + '"}\n')
  return path
}

test('a hook registration wins and survives a daemon restart', async () => {
  const { dir, projectsDir, map } = await setup()
  const path = await transcript(projectsDir, SLUG, `${CLAUDE}.jsonl`)

  assert.equal(await map.register({ agtermSessionId: AGTERM, claudeSessionId: CLAUDE, transcriptPath: path, cwd: CWD }), true)
  const resolved = await map.resolve(AGTERM, { cwd: CWD })
  assert.equal(resolved.confidence, 'hook')
  assert.equal(resolved.transcriptPath, path)
  assert.equal(resolved.claudeSessionId, CLAUDE)

  // A second map on the same state file — the restarted daemon — still knows.
  const reborn = createClaudeMap({
    statePath: join(dir, 'state', 'claude-map.json'),
    projectsDir,
    psScan: async () => new Map(),
  })
  assert.equal((await reborn.resolve(AGTERM, { cwd: CWD })).confidence, 'hook')
})

test('registration is refused for junk ids or a path outside the transcripts tree', async () => {
  const { map } = await setup()

  assert.equal(await map.register({ agtermSessionId: 'nope', claudeSessionId: CLAUDE, transcriptPath: '/x.jsonl' }), null)
  assert.equal(await map.register({ agtermSessionId: AGTERM, claudeSessionId: 'nope', transcriptPath: '/x.jsonl' }), null)
  assert.equal(
    await map.register({ agtermSessionId: AGTERM, claudeSessionId: CLAUDE, transcriptPath: '/etc/passwd' }),
    null,
  )
  assert.equal(
    await map.register({
      agtermSessionId: AGTERM,
      claudeSessionId: CLAUDE,
      transcriptPath: '/anywhere/else/x.jsonl',
    }),
    null,
  )
})

test('a stale hook entry whose transcript vanished falls through to the next source', async () => {
  const { projectsDir, map } = await setup()
  const gone = join(projectsDir, SLUG, 'deleted.jsonl')
  await mkdir(join(projectsDir, SLUG), { recursive: true })
  // Register against a file that then "vanishes" (never written).
  await writeFile(gone, 'x\n')
  await map.register({ agtermSessionId: AGTERM, claudeSessionId: CLAUDE, transcriptPath: gone, cwd: CWD })
  const { rm } = await import('node:fs/promises')
  await rm(gone)
  const other = await transcript(projectsDir, SLUG, `${CLAUDE}.jsonl`)

  const resolved = await map.resolve(AGTERM, { cwd: CWD, restoreCommand: `claude --resume ${CLAUDE}` })
  assert.equal(resolved.confidence, 'restore')
  assert.equal(resolved.transcriptPath, other)
})

test('a pinned restore command names the transcript outright', async () => {
  const { projectsDir, map } = await setup()
  const path = await transcript(projectsDir, SLUG, `${CLAUDE}.jsonl`)

  const resolved = await map.resolve(AGTERM, { cwd: CWD, restoreCommand: `cd x && claude --resume ${CLAUDE}` })
  assert.equal(resolved.confidence, 'restore')
  assert.equal(resolved.transcriptPath, path)
})

test('a live claude process narrows a guess to ps confidence', async () => {
  const psScan = async () => new Map([[AGTERM, 12345]])
  const { projectsDir, map } = await setup({ psScan })
  const path = await transcript(projectsDir, SLUG, `${CLAUDE}.jsonl`)

  const resolved = await map.resolve(AGTERM, { cwd: CWD })
  assert.equal(resolved.confidence, 'ps')
  assert.equal(resolved.transcriptPath, path)
})

test('with nothing else, the newest transcript in the cwd project dir is a labeled guess', async () => {
  const { projectsDir, map } = await setup()
  await transcript(projectsDir, SLUG, 'older.jsonl')
  await new Promise((resolve) => setTimeout(resolve, 10))
  const newest = await transcript(projectsDir, SLUG, 'newest.jsonl')

  const resolved = await map.resolve(AGTERM, { cwd: CWD })
  assert.equal(resolved.confidence, 'guessed')
  assert.equal(resolved.transcriptPath, newest)
})

test('no cwd and no registration resolves to null, not an exception', async () => {
  const { map } = await setup()

  assert.equal(await map.resolve(AGTERM, {}), null)
  assert.equal(await map.resolve(AGTERM, { cwd: '/nowhere/at/all' }), null)
})

test('the state file is human-readable json with one entry per agterm session', async () => {
  const { dir, projectsDir, map } = await setup()
  const path = await transcript(projectsDir, SLUG, `${CLAUDE}.jsonl`)
  await map.register({ agtermSessionId: AGTERM, claudeSessionId: CLAUDE, transcriptPath: path, cwd: CWD })

  const state = JSON.parse(await readFile(join(dir, 'state', 'claude-map.json'), 'utf8'))
  assert.equal(state.version, 1)
  assert.equal(state.entries[AGTERM].claudeSessionId, CLAUDE)
})
