import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserSessionStore } from '../src/director/browserSessionStore.ts'
import { DIRECTOR_SESSION_SCOPE, deleteDirectorSession } from '../src/director/sessionDatabase.ts'
import {
  createMemoryKeyValueStore,
  createVirtualFileSystem,
  type VirtualFsKeyValueStore,
} from '../src/director/virtualFileSystem.ts'

// 每次读写都让出事件循环，模拟 IndexedDB 的异步交错，用来暴露读-改-写的竞态。
const createSlowKeyValueStore = (): VirtualFsKeyValueStore => {
  const inner = createMemoryKeyValueStore()
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return {
    get: async (key) => { await tick(); return inner.get(key) },
    set: async (key, value) => { await tick(); await inner.set(key, value) },
    delete: async (key) => { await tick(); await inner.delete(key) },
    listKeys: async () => { await tick(); return inner.listKeys() },
  }
}

const userMessage = (text: string) => ({ role: 'user' as const, content: text, timestamp: Date.now() })

test('JsonlSessionRepo creates, lists, appends and reopens sessions on the virtual file system', async () => {
  const kv = createMemoryKeyValueStore()
  const store = createBrowserSessionStore(kv)

  assert.deepEqual(await store.repo.list({ cwd: store.scope }), [])
  const session = await store.repo.create({ id: 'game-1', cwd: store.scope, metadata: { kind: 'palace-story-director' } })
  await session.appendMessage(userMessage('请开始故事'))
  await session.appendCustomEntry('director_trace', { traceId: 'trace-1' })
  await session.appendMessage(userMessage('走向宫门'))
  await assert.rejects(store.repo.create({ id: 'game-1', cwd: store.scope }), /already exists/)

  // 换一个新的 repo 实例（相当于刷新页面）后仍能从同一份存储读回历史。
  const reloaded = createBrowserSessionStore(kv)
  const listed = await reloaded.repo.list({ cwd: reloaded.scope })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'game-1')
  assert.equal(listed[0].cwd, `/${DIRECTOR_SESSION_SCOPE}`)
  assert.deepEqual(listed[0].metadata, { kind: 'palace-story-director' })
  assert.match(listed[0].path, /^\/agent-traces\/--browser--\/.+_game-1\.jsonl$/)

  const reopened = await reloaded.repo.open(listed[0])
  const entries = await reopened.findEntries({ order: 'oldestFirst' })
  assert.deepEqual(entries.map((entry) => entry.type), ['message', 'custom', 'message'])
  assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3])
  await reopened.appendMessage(userMessage('第三次行动'))
  const again = await createBrowserSessionStore(kv).repo.open(listed[0])
  assert.equal((await again.findEntries({ order: 'oldestFirst' })).length, 4)

  await store.repo.create({ id: 'game-2', cwd: store.scope })
  assert.deepEqual((await store.repo.list({ cwd: store.scope })).map((metadata) => metadata.id).sort(), ['game-1', 'game-2'])
  assert.deepEqual(await store.repo.list({ cwd: 'other-scope' }), [])
  assert.equal((await store.repo.list()).length, 2)
})

test('deleteDirectorSession removes only the given game session', async () => {
  const kv = createMemoryKeyValueStore()
  const store = createBrowserSessionStore(kv)
  await (await store.repo.create({ id: 'keep', cwd: store.scope })).appendMessage(userMessage('保留'))
  await (await store.repo.create({ id: 'drop', cwd: store.scope })).appendMessage(userMessage('删除'))

  await deleteDirectorSession('drop', kv)
  assert.deepEqual((await store.repo.list({ cwd: store.scope })).map((metadata) => metadata.id), ['keep'])
  // 删除后可以用同一个 ID 重新开局。
  await store.repo.create({ id: 'drop', cwd: store.scope })
})

test('concurrent appends to the same file are serialized and never lose data', async () => {
  const fs = createVirtualFileSystem(createSlowKeyValueStore())
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index}\n`)
  const results = await Promise.all(lines.map((line) => fs.appendFile('/a/b.jsonl', line)))
  assert.ok(results.every((result) => result.ok))
  const content = await fs.readTextFile('/a/b.jsonl')
  assert.ok(content.ok)
  assert.equal(content.value, lines.join(''))
})

test('the virtual file system follows the FileSystem result conventions', async () => {
  const fs = createVirtualFileSystem(createMemoryKeyValueStore())

  assert.deepEqual(await fs.absolutePath('browser'), { ok: true, value: '/browser' })
  assert.deepEqual(await fs.absolutePath('/a/./b/../c/'), { ok: true, value: '/a/c' })
  assert.deepEqual(await fs.joinPath(['/agent-traces', '--browser--', 'x.jsonl']), { ok: true, value: '/agent-traces/--browser--/x.jsonl' })

  const missing = await fs.readTextFile('/nope.jsonl')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.code, 'not_found')
  assert.deepEqual(await fs.exists('/nope.jsonl'), { ok: true, value: false })
  const missingDir = await fs.listDir('/nope')
  assert.equal(!missingDir.ok && missingDir.error.code, 'not_found')
  const missingInfo = await fs.fileInfo('/nope')
  assert.equal(!missingInfo.ok && missingInfo.error.code, 'not_found')

  // 写文件时自动创建父目录。
  assert.ok((await fs.writeFile('/root/dir/a.jsonl', '第一行\r\n第二行\n第三行')).ok)
  assert.deepEqual(await fs.exists('/root/dir'), { ok: true, value: true })
  assert.deepEqual(await fs.readTextLines('/root/dir/a.jsonl', { maxLines: 1 }), { ok: true, value: ['第一行'] })
  assert.deepEqual(await fs.readTextLines('/root/dir/a.jsonl'), { ok: true, value: ['第一行', '第二行', '第三行'] })
  assert.deepEqual(await fs.readTextLines('/root/dir/a.jsonl', { maxLines: 0 }), { ok: true, value: [] })

  const info = await fs.fileInfo('/root/dir/a.jsonl')
  assert.ok(info.ok)
  assert.equal(info.value.kind, 'file')
  assert.equal(info.value.name, 'a.jsonl')
  assert.equal(info.value.size, new TextEncoder().encode('第一行\r\n第二行\n第三行').byteLength)

  assert.ok((await fs.createDir('/root/dir/sub')).ok)
  assert.ok((await fs.writeFile('/root/dir/sub/b.txt', new TextEncoder().encode('二进制写入'))).ok)
  assert.deepEqual(await fs.readTextFile('/root/dir/sub/b.txt'), { ok: true, value: '二进制写入' })
  const listed = await fs.listDir('/root/dir')
  assert.ok(listed.ok)
  assert.deepEqual(listed.value.map((entry) => [entry.name, entry.kind]).sort(), [['a.jsonl', 'file'], ['sub', 'directory']])

  assert.ok((await fs.renameFile('/root/dir/a.jsonl', '/root/dir/c.jsonl')).ok)
  assert.deepEqual(await fs.exists('/root/dir/a.jsonl'), { ok: true, value: false })
  assert.deepEqual(await fs.readTextFile('/root/dir/c.jsonl'), { ok: true, value: '第一行\r\n第二行\n第三行' })
  const renameMissing = await fs.renameFile('/root/dir/a.jsonl', '/root/dir/d.jsonl')
  assert.equal(!renameMissing.ok && renameMissing.error.code, 'not_found')

  const removeMissing = await fs.remove('/root/dir/a.jsonl')
  assert.equal(!removeMissing.ok && removeMissing.error.code, 'not_found')
  assert.ok((await fs.remove('/root/dir/a.jsonl', { force: true })).ok)
  const removeDir = await fs.remove('/root/dir')
  assert.equal(!removeDir.ok && removeDir.error.code, 'is_directory')
  assert.ok((await fs.remove('/root/dir', { recursive: true })).ok)
  assert.deepEqual(await fs.exists('/root/dir/sub/b.txt'), { ok: true, value: false })
  assert.deepEqual(await fs.exists('/root'), { ok: true, value: true })
})

test('backend failures are returned as results instead of thrown', async () => {
  const broken: VirtualFsKeyValueStore = {
    get: async () => { throw new Error('IndexedDB 不可用') },
    set: async () => { throw new Error('IndexedDB 不可用') },
    delete: async () => { throw new Error('IndexedDB 不可用') },
    listKeys: async () => { throw new Error('IndexedDB 不可用') },
  }
  const fs = createVirtualFileSystem(broken)
  for (const result of [
    await fs.readTextFile('/a'),
    await fs.appendFile('/a', 'x'),
    await fs.listDir('/'),
    await fs.exists('/a'),
  ]) {
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'unknown')
      assert.match(result.error.message, /IndexedDB 不可用/)
    }
  }
})
