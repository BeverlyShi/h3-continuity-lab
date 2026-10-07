import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Plugin } from 'vite'
import { createComfyClient, validateComfySegmentRequest, type ComfyClient } from './comfyVideo.ts'

export type ComfyPluginOptions = {
  // 测试注入假的 Comfy 客户端；生产环境省略，直连 Comfy Cloud。
  createClient?: (apiKey: string) => ComfyClient
}

// 参考图可能有多张 data URL，比导演接口的上限放宽。
const MAX_BODY_BYTES = 30_000_000

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('请求内容过大。')
  }
  return JSON.parse(body)
}

const readComfyKey = (req: IncomingMessage) => {
  const key = req.headers['x-comfy-key']
  if (typeof key !== 'string' || !key.trim()) throw new Error('请先配置 COMFY_API_KEY。')
  return key.trim()
}

const readJobId = (req: IncomingMessage) => {
  const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id')
  if (!id?.trim()) throw new Error('缺少 Comfy 任务 ID。')
  return id.trim()
}

const sendJson = (res: ServerResponse, statusCode: number, value: unknown) => {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function comfyPlugin(options: ComfyPluginOptions = {}): Plugin {
  const createClient = options.createClient ?? ((apiKey: string) => createComfyClient(apiKey))
  return {
    name: 'local-comfy-video',
    configureServer(server) {
      // 必须先于 /api/comfy/segment 注册：connect 按前缀匹配，否则 /video 会被下面那个处理器吞掉。
      server.middlewares.use('/api/comfy/segment/video', async (req, res, next) => {
        if (req.method !== 'GET') {
          next()
          return
        }
        try {
          const video = await createClient(readComfyKey(req)).fetchVideo(readJobId(req))
          res.statusCode = 200
          res.setHeader('Content-Type', video.headers.get('content-type') ?? 'video/mp4')
          const length = video.headers.get('content-length')
          if (length) res.setHeader('Content-Length', length)
          if (!video.body) throw new Error('Comfy 视频内容为空。')
          Readable.fromWeb(video.body as import('node:stream/web').ReadableStream).pipe(res)
        } catch (error) {
          sendJson(res, 400, { error: errorMessage(error, '下载 Comfy 视频失败。') })
        }
      })

      server.middlewares.use('/api/comfy/segment', async (req, res, next) => {
        try {
          if (req.method === 'POST') {
            const client = createClient(readComfyKey(req))
            const request = validateComfySegmentRequest(await readJson(req))
            sendJson(res, 200, await client.submitSegment(request))
            return
          }
          if (req.method === 'GET') {
            sendJson(res, 200, await createClient(readComfyKey(req)).getSegment(readJobId(req)))
            return
          }
          next()
        } catch (error) {
          sendJson(res, 400, { error: errorMessage(error, 'Comfy 请求失败。') })
        }
      })
    },
  }
}
