import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createComfyProxyFetch,
  fetchComfyVideo,
  getComfySegment,
  submitComfySegment,
} from '../src/services/comfyClient.ts'

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('rewrites Comfy Cloud API addresses to the same-origin proxy', async () => {
  const urls: string[] = []
  const proxyFetch = createComfyProxyFetch((async (url: string | URL | Request) => {
    urls.push(String(url))
    return new Response('{}')
  }) as typeof fetch)
  await proxyFetch('https://cloud.comfy.org/api/job/abc/status')
  await proxyFetch(new URL('https://cloud.comfy.org/api/view?filename=a.mp4&type=output'))
  await proxyFetch('https://v3.fal.media/files/a.png')
  assert.deepEqual(urls, [
    '/api/comfy/job/abc/status',
    '/api/comfy/view?filename=a.mp4&type=output',
    'https://v3.fal.media/files/a.png',
  ])
})

// 三个对外函数走全局 fetch：临时替换掉，记录浏览器实际发出的请求。
const installFetch = (handler: (url: string, init?: RequestInit) => Response) => {
  const original = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('submits, polls and downloads through /api/comfy/ with the key header', async () => {
  const stub = installFetch((url) => {
    if (url === '/api/comfy/prompt') return jsonResponse({ prompt_id: 'job-1', node_errors: {} })
    if (url === '/api/comfy/job/job-1/status') return jsonResponse({ status: 'success' })
    if (url === '/api/comfy/jobs/job-1') return jsonResponse({ outputs: { 9: { video: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] } } })
    if (url.startsWith('/api/comfy/view?')) return new Response('video-bytes', { headers: { 'Content-Type': 'video/mp4' } })
    throw new Error(`unexpected ${url}`)
  })
  try {
    assert.equal((await submitComfySegment('comfyui-test', { prompt: 'p', seconds: 5 })).jobId, 'job-1')
    assert.deepEqual(await getComfySegment('comfyui-test', 'job-1'), { status: 'completed' })
    const blob = await fetchComfyVideo('comfyui-test', 'job-1')
    assert.equal(blob.type, 'video/mp4')
    assert.equal(await blob.text(), 'video-bytes')

    assert.ok(stub.calls.every((call) => call.url.startsWith('/api/comfy/')))
    assert.ok(stub.calls.every((call) => (call.init?.headers as Record<string, string>)['X-API-Key'] === 'comfyui-test'))
    const view = stub.calls.find((call) => call.url.startsWith('/api/comfy/view?'))!
    assert.equal(view.url, '/api/comfy/view?filename=out.mp4&subfolder=&type=output')
    assert.equal(view.init?.redirect, undefined, '浏览器里 manual 只能拿到 opaqueredirect，由转发层跟随跳转')
  } finally {
    stub.restore()
  }
})

test('validates the segment request in the browser before submitting', async () => {
  const stub = installFetch(() => { throw new Error('不应发出请求') })
  try {
    await assert.rejects(submitComfySegment('k', { prompt: 'p', seconds: 4 }), /5–15/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('shows proxy errors from the JSON error field', async () => {
  const stub = installFetch(() => jsonResponse({ error: '缺少 Comfy API Key。' }, 401))
  try {
    await assert.rejects(getComfySegment('k', 'job-1'), /HTTP 401（API Key 无效）：缺少 Comfy API Key。/)
  } finally {
    stub.restore()
  }
})
