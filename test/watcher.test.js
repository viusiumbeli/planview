import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWatcher } from '../src/watcher.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'planview-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('watcher emits changed after a plan is written', async () => {
  await withTempDir(async (dir) => {
    let fired = 0
    const watcher = createWatcher(dir, { debounceMs: 30, pollMs: 10_000 })
    watcher.on('changed', () => fired++)

    await writeFile(join(dir, 'a.md'), '# A')
    await sleep(200)
    watcher.stop()

    assert.equal(fired, 1)
  })
})

test('watcher coalesces a burst of writes into a single emit', async () => {
  await withTempDir(async (dir) => {
    let fired = 0
    const watcher = createWatcher(dir, { debounceMs: 80, pollMs: 10_000 })
    watcher.on('changed', () => fired++)

    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      await writeFile(join(dir, name), '# x')
      await sleep(5)
    }
    await sleep(250)
    watcher.stop()

    assert.equal(fired, 1)
  })
})

test('watcher still detects a change when no filesystem event arrives', async () => {
  await withTempDir(async (dir) => {
    let fired = 0
    // A deaf watch stands in for macOS dropping the event on an atomic replace.
    const watcher = createWatcher(dir, {
      debounceMs: 10,
      pollMs: 40,
      watchFactory: () => ({ close() {} }),
    })
    watcher.on('changed', () => fired++)

    await writeFile(join(dir, 'a.md'), '# A')
    await sleep(300)
    watcher.stop()

    assert.ok(fired >= 1, `expected the poll to fire at least once, got ${fired}`)
  })
})

test('watcher goes quiet after stop', async () => {
  await withTempDir(async (dir) => {
    let fired = 0
    const watcher = createWatcher(dir, { debounceMs: 20, pollMs: 40 })
    watcher.on('changed', () => fired++)
    watcher.stop()

    await writeFile(join(dir, 'a.md'), '# A')
    await sleep(200)

    assert.equal(fired, 0)
  })
})

test('watcher emits once per change even though both the watch and the poll see it', async () => {
  await withTempDir(async (dir) => {
    let fired = 0
    const watcher = createWatcher(dir, { debounceMs: 20, pollMs: 60 })
    watcher.on('changed', () => fired++)

    await writeFile(join(dir, 'a.md'), '# A')
    await sleep(400) // several poll cycles
    watcher.stop()

    assert.equal(fired, 1)
  })
})
