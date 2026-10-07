// Comfy Cloud 的 CORS 只放行它自己的域名：浏览器把请求发到同源 /api/comfy/*，这里只做受限透传，不碰业务。
// 只用 Fetch API，开发服务器（server/comfyPlugin.ts）和 Cloudflare Worker 共用同一份处理函数。
export const COMFY_PROXY_PREFIX = '/api/comfy/'
const COMFY_UPSTREAM = 'https://cloud.comfy.org/api/'

// 参考图最多 9 张，单次上传一张；40MB 足够覆盖任何一次上传或提交。
const MAX_BODY_BYTES = 40 * 1024 * 1024

const ROUTES: { method: 'GET' | 'POST'; path: RegExp }[] = [
  { method: 'POST', path: /^upload\/image$/ },
  { method: 'POST', path: /^prompt$/ },
  { method: 'GET', path: /^job\/[A-Za-z0-9_-]+\/status$/ },
  { method: 'GET', path: /^jobs\/[A-Za-z0-9_-]+$/ },
  { method: 'GET', path: /^view$/ },
]

const RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control']

// 响应体不能带内容的状态码，构造 Response 时 body 必须为 null。
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

export type ComfyProxyOptions = {
  // 测试注入假的上游；省略时用全局 fetch。
  fetchImpl?: typeof fetch
}

const jsonError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })

// 只留必要的响应头（Set-Cookie 等一律丢掉），body 流式透传。
const passThrough = (upstream: Response) => {
  const headers = new Headers()
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  // 运行时可能已经解压了上游的 gzip 响应，原 Content-Length 对不上解压后的内容。
  if (upstream.headers.has('content-encoding')) headers.delete('content-length')
  const body = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers })
}

const isRedirect = (status: number) => status >= 300 && status < 400

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

export async function handleComfyProxy(request: Request, options: ComfyProxyOptions = {}): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(COMFY_PROXY_PREFIX)) return undefined
  const fetchImpl = options.fetchImpl ?? fetch

  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin) return jsonError(403, '只接受本站页面的请求。')

  const path = url.pathname.slice(COMFY_PROXY_PREFIX.length)
  if (!ROUTES.some((route) => route.method === request.method && route.path.test(path))) {
    return jsonError(404, '不支持的 Comfy 接口。')
  }

  const apiKey = request.headers.get('x-api-key')?.trim()
  if (!apiKey) return jsonError(401, '缺少 Comfy API Key。')

  const headers = new Headers({ 'X-API-Key': apiKey })
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)

  // RequestInit 的类型里还没有 duplex；Node 的 fetch 发送流式 body 时必须带上，Worker 会忽略。
  const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, redirect: 'manual' }
  if (request.method === 'POST') {
    // 不读 body，只看声明的长度：没有长度的流式上传无法限流，直接拒绝。
    const length = request.headers.get('content-length')
    if (length === null) return jsonError(411, '请求缺少 Content-Length。')
    if (!/^\d+$/.test(length)) return jsonError(400, 'Content-Length 无效。')
    if (Number(length) > MAX_BODY_BYTES) return jsonError(413, '请求内容超过 40MB。')
    headers.set('Content-Length', length)
    init.body = request.body
    init.duplex = 'half'
  }

  const upstreamUrl = `${COMFY_UPSTREAM}${path}${url.search}`
  let upstream: Response
  try {
    upstream = await fetchImpl(upstreamUrl, init)
  } catch (error) {
    return jsonError(502, `连接 Comfy Cloud 失败：${errorMessage(error)}`)
  }
  if (path !== 'view' || !isRedirect(upstream.status)) return passThrough(upstream)

  // /api/view 返回 302 到短时签名的存储地址：这里替浏览器取回视频，且不能把 X-API-Key 带给存储服务。
  await upstream.body?.cancel().catch(() => {})
  const location = upstream.headers.get('location')
  let target: URL
  try {
    target = new URL(location ?? '', upstreamUrl)
  } catch {
    return jsonError(502, 'Comfy 返回的视频地址无效。')
  }
  if (!location || target.protocol !== 'https:') return jsonError(502, 'Comfy 返回的视频地址无效。')
  try {
    return passThrough(await fetchImpl(target.href))
  } catch (error) {
    return jsonError(502, `下载 Comfy 视频失败：${errorMessage(error)}`)
  }
}
