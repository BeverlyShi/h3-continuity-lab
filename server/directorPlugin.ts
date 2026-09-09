import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
import { Check } from 'typebox/value'
import { getDirectorModelProvider, isDirectorModelId } from '../src/config/directorModels.ts'
import type { CastableActor, CharacterCasting } from '../src/types/actor.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import { sceneCharacterSchema, storyInputSchema, tailFrameVisualStateSchema, type SceneCharacter } from '../src/types/story.ts'
import { getAwaitingModelId, getDirectorTurnStatus, resumeDirectorAgent, runDirectorAgent } from './directorAgent.ts'
import type { DirectorVideoMode } from './directorPrompt.ts'
import { createInspectTailFrameTool } from './inspectTailFrameTool.ts'
import type { analyzeTailFrame } from './tailFrameVision.ts'

export type DirectorPluginOptions = {
  // 测试注入假的尾帧识别；生产环境省略，走 DeepSeek Vision。
  analyzeTailFrame?: typeof analyzeTailFrame
}

// 尾帧 data URL 走 JSON body（/turn 只带元数据，/resume 还要带一张完整尾帧图片）。
const MAX_BODY_BYTES = 8_000_000

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('请求内容过大。')
  }
  return JSON.parse(body) as T
}

const readVisionBody = async (req: IncomingMessage) => {
  const body = await readJson<{ imageUrl?: unknown; characters?: unknown }>(req)
  if (typeof body.imageUrl !== 'string' || !body.imageUrl.trim()) throw new Error('缺少尾帧图片地址。')
  if (!Array.isArray(body.characters)) throw new Error('缺少本幕人物列表。')
  if (!body.characters.every((character) => Check(sceneCharacterSchema, character))) {
    throw new Error('本幕人物列表格式无效。')
  }
  return { imageUrl: body.imageUrl, characters: body.characters as SceneCharacter[] }
}

const isDirectorTurnContext = (context: DirectorTurnContext | undefined): context is DirectorTurnContext =>
  context?.ok === true &&
  typeof context.sessionId === 'string' &&
  Boolean(context.sessionId.trim()) &&
  Number.isInteger(context.turn) &&
  context.turn > 0 &&
  Check(storyInputSchema, context.input) &&
  (context.hasPreviousTailFrame === undefined || typeof context.hasPreviousTailFrame === 'boolean') &&
  (context.previousVisualState === undefined || Check(tailFrameVisualStateSchema, context.previousVisualState))

const isDirectorVideoMode = (value: unknown): value is DirectorVideoMode =>
  value === 'auto' || value === 'manual' || value === 'off'

const isCastableActor = (value: unknown): value is CastableActor => {
  if (!value || typeof value !== 'object') return false
  const actor = value as Partial<CastableActor>
  return typeof actor.id === 'string'
    && typeof actor.name === 'string'
    && (actor.gender === 'female' || actor.gender === 'male')
    && (actor.appearance === undefined || typeof actor.appearance === 'string')
    && typeof actor.hasImage === 'boolean'
    && Number.isInteger(actor.minAge)
    && Number.isInteger(actor.maxAge)
    && actor.minAge! >= 0
    && actor.maxAge! <= 100
    && actor.minAge! <= actor.maxAge!
}

const isCharacterCasting = (value: unknown): value is CharacterCasting => {
  if (!value || typeof value !== 'object') return false
  const casting = value as Partial<CharacterCasting>
  return typeof casting.characterId === 'string'
    && Boolean(casting.characterId)
    && typeof casting.actorId === 'string'
    && Boolean(casting.actorId)
}

export function directorPlugin(options: DirectorPluginOptions = {}): Plugin {
  return {
    name: 'local-pi-director',
    configureServer(server) {
      server.middlewares.use('/api/vision/tail-frame', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const deepseekKey = req.headers['x-deepseek-key']
        try {
          if (typeof deepseekKey !== 'string' || !deepseekKey.trim()) {
            throw new Error('尾帧视觉识别需要 DEEPSEEK_API_KEY。')
          }
          const body = await readVisionBody(req)
          const tool = createInspectTailFrameTool(deepseekKey.trim())
          const result = await tool.execute('tail-frame-http', body)
          res.statusCode = 200
          res.end(JSON.stringify(result.details))
        } catch (error) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : '尾帧视觉识别失败。' }))
        }
      })

      server.middlewares.use('/api/director/turn', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        const openRouterKey = req.headers['x-openrouter-key']
        const deepseekKey = req.headers['x-deepseek-key']

        const controller = new AbortController()
        req.on('aborted', () => controller.abort())
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Content-Type-Options', 'nosniff')

        const send = (event: DirectorStreamEvent) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
        }

        try {
          const body = await readJson<{
            context?: DirectorTurnContext
            traceId?: string
            actors?: unknown
            castings?: unknown
            model?: unknown
            thinkingEnabled?: unknown
            videoMode?: unknown
          }>(req)
          if (!isDirectorTurnContext(body.context)) throw new Error('故事输入无效。')
          if (!body.traceId) throw new Error('缺少 Trace ID。')
          if (!isDirectorModelId(body.model)) throw new Error('不支持该模型。')
          if (body.thinkingEnabled !== undefined && typeof body.thinkingEnabled !== 'boolean') {
            throw new Error('思考模式设置无效。')
          }
          if (body.videoMode !== undefined && !isDirectorVideoMode(body.videoMode)) {
            throw new Error('视频模式设置无效。')
          }
          if (!Array.isArray(body.actors) || !body.actors.every(isCastableActor)) {
            throw new Error('演员库数据无效。')
          }
          if (!Array.isArray(body.castings) || !body.castings.every(isCharacterCasting)) {
            throw new Error('已有选角数据无效。')
          }

          const provider = getDirectorModelProvider(body.model)
          const apiKey = { deepseek: deepseekKey, openrouter: openRouterKey, bigmodel: req.headers['x-bigmodel-key'] }[provider]
          if (typeof apiKey !== 'string' || !apiKey.trim()) {
            throw new Error(`请先配置 ${{ deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', bigmodel: 'BIGMODEL_API_KEY' }[provider]}。`)
          }

          await runDirectorAgent({
            apiKey: apiKey.trim(),
            modelId: body.model,
            thinkingEnabled: body.thinkingEnabled === true,
            context: body.context,
            actors: body.actors,
            castings: body.castings,
            traceId: body.traceId,
            videoMode: body.videoMode,
            signal: controller.signal,
            send,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : '导演请求失败。'
          send({ type: 'error', error: message })
        } finally {
          if (!res.writableEnded) res.end()
        }
      })

      server.middlewares.use('/api/director/resume', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        const openRouterKey = req.headers['x-openrouter-key']
        const deepseekKey = req.headers['x-deepseek-key']

        const controller = new AbortController()
        req.on('aborted', () => controller.abort())
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Content-Type-Options', 'nosniff')

        const send = (event: DirectorStreamEvent) => {
          if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
        }

        try {
          const body = await readJson<{
            sessionId?: unknown
            sequence?: unknown
            toolCallId?: unknown
            tailFrameDataUrl?: unknown
            durationSeconds?: unknown
          }>(req)
          if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) throw new Error('缺少会话 ID。')
          if (!Number.isInteger(body.sequence) || (body.sequence as number) < 1) throw new Error('段号无效。')
          if (typeof body.toolCallId !== 'string' || !body.toolCallId.trim()) throw new Error('缺少工具调用 ID。')
          if (typeof body.tailFrameDataUrl !== 'string' || !body.tailFrameDataUrl.startsWith('data:image/')) {
            throw new Error('尾帧图片必须是 data:image/ 开头的 data URL。')
          }
          if (typeof body.durationSeconds !== 'number' || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0) {
            throw new Error('视频实际时长无效。')
          }
          if (typeof deepseekKey !== 'string' || !deepseekKey.trim()) {
            throw new Error('尾帧视觉识别需要 DEEPSEEK_API_KEY。')
          }

          const modelId = await getAwaitingModelId(body.sessionId)
          if (!modelId) throw new Error('当前没有等待上传的视频段。')
          const provider = getDirectorModelProvider(modelId)
          const apiKey = { deepseek: deepseekKey, openrouter: openRouterKey, bigmodel: req.headers['x-bigmodel-key'] }[provider]
          if (typeof apiKey !== 'string' || !apiKey.trim()) {
            throw new Error(`请先配置 ${{ deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', bigmodel: 'BIGMODEL_API_KEY' }[provider]}。`)
          }

          await resumeDirectorAgent({
            sessionId: body.sessionId,
            sequence: body.sequence as number,
            toolCallId: body.toolCallId,
            tailFrameDataUrl: body.tailFrameDataUrl,
            durationSeconds: body.durationSeconds,
            apiKey: apiKey.trim(),
            deepseekKey: deepseekKey.trim(),
            signal: controller.signal,
            send,
            analyze: options.analyzeTailFrame,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : '恢复导演回合失败。'
          send({ type: 'error', error: message })
        } finally {
          if (!res.writableEnded) res.end()
        }
      })

      server.middlewares.use('/api/director/turn-state', async (req, res, next) => {
        if (req.method !== 'GET') {
          next()
          return
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        try {
          const sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId')
          if (!sessionId?.trim()) throw new Error('缺少会话 ID。')
          const status = await getDirectorTurnStatus(sessionId)
          res.statusCode = 200
          res.end(JSON.stringify(status))
        } catch (error) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : '查询回合状态失败。' }))
        }
      })
    },
  }
}
