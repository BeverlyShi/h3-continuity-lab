import h3MaxR2v from './workflows/h3_max_r2v.json' with { type: 'json' }
import h3MaxTurboT2v from './workflows/h3_max_turbo_t2v.json' with { type: 'json' }
import gptImage2Portrait from './workflows/gpt_image_2_portrait.json' with { type: 'json' }

// 工作流取自 Comfy 官方 H3 模板（API 格式），分辨率改成最低档 480P、参考细节改成 standard 换出片速度；程序只填 prompt、秒数、种子和图片，其余参数保持模板原值。
export const COMFY_BASE_URL = 'https://cloud.comfy.org'

type WorkflowNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }
export type ComfyWorkflow = Record<string, WorkflowNode>

const WORKFLOWS: Record<'t2v' | 'r2v', ComfyWorkflow> = {
  t2v: h3MaxTurboT2v,
  r2v: h3MaxR2v,
}

const VIDEO_NODE_ID = '2'
const MAX_REFERENCE_IMAGES = 9

export type ComfySegmentRequest = {
  prompt: string
  seconds: number
  // data:image/ 或 http(s) 地址，顺序即 prompt 里的图号：人物参考图在前，上一段尾帧（画面参考）在最后。
  referenceImages?: string[]
}

export type ComfyWorkflowKind = keyof typeof WORKFLOWS

export const chooseWorkflowKind = (request: ComfySegmentRequest): ComfyWorkflowKind =>
  request.referenceImages?.length ? 'r2v' : 't2v'

export const validateComfySegmentRequest = (value: unknown): ComfySegmentRequest => {
  if (!value || typeof value !== 'object') throw new Error('请求内容无效。')
  const body = value as Partial<ComfySegmentRequest>
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('缺少视频 prompt。')
  if (!Number.isInteger(body.seconds) || body.seconds! < 5 || body.seconds! > 15) {
    throw new Error('H3 单段时长必须是 5–15 的整数秒。')
  }
  const isImage = (image: unknown): image is string =>
    typeof image === 'string' && /^(data:image\/|https?:\/\/)/.test(image)
  if (body.referenceImages !== undefined) {
    if (!Array.isArray(body.referenceImages) || !body.referenceImages.every(isImage)) throw new Error('参考图地址无效。')
    if (body.referenceImages.length > MAX_REFERENCE_IMAGES) throw new Error(`参考图最多 ${MAX_REFERENCE_IMAGES} 张。`)
  }
  return {
    prompt: body.prompt,
    seconds: body.seconds!,
    ...(body.referenceImages?.length ? { referenceImages: body.referenceImages } : {}),
  }
}

const PORTRAIT_NODE_ID = '1'

// 演员三视图：GPT Image 2 medium，2048x1152（16:9）写死在模板里，程序只填 prompt 和种子。
export const buildPortraitWorkflow = (input: { prompt: string; seed: number }): ComfyWorkflow => {
  const workflow: ComfyWorkflow = structuredClone(gptImage2Portrait)
  const image = workflow[PORTRAIT_NODE_ID].inputs
  image.prompt = input.prompt
  image.seed = input.seed
  return workflow
}

// uploadedImages 是已上传到 Comfy 的文件名，r2v 依次接入 image_1..image_N。
export const buildComfyWorkflow = (
  kind: ComfyWorkflowKind,
  input: { prompt: string; seconds: number; seed: number; uploadedImages: string[] },
): ComfyWorkflow => {
  const workflow = structuredClone(WORKFLOWS[kind])
  const video = workflow[VIDEO_NODE_ID].inputs
  video['model.prompt'] = input.prompt
  video['model.duration'] = input.seconds
  video.seed = input.seed
  if (kind === 'r2v') {
    input.uploadedImages.forEach((image, index) => {
      const nodeId = `${10 + index}`
      workflow[nodeId] = { class_type: 'LoadImage', _meta: { title: `参考图 ${index + 1}` }, inputs: { image } }
      video[`model.reference_images.image_${index + 1}`] = [nodeId, 0]
    })
  }
  return workflow
}

const readImageBytes = async (source: string): Promise<{ bytes: Blob; extension: string }> => {
  if (source.startsWith('data:')) {
    const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i)
    if (!match) throw new Error('图片 data URL 格式无效。')
    return { bytes: new Blob([Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))], { type: match[1] }), extension: match[1].split('/')[1].replace('jpeg', 'jpg') }
  }
  const response = await fetch(source)
  if (!response.ok) throw new Error(`无法下载图片（HTTP ${response.status}）。`)
  const type = response.headers.get('content-type') ?? 'image/png'
  return { bytes: await response.blob(), extension: type.includes('jpeg') ? 'jpg' : 'png' }
}

const comfyError = async (response: Response, action: string) => {
  const text = await response.text().catch(() => '')
  let detail = text
  try {
    const json = JSON.parse(text) as { message?: string; error?: string | { message?: string } }
    detail = json.message ?? (typeof json.error === 'string' ? json.error : json.error?.message) ?? text
  } catch { /* 非 JSON 响应按原文展示 */ }
  const hint = response.status === 401 ? '（API Key 无效）'
    : response.status === 402 ? '（积分不足）'
      : response.status === 429 ? '（订阅未生效或请求过多）'
        : ''
  return new Error(`Comfy ${action}失败 HTTP ${response.status}${hint}：${detail.slice(0, 300) || '无详情'}`)
}

export type ComfyClient = {
  submitSegment: (request: ComfySegmentRequest) => Promise<{ jobId: string; kind: ComfyWorkflowKind }>
  submitPortrait: (prompt: string) => Promise<{ jobId: string }>
  // 视频段和演员三视图共用同一套任务状态。
  getJobStatus: (jobId: string) => Promise<ComfyJobStatus>
  fetchVideo: (jobId: string) => Promise<Response>
  fetchImage: (jobId: string) => Promise<Response>
}

export type ComfyJobStatus =
  | { status: 'running' }
  | { status: 'failed'; error: string }
  | { status: 'completed' }

// 文档列出的状态并不完整（实测还有 queued_waiting 等排队态），所以只认明确的完成/失败，其余一律按进行中继续轮询。
const COMPLETED_STATUSES = new Set(['success', 'completed'])
const FAILED_STATUSES = new Set(['error', 'failed', 'non_retryable_error', 'lost', 'cancelled'])

type JobDetail = {
  status?: string
  outputs?: Record<string, Record<string, unknown>>
  execution_error?: { exception_message?: string; node_type?: string }
}

type OutputFile = { filename: string; subfolder?: string; type?: string; mime_type?: string }

const OUTPUT_PATTERNS = {
  video: { mime: /^video\//, extension: /\.(mp4|webm|mov|mkv)$/i },
  image: { mime: /^image\//, extension: /\.(png|jpe?g|webp)$/i },
}

const findOutputFile = (job: JobDetail, kind: keyof typeof OUTPUT_PATTERNS): OutputFile | undefined =>
  Object.values(job.outputs ?? {})
    .flatMap((output) => Object.values(output))
    .flatMap((value) => Array.isArray(value) ? value : [])
    .find((file): file is OutputFile =>
      Boolean(file) && typeof file === 'object' && typeof (file as OutputFile).filename === 'string'
      && (OUTPUT_PATTERNS[kind].mime.test((file as OutputFile).mime_type ?? '') || OUTPUT_PATTERNS[kind].extension.test((file as OutputFile).filename)))

export const createComfyClient = (apiKey: string, fetchImpl: typeof fetch = fetch): ComfyClient => {
  const headers = { 'X-API-Key': apiKey }

  // 浏览器 fetch 连不上（本站转发服务停了或重启、断网）只会抛 “Failed to fetch”，这里补上是哪一步断的。
  const send = async (action: string, url: string, init?: RequestInit) => {
    try {
      return await fetchImpl(url, init)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Comfy ${action}时网络中断（${detail}）：请确认页面所在的服务仍在运行、网络正常后点重试。`, { cause: error })
    }
  }

  const uploadImage = async (source: string, index: number) => {
    const { bytes, extension } = await readImageBytes(source)
    const form = new FormData()
    form.append('image', bytes, `harem-${Date.now()}-${index}.${extension}`)
    form.append('type', 'input')
    form.append('overwrite', 'true')
    const response = await send('上传图片', `${COMFY_BASE_URL}/api/upload/image`, { method: 'POST', headers, body: form })
    if (!response.ok) throw await comfyError(response, '上传图片')
    const json = await response.json() as { name?: string; subfolder?: string }
    if (!json.name) throw new Error('Comfy 上传图片后没有返回文件名。')
    return json.subfolder ? `${json.subfolder}/${json.name}` : json.name
  }

  const getJob = async (jobId: string): Promise<JobDetail> => {
    const response = await send('查询任务', `${COMFY_BASE_URL}/api/jobs/${encodeURIComponent(jobId)}`, { headers })
    if (!response.ok) throw await comfyError(response, '查询任务')
    return await response.json() as JobDetail
  }

  const submitWorkflow = async (workflow: ComfyWorkflow) => {
    const response = await send('提交工作流', `${COMFY_BASE_URL}/api/prompt`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // H3、GPT Image 都是合作节点，提交时还要在 extra_data 里带上同一个 key 才会计费到账户。
      body: JSON.stringify({ prompt: workflow, extra_data: { api_key_comfy_org: apiKey } }),
    })
    if (!response.ok) throw await comfyError(response, '提交工作流')
    const json = await response.json() as { prompt_id?: string; node_errors?: Record<string, unknown> }
    if (json.node_errors && Object.keys(json.node_errors).length) {
      throw new Error(`Comfy 工作流校验失败：${JSON.stringify(json.node_errors).slice(0, 300)}`)
    }
    if (!json.prompt_id) throw new Error('Comfy 没有返回任务 ID。')
    return json.prompt_id
  }

  // /api/view 返回 302 到短时签名地址；转发层不带 key 去取签名地址，浏览器这里直接拿到文件。
  const fetchOutput = async (jobId: string, kind: keyof typeof OUTPUT_PATTERNS) => {
    const job = await getJob(jobId)
    const file = findOutputFile(job, kind)
    if (!file) throw new Error(kind === 'video' ? 'Comfy 任务没有产出视频文件。' : 'Comfy 任务没有产出图片文件。')
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const response = await send(kind === 'video' ? '下载视频' : '下载图片', `${COMFY_BASE_URL}/api/view?${query}`, { headers })
    if (!response.ok) throw await comfyError(response, kind === 'video' ? '下载视频' : '下载图片')
    return response
  }

  const randomSeed = (max: number) => Math.floor(Math.random() * max)

  return {
    async submitSegment(request) {
      const kind = chooseWorkflowKind(request)
      const sources = request.referenceImages ?? []
      const uploadedImages = await Promise.all(sources.map(uploadImage))
      const workflow = buildComfyWorkflow(kind, {
        prompt: request.prompt,
        seconds: request.seconds,
        seed: randomSeed(4_294_967_295),
        uploadedImages,
      })
      return { jobId: await submitWorkflow(workflow), kind }
    },

    async submitPortrait(prompt) {
      if (!prompt.trim()) throw new Error('缺少生图 prompt。')
      return { jobId: await submitWorkflow(buildPortraitWorkflow({ prompt, seed: randomSeed(2_147_483_647) })) }
    },

    async getJobStatus(jobId) {
      const response = await send('查询任务', `${COMFY_BASE_URL}/api/job/${encodeURIComponent(jobId)}/status`, { headers })
      if (!response.ok) throw await comfyError(response, '查询任务')
      const json = await response.json() as { status?: string; error_message?: string | null }
      const status = json.status ?? ''
      if (COMPLETED_STATUSES.has(status)) return { status: 'completed' }
      if (!FAILED_STATUSES.has(status)) return { status: 'running' }
      const job = await getJob(jobId).catch(() => undefined)
      const reason = job?.execution_error?.exception_message ?? json.error_message ?? `任务状态 ${status || '未知'}`
      return { status: 'failed', error: `Comfy 生成失败：${reason}` }
    },

    fetchVideo: (jobId) => fetchOutput(jobId, 'video'),

    fetchImage: (jobId) => fetchOutput(jobId, 'image'),
  }
}
