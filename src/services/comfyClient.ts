// 浏览器直连 cloud.comfy.org 会被跨域拦截，统一经本地服务端 /api/comfy/segment 转发。
export type ComfySegmentRequest = {
  prompt: string
  seconds: number
  startImage?: string
  referenceImages?: string[]
}

export type ComfySegmentStatus =
  | { status: 'running' }
  | { status: 'failed'; error: string }
  | { status: 'completed' }

const readError = async (response: Response, fallback: string) => {
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined
  return new Error(body?.error ?? `${fallback}（HTTP ${response.status}）`)
}

export const submitComfySegment = async (apiKey: string, request: ComfySegmentRequest) => {
  const response = await fetch('/api/comfy/segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Comfy-Key': apiKey },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw await readError(response, '提交 Comfy 任务失败')
  return await response.json() as { jobId: string }
}

export const getComfySegment = async (apiKey: string, jobId: string): Promise<ComfySegmentStatus> => {
  const response = await fetch(`/api/comfy/segment?id=${encodeURIComponent(jobId)}`, { headers: { 'X-Comfy-Key': apiKey } })
  if (!response.ok) throw await readError(response, '查询 Comfy 任务失败')
  return await response.json() as ComfySegmentStatus
}

export const fetchComfyVideo = async (apiKey: string, jobId: string) => {
  const response = await fetch(`/api/comfy/segment/video?id=${encodeURIComponent(jobId)}`, { headers: { 'X-Comfy-Key': apiKey } })
  if (!response.ok) throw await readError(response, '下载 Comfy 视频失败')
  return await response.blob()
}
