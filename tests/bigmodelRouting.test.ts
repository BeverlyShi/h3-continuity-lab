import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { loadBigModelApiKey, saveBigModelApiKey } from '../src/services/localStorage.ts'

test('stores and clears the BigModel key independently', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['h3-continuity-lab:deepseek-key', 'deepseek-key']])
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } })
  try {
    assert.equal(loadBigModelApiKey(), '')
    saveBigModelApiKey('bigmodel-key')
    assert.equal(loadBigModelApiKey(), 'bigmodel-key')
    saveBigModelApiKey('')
    assert.equal(loadBigModelApiKey(), '')
    assert.equal(values.get('h3-continuity-lab:deepseek-key'), 'deepseek-key')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('the director endpoint requires and forwards only the BigModel credential upstream for GLM', async () => {
  const originalFetch = globalThis.fetch
  const previousCwd = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'bigmodel-routing-'))
  process.chdir(directory)
  const { directorPlugin } = await import('../server/directorPlugin.ts')
  const vite = await createServer({ configFile: false, plugins: [directorPlugin()], server: { middlewareMode: true }, appType: 'custom' })
  const http = createHttpServer(vite.middlewares)
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    let upstreamCalls = 0
    globalThis.fetch = async (url, init) => {
      upstreamCalls += 1
      assert.equal(String(url), 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer bigmodel-key')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, 'glm-5.3-flash')
      assert.equal(body.thinking.type, 'enabled')
      assert.equal(body.reasoning_effort, 'low')
      assert.equal('tool_choice' in body, false)
      return new Response(JSON.stringify({ error: { message: 'TEST_BIGMODEL_RESPONSE' } }), { status: 401 })
    }
    for (const agent of ['pi']) {
      for (const key of ['', 'bigmodel-key']) {
        const previousCalls = upstreamCalls
        const response = await originalFetch(`http://127.0.0.1:${address.port}/api/director/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-BigModel-Key': key, 'X-OpenRouter-Key': 'wrong-or-key', 'X-DeepSeek-Key': 'wrong-ds-key' },
          body: JSON.stringify({ agent, model: 'z-ai/glm-5.3-flash', traceId: `trace-${agent}`, actors: [], castings: [], context: {
            ok: true, sessionId: `session-${agent}`, turn: 1, input: { type: 'start' },
          } }),
        })
        assert.match(await response.text(), key ? /TEST_BIGMODEL_RESPONSE/ : /请先配置 BIGMODEL_API_KEY/)
        assert.equal(upstreamCalls - previousCalls, key ? 1 : 0)
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()))
    await vite.close()
    process.chdir(previousCwd)
    await rm(directory, { recursive: true, force: true })
  }
})
