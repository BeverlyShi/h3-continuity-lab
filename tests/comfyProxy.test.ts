import assert from 'node:assert/strict'
import test from 'node:test'
import { handleComfyProxy } from '../worker/comfyProxy.ts'

const SITE = 'https://lab.example'

type UpstreamCall = { url: string; init?: RequestInit; body?: string }

// 假的上游：记录每次请求（含 body 原文），按顺序回放预设响应。
const fakeUpstream = (...responses: Array<Response | Error>) => {
  const calls: UpstreamCall[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? await new Response(init.body).text() : undefined
    calls.push({ url: String(url), init, body })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected ${String(url)}`)
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
  return { calls, fetchImpl }
}

const proxy = (path: string, init: RequestInit = {}, upstream = fakeUpstream(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))) =>
  handleComfyProxy(new Request(`${SITE}${path}`, init), { fetchImpl: upstream.fetchImpl })

const withKey = (headers: Record<string, string> = {}) => ({ 'X-API-Key': 'comfyui-test', ...headers })

const errorOf = async (response: Response | undefined) => (await response!.json() as { error: string }).error

const upstreamHeaders = (call: UpstreamCall) => new Headers(call.init?.headers)

test('leaves paths outside /api/comfy/ to the static assets', async () => {
  const upstream = fakeUpstream()
  assert.equal(await proxy('/index.html', {}, upstream), undefined)
  assert.equal(await proxy('/api/comfyx/prompt', {}, upstream), undefined)
  assert.equal(upstream.calls.length, 0)
})

test('passes whitelisted endpoints through with the path and query mapped to Comfy Cloud', async () => {
  const cases: Array<[string, string, string]> = [
    ['GET', '/api/comfy/job/abc-123_X/status', 'https://cloud.comfy.org/api/job/abc-123_X/status'],
    ['GET', '/api/comfy/jobs/abc-123', 'https://cloud.comfy.org/api/jobs/abc-123'],
    ['GET', '/api/comfy/view?filename=a.mp4&subfolder=&type=output', 'https://cloud.comfy.org/api/view?filename=a.mp4&subfolder=&type=output'],
    ['POST', '/api/comfy/prompt', 'https://cloud.comfy.org/api/prompt'],
    ['POST', '/api/comfy/upload/image', 'https://cloud.comfy.org/api/upload/image'],
  ]
  for (const [method, path, expected] of cases) {
    const upstream = fakeUpstream(new Response('{}'))
    const body = method === 'POST' ? '{"a":1}' : undefined
    const headers = withKey(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {})
    const response = await proxy(path, { method, headers, body }, upstream)
    assert.equal(response?.status, 200, path)
    assert.equal(upstream.calls[0].url, expected)
    assert.equal(upstream.calls[0].init?.method, method)
    if (body) assert.equal(upstream.calls[0].body, body)
  }
})

test('rejects anything outside the whitelist with 404', async () => {
  const rejected: Array<[string, string]> = [
    ['GET', '/api/comfy/nope'],
    ['GET', '/api/comfy/prompt'],
    ['POST', '/api/comfy/view'],
    ['DELETE', '/api/comfy/jobs/abc'],
    ['GET', '/api/comfy/jobs/abc/extra'],
    ['GET', '/api/comfy/jobs/a%2Fb'],
    ['GET', '/api/comfy/job/a.b/status'],
    ['GET', '/api/comfy/upload/image'],
  ]
  for (const [method, path] of rejected) {
    const upstream = fakeUpstream()
    const response = await proxy(path, { method, headers: withKey() }, upstream)
    assert.equal(response?.status, 404, `${method} ${path}`)
    assert.match(await errorOf(response), /不支持/)
    assert.equal(upstream.calls.length, 0)
  }
})

test('only serves pages from the same origin', async () => {
  const upstream = fakeUpstream(new Response('{}'))
  const foreign = await proxy('/api/comfy/jobs/abc', { headers: withKey({ Origin: 'https://evil.example' }) }, upstream)
  assert.equal(foreign?.status, 403)
  assert.equal(upstream.calls.length, 0)
  const same = await proxy('/api/comfy/jobs/abc', { headers: withKey({ Origin: SITE }) }, upstream)
  assert.equal(same?.status, 200)
})

test('requires an API key', async () => {
  const upstream = fakeUpstream()
  const response = await proxy('/api/comfy/jobs/abc', { headers: { 'X-API-Key': '  ' } }, upstream)
  assert.equal(response?.status, 401)
  assert.match(await errorOf(response), /API Key/)
  assert.equal(upstream.calls.length, 0)
})

test('checks the declared body size before reading it', async () => {
  const upstream = fakeUpstream()
  // Request 会给字符串 body 自动补 Content-Length，用流式 body 模拟缺失的情况。
  const stream = new Blob(['{}']).stream()
  const missing = await proxy('/api/comfy/prompt', { method: 'POST', headers: withKey(), body: stream, duplex: 'half' } as RequestInit, upstream)
  assert.equal(missing?.status, 411)
  const tooLarge = await proxy('/api/comfy/upload/image', { method: 'POST', headers: withKey({ 'Content-Length': String(40 * 1024 * 1024 + 1) }), body: 'x' }, upstream)
  assert.equal(tooLarge?.status, 413)
  assert.equal(upstream.calls.length, 0)
})

test('forwards only the key and content headers upstream', async () => {
  const upstream = fakeUpstream(new Response('{}'))
  const body = '{"prompt":{}}'
  await proxy('/api/comfy/prompt', {
    method: 'POST',
    headers: withKey({
      Origin: SITE,
      Referer: `${SITE}/game`,
      Cookie: 'session=1',
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'X-Forwarded-For': '1.2.3.4',
    }),
    body,
  }, upstream)
  const headers = upstreamHeaders(upstream.calls[0])
  assert.deepEqual([...headers.keys()].sort(), ['content-length', 'content-type', 'x-api-key'])
  assert.equal(headers.get('x-api-key'), 'comfyui-test')
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(headers.get('content-length'), String(body.length))
  assert.equal(upstream.calls[0].init?.redirect, 'manual')
})

test('passes status and body through but drops cookies and other headers', async () => {
  const upstream = fakeUpstream(new Response('{"message":"bad key"}', {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'a=1', 'Cache-Control': 'no-store', 'X-Internal': 'yes' },
  }))
  const response = await proxy('/api/comfy/job/abc/status', { headers: withKey() }, upstream)
  assert.equal(response?.status, 401)
  assert.equal(await response?.text(), '{"message":"bad key"}')
  assert.equal(response?.headers.get('set-cookie'), null)
  assert.equal(response?.headers.get('x-internal'), null)
  assert.equal(response?.headers.get('content-type'), 'application/json')
  assert.equal(response?.headers.get('cache-control'), 'no-store')
})

test('follows the view redirect without sending the key to storage', async () => {
  const upstream = fakeUpstream(
    new Response(null, { status: 302, headers: { Location: 'https://storage.example/signed/a.mp4?sig=1' } }),
    new Response('video-bytes', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '11', 'Set-Cookie': 'b=2' } }),
  )
  const response = await proxy('/api/comfy/view?filename=a.mp4&type=output', { headers: withKey() }, upstream)
  assert.equal(response?.status, 200)
  assert.equal(response?.headers.get('content-type'), 'video/mp4')
  assert.equal(response?.headers.get('set-cookie'), null)
  assert.equal(await response?.text(), 'video-bytes')
  assert.equal(upstream.calls[0].init?.redirect, 'manual')
  assert.equal(upstreamHeaders(upstream.calls[0]).get('x-api-key'), 'comfyui-test')
  assert.equal(upstream.calls[1].url, 'https://storage.example/signed/a.mp4?sig=1')
  assert.equal(upstreamHeaders(upstream.calls[1]).get('x-api-key'), null)
  assert.equal([...upstreamHeaders(upstream.calls[1]).keys()].length, 0)
})

test('passes a direct view response through and refuses non-https redirects', async () => {
  const direct = fakeUpstream(new Response('video', { headers: { 'Content-Type': 'video/mp4' } }))
  const response = await proxy('/api/comfy/view?filename=a.mp4', { headers: withKey() }, direct)
  assert.equal(await response?.text(), 'video')
  assert.equal(direct.calls.length, 1)

  for (const location of ['http://storage.example/a.mp4', 'file:///etc/passwd']) {
    const upstream = fakeUpstream(new Response(null, { status: 302, headers: { Location: location } }))
    const refused = await proxy('/api/comfy/view?filename=a.mp4', { headers: withKey() }, upstream)
    assert.equal(refused?.status, 502, location)
    assert.equal(upstream.calls.length, 1)
  }
})

test('turns upstream network errors into 502', async () => {
  const response = await proxy('/api/comfy/jobs/abc', { headers: withKey() }, fakeUpstream(new TypeError('fetch failed')))
  assert.equal(response?.status, 502)
  assert.match(await errorOf(response), /fetch failed/)

  const storage = fakeUpstream(
    new Response(null, { status: 302, headers: { Location: 'https://storage.example/a.mp4' } }),
    new TypeError('storage down'),
  )
  const video = await proxy('/api/comfy/view?filename=a.mp4', { headers: withKey() }, storage)
  assert.equal(video?.status, 502)
  assert.match(await errorOf(video), /storage down/)
})
