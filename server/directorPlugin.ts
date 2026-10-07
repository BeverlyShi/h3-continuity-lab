import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { Check } from 'typebox/value'
import { getDirectorModelProvider, isDirectorModelId, type DirectorModelId } from '../src/config/directorModels.ts'
import type { CastableActor, CharacterCasting } from '../src/types/actor.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import { sceneCharacterSchema, storyInputSchema } from '../src/types/story.ts'
import { rewriteDirectorSegment, runDirectorAgent } from './directorAgent.ts'
import type { DirectorVideoMode } from './directorPrompt.ts'
import { createNodeSessionStore } from './nodeSessionStore.ts'
import type { analyzeTailFrame } from './tailFrameVision.ts'

export type DirectorPluginOptions = {
  // 测试注入假的尾帧识别；生产环境省略，走 DeepSeek Vision。
  analyzeTailFrame?: typeof analyzeTailFrame
}

// 上一场次尾帧 data URL 随 /turn 的 context 一起提交。
const MAX_BODY_BYTES = 8_000_000

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('请求内容过大。')
  }
  return JSON.parse(body) as T
}

const isPreviousScene = (value: unknown): value is NonNullable<DirectorTurnContext['previousScene']> => {
  if (!value || typeof value !== 'object') return false
  const previous = value as { tailFrameDataUrl?: unknown; characters?: unknown }
  return typeof previous.tailFrameDataUrl === 'string'
    && previous.tailFrameDataUrl.startsWith('data:image/')
    && Array.isArray(previous.characters)
    && previous.characters.every((character) => Check(sceneCharacterSchema, character))
}

const isDirectorTurnContext = (context: DirectorTurnContext | undefined): context is DirectorTurnContext =>
  context?.ok === true &&
  typeof context.sessionId === 'string' &&
  Boolean(context.sessionId.trim()) &&
  Number.isInteger(context.turn) &&
  context.turn > 0 &&
  Check(storyInputSchema, context.input) &&
  (context.previousScene === undefined || isPreviousScene(context.previousScene))

const isDirectorVideoMode = (value: unknown): value is DirectorVideoMode =>
  value === 'auto' || value === 'comfy'

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

const readHeaderKey = (req: IncomingMessage, name: string) => {
  const value = req.headers[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const requireModelKey = (req: IncomingMessage, modelId: DirectorModelId) => {
  const provider = getDirectorModelProvider(modelId)
  const apiKey = readHeaderKey(req, { deepseek: 'x-deepseek-key', openrouter: 'x-openrouter-key', bigmodel: 'x-bigmodel-key' }[provider])
  if (!apiKey) {
    throw new Error(`请先配置 ${{ deepseek: 'DEEPSEEK_API_KEY', openrouter: 'OPENROUTER_API_KEY', bigmodel: 'BIGMODEL_API_KEY' }[provider]}。`)
  }
  return apiKey
}

// 导演接口统一用 NDJSON 流：每行一个 DirectorStreamEvent，出错时以 error 事件结束。
const streamDirector = async (
  req: IncomingMessage,
  res: ServerResponse,
  fallbackError: string,
  run: (send: (event: DirectorStreamEvent) => void, signal: AbortSignal) => Promise<unknown>,
) => {
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
    await run(send, controller.signal)
  } catch (error) {
    send({ type: 'error', error: error instanceof Error ? error.message : fallbackError })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

export function directorPlugin(options: DirectorPluginOptions = {}): Plugin {
  const store = createNodeSessionStore()
  return {
    name: 'local-pi-director',
    configureServer(server) {
      server.middlewares.use('/api/director/turn', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        await streamDirector(req, res, '导演请求失败。', async (send, signal) => {
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

          await runDirectorAgent({
            store,
            apiKey: requireModelKey(req, body.model),
            modelId: body.model,
            thinkingEnabled: body.thinkingEnabled === true,
            context: body.context,
            actors: body.actors,
            castings: body.castings,
            traceId: body.traceId,
            videoMode: body.videoMode,
            visionKey: readHeaderKey(req, 'x-deepseek-key'),
            analyze: options.analyzeTailFrame,
            signal,
            send,
          })
        })
      })

      server.middlewares.use('/api/director/rewrite', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        await streamDirector(req, res, '重写分镜失败。', async (send, signal) => {
          const body = await readJson<{
            sessionId?: unknown
            sequence?: unknown
            reason?: unknown
            traceId?: unknown
            actors?: unknown
            model?: unknown
            thinkingEnabled?: unknown
          }>(req)
          if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) throw new Error('缺少会话 ID。')
          if (!Number.isInteger(body.sequence) || (body.sequence as number) < 1 || (body.sequence as number) > 3) {
            throw new Error('段号无效。')
          }
          if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 200) {
            throw new Error('请写明重写原因（200 字以内）。')
          }
          if (typeof body.traceId !== 'string' || !body.traceId) throw new Error('缺少 Trace ID。')
          if (!isDirectorModelId(body.model)) throw new Error('不支持该模型。')
          if (body.thinkingEnabled !== undefined && typeof body.thinkingEnabled !== 'boolean') {
            throw new Error('思考模式设置无效。')
          }
          if (!Array.isArray(body.actors) || !body.actors.every(isCastableActor)) {
            throw new Error('演员库数据无效。')
          }

          await rewriteDirectorSegment({
            store,
            sessionId: body.sessionId,
            sequence: body.sequence as number,
            reason: body.reason.trim(),
            apiKey: requireModelKey(req, body.model),
            modelId: body.model,
            thinkingEnabled: body.thinkingEnabled === true,
            actors: body.actors,
            traceId: body.traceId,
            signal,
            send,
          })
        })
      })
    },
  }
}
