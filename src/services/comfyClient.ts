import {
  COMFY_BASE_URL,
  createComfyClient,
  validateComfySegmentRequest,
  type ComfyJobStatus,
  type ComfySegmentRequest,
} from '../comfy/comfyVideo.ts'

export type { ComfyJobStatus, ComfySegmentRequest }

// 浏览器直连 cloud.comfy.org 会被跨域拦截：业务逻辑在浏览器里跑，请求经同源转发层 /api/comfy/* 原样转给 Comfy Cloud。
export const COMFY_PROXY_PREFIX = '/api/comfy/'
const COMFY_API_PREFIX = `${COMFY_BASE_URL}/api/`

// 把 https://cloud.comfy.org/api/<rest> 改写为 /api/comfy/<rest>，其余地址原样请求。
export const createComfyProxyFetch = (fetchImpl: typeof fetch): typeof fetch => (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : undefined
  return fetchImpl(url?.startsWith(COMFY_API_PREFIX) ? `${COMFY_PROXY_PREFIX}${url.slice(COMFY_API_PREFIX.length)}` : input, init)
}

// 每次调用时再取全局 fetch，测试可以替换。
const proxyFetch = createComfyProxyFetch((input, init) => fetch(input, init))

export const submitComfySegment = async (apiKey: string, request: ComfySegmentRequest): Promise<{ jobId: string }> =>
  await createComfyClient(apiKey, proxyFetch).submitSegment(validateComfySegmentRequest(request))

export const submitComfyPortrait = async (apiKey: string, prompt: string): Promise<{ jobId: string }> =>
  await createComfyClient(apiKey, proxyFetch).submitPortrait(prompt)

export const getComfyJobStatus = async (apiKey: string, jobId: string): Promise<ComfyJobStatus> =>
  await createComfyClient(apiKey, proxyFetch).getJobStatus(jobId)

export const fetchComfyVideo = async (apiKey: string, jobId: string) => {
  const response = await createComfyClient(apiKey, proxyFetch).fetchVideo(jobId)
  return await response.blob()
}

export const fetchComfyImage = async (apiKey: string, jobId: string) => {
  const response = await createComfyClient(apiKey, proxyFetch).fetchImage(jobId)
  return await response.blob()
}
