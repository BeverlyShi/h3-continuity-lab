import assert from 'node:assert/strict'
import test from 'node:test'
import { createBrowserSessionStore } from '../src/director/browserSessionStore.ts'
import { rewriteDirectorSegment, runDirectorAgent } from '../src/director/directorAgent.ts'
import { createMemoryKeyValueStore } from '../src/director/virtualFileSystem.ts'
import { streamDirectorTurn } from '../src/services/directorClient.ts'
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

test('the browser director requires and sends only the BigModel credential upstream for GLM', async () => {
  const originalFetch = globalThis.fetch
  const runtime = { store: createBrowserSessionStore(createMemoryKeyValueStore()), runDirectorAgent, rewriteDirectorSegment }
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
  try {
    for (const key of ['', 'bigmodel-key']) {
      const previousCalls = upstreamCalls
      await assert.rejects(streamDirectorTurn({
        bigModelApiKey: key,
        openRouterApiKey: 'wrong-or-key',
        deepseekApiKey: 'wrong-ds-key',
        model: 'z-ai/glm-5.3-flash',
        traceId: `trace-${key || 'missing'}`,
        context: { ok: true, sessionId: `session-${key || 'missing'}`, turn: 1, input: { type: 'start' } },
        onEvent: () => {},
        runtime,
      }), key ? /TEST_BIGMODEL_RESPONSE/ : /请先在设置里填写 智谱 BigModel API Key/)
      assert.equal(upstreamCalls - previousCalls, key ? 1 : 0)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
