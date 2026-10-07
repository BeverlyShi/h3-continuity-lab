import { ApiError, createFalClient, type FalClient } from '@fal-ai/client'
import type { GameScene } from '../types/game.ts'
import {
  fetchComfyImage,
  fetchComfyVideo,
  getComfyJobStatus,
  submitComfyPortrait,
  submitComfySegment,
} from './comfyClient.ts'

export type JobStatus = { status: 'pending' | 'completed' | 'failed'; error?: string }

// 生成任务本身失败（区别于网络/key 出错）：任务 ID 作废，重试时要重新提交。
export class JobFailedError extends Error {}

export type VideoJobRequest = {
  prompt: string
  seconds: number
  // 按 prompt 里的图号顺序，data URL 或 http(s) 地址。
  referenceImages: string[]
}

// fal 与 Comfy 共用的生成流程：提交拿任务 ID → 轮询状态 → 下载结果。任务 ID 带后端前缀，刷新后按前缀续查。
export type GenerationBackend = {
  submitVideo(request: VideoJobRequest): Promise<string>
  submitImage(prompt: string): Promise<string>
  getStatus(jobId: string): Promise<JobStatus>
  fetchResult(jobId: string, kind: 'video' | 'image'): Promise<Blob>
}

export type GenerationKeys = { falApiKey: string; comfyApiKey: string }

export type ParsedJobId =
  | { backend: 'comfy'; promptId: string }
  | { backend: 'fal'; endpointId: string; requestId: string }

const COMFY_PREFIX = 'comfy:'
const FAL_PREFIX = 'fal:'

// fal 的 endpointId 本身含 `/`，requestId 不含 `:`，所以取最后一个 `:` 之后为 requestId；没有前缀的旧 ID 都是 Comfy 提交的。
export const parseJobId = (jobId: string): ParsedJobId => {
  if (jobId.startsWith(FAL_PREFIX)) {
    const rest = jobId.slice(FAL_PREFIX.length)
    const split = rest.lastIndexOf(':')
    if (split > 0 && split < rest.length - 1) {
      return { backend: 'fal', endpointId: rest.slice(0, split), requestId: rest.slice(split + 1) }
    }
    throw new Error(`任务 ID 格式无效：${jobId}`)
  }
  return { backend: 'comfy', promptId: jobId.startsWith(COMFY_PREFIX) ? jobId.slice(COMFY_PREFIX.length) : jobId }
}

const requireComfy = (jobId: string) => {
  const parsed = parseJobId(jobId)
  if (parsed.backend !== 'comfy') throw new Error(`不是 Comfy 任务：${jobId}`)
  return parsed.promptId
}

const requireFal = (jobId: string) => {
  const parsed = parseJobId(jobId)
  if (parsed.backend !== 'fal') throw new Error(`不是 fal 任务：${jobId}`)
  return parsed
}

export const createComfyBackend = (apiKey: string): GenerationBackend => ({
  async submitVideo({ prompt, seconds, referenceImages }) {
    const { jobId } = await submitComfySegment(apiKey, {
      prompt,
      seconds,
      ...(referenceImages.length ? { referenceImages } : {}),
    })
    return `${COMFY_PREFIX}${jobId}`
  },

  async submitImage(prompt) {
    const { jobId } = await submitComfyPortrait(apiKey, prompt)
    return `${COMFY_PREFIX}${jobId}`
  },

  async getStatus(jobId) {
    const state = await getComfyJobStatus(apiKey, requireComfy(jobId))
    if (state.status === 'running') return { status: 'pending' }
    return state
  },

  async fetchResult(jobId, kind) {
    const promptId = requireComfy(jobId)
    return kind === 'video' ? await fetchComfyVideo(apiKey, promptId) : await fetchComfyImage(apiKey, promptId)
  },
})

const H3_MAX_TEXT_TO_VIDEO = 'minimax/h3-max/text-to-video'
const H3_MAX_REFERENCE_TO_VIDEO = 'minimax/h3-max/reference-to-video'
const GPT_IMAGE_2 = 'openai/gpt-image-2'

type FalResult = {
  video?: { url?: string }
  images?: { url?: string }[]
}

// fal 的 COMPLETED 不区分成败，失败时状态里会带 error 字段。
type FalCompletedStatus = { status: 'COMPLETED'; error?: string | null }

const dataUrlToBlob = (dataUrl: string) => {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) throw new Error('图片 data URL 格式无效。')
  return new Blob([Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))], { type: match[1] })
}

// fal 只收公开地址：data URL 先上传到 fal storage 换成 URL。
export const createFalBackend = (
  apiKey: string,
  fal: FalClient = createFalClient({ credentials: apiKey, suppressLocalCredentialsWarning: true }),
): GenerationBackend => {
  const submit = async (endpointId: string, input: Record<string, unknown>) => {
    const { request_id: requestId } = await fal.queue.submit(endpointId, { input })
    return `${FAL_PREFIX}${endpointId}:${requestId}`
  }

  return {
    async submitVideo({ prompt, seconds, referenceImages }) {
      const referenceImageUrls = await Promise.all(referenceImages.map((image) =>
        /^https?:\/\//.test(image) ? image : fal.storage.upload(dataUrlToBlob(image))))
      return await submit(referenceImageUrls.length ? H3_MAX_REFERENCE_TO_VIDEO : H3_MAX_TEXT_TO_VIDEO, {
        prompt,
        duration: seconds,
        resolution: '768P',
        prompt_expansion_mode: 'balanced',
        enable_safety_checker: true,
        aspect_ratio: '16:9',
        ...(referenceImageUrls.length ? { reference_image_urls: referenceImageUrls } : {}),
      })
    },

    // 参数对齐 Comfy 的 gpt_image_2_portrait 模板：2048x1152、medium、不透明背景。
    async submitImage(prompt) {
      if (!prompt.trim()) throw new Error('缺少生图 prompt。')
      return await submit(GPT_IMAGE_2, {
        prompt,
        image_size: { width: 2048, height: 1152 },
        quality: 'medium',
        background: 'opaque',
        num_images: 1,
        output_format: 'png',
      })
    },

    // 查询请求本身出错（断网、key 无效等）照常抛出，调用方保留任务 ID 下次续查；只有任务确定失败或已不存在才返回 failed。
    async getStatus(jobId) {
      const { endpointId, requestId } = requireFal(jobId)
      let state
      try {
        state = await fal.queue.status(endpointId, { requestId })
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { status: 'failed', error: 'fal 任务不存在或已过期。' }
        throw error
      }
      if (state.status !== 'COMPLETED') return { status: 'pending' }
      const failure = (state as FalCompletedStatus).error
      return failure ? { status: 'failed', error: `fal 生成失败：${failure}` } : { status: 'completed' }
    },

    async fetchResult(jobId, kind) {
      const { endpointId, requestId } = requireFal(jobId)
      let data
      try {
        ({ data } = await fal.queue.result(endpointId, { requestId }))
      } catch (error) {
        // 状态是 COMPLETED 但取结果报错，说明任务本身失败了；key 无效或限流照常抛出，保留任务 ID。
        if (error instanceof ApiError && ![401, 403, 429].includes(error.status)) {
          throw new JobFailedError(`fal 生成失败：${error.message}`)
        }
        throw error
      }
      const result = data as FalResult
      const url = kind === 'video' ? result.video?.url : result.images?.[0]?.url
      if (!url) throw new Error(kind === 'video' ? 'fal 任务没有返回视频地址。' : 'fal 任务没有返回图片地址。')
      const response = await fetch(url)
      if (!response.ok) throw new Error(`fal ${kind === 'video' ? '下载视频' : '下载图片'}失败 HTTP ${response.status}。`)
      return await response.blob()
    },
  }
}

// 续查已提交的任务按 ID 前缀选后端，与当前模式无关。
export const getBackendForJob = (jobId: string, keys: GenerationKeys): GenerationBackend => {
  if (parseJobId(jobId).backend === 'fal') {
    if (!keys.falApiKey) throw new Error('这一段的视频任务由 API 生成（fal）提交，需要先在设置里配置 fal API Key 才能接着查询。')
    return createFalBackend(keys.falApiKey)
  }
  if (!keys.comfyApiKey) throw new Error('这一段的视频任务由 ComfyUI 提交，需要先在设置里配置 Comfy API Key 才能接着查询。')
  return createComfyBackend(keys.comfyApiKey)
}

// 新提交按当前模式选后端；对应 key 没配时返回 null。
export const getBackendForMode = (
  videoMode: NonNullable<GameScene['videoMode']>,
  keys: GenerationKeys,
): GenerationBackend | null => {
  if (videoMode === 'auto') return keys.falApiKey ? createFalBackend(keys.falApiKey) : null
  return keys.comfyApiKey ? createComfyBackend(keys.comfyApiKey) : null
}
