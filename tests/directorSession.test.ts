import assert from 'node:assert/strict'
import test from 'node:test'
import { withDirectorSession } from '../src/director/directorSession.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const assertSessionLock = async () => {
  const gate = deferred()
  const first = withDirectorSession('locked-session', () => gate.promise.then(() => 'first'))
  await assert.rejects(withDirectorSession('locked-session', async () => 'second'), /正在处理这个会话的上一项行动/)
  assert.equal(await withDirectorSession('other-session', async () => 'other'), 'other')
  gate.resolve()
  assert.equal(await first, 'first')
  // 上一项行动结束（包括失败）后锁会释放。
  await assert.rejects(withDirectorSession('locked-session', async () => { throw new Error('模型请求失败') }), /模型请求失败/)
  assert.equal(await withDirectorSession('locked-session', async () => 'again'), 'again')
}

test('the session lock uses Web Locks when the runtime provides them', async () => {
  assert.ok(globalThis.navigator?.locks, '当前 Node 版本应提供 navigator.locks')
  const locks = globalThis.navigator.locks
  const requested: string[] = []
  const originalRequest = locks.request.bind(locks)
  Object.defineProperty(locks, 'request', {
    configurable: true,
    value: (name: string, ...rest: unknown[]) => {
      requested.push(name)
      return (originalRequest as (...args: unknown[]) => Promise<unknown>)(name, ...rest)
    },
  })
  try {
    await assertSessionLock()
    assert.ok(requested.includes('h3-director-session:locked-session'))
  } finally {
    Reflect.deleteProperty(locks, 'request')
  }
})

test('the session lock falls back to an in-memory set without navigator.locks', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
  try {
    await assertSessionLock()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
  }
})
