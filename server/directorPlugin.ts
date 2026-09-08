import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
import { Check } from 'typebox/value'
import { getDirectorModelProvider, isDirectorModelId } from '../src/config/directorModels.ts'
import type { CastableActor, CharacterCasting } from '../src/types/actor.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import { sceneCharacterSchema, storyInputSchema, tailFrameVisualStateSchema, type SceneCharacter } from '../src/types/story.ts'
import { runDirectorAgent } from './directorAgent.ts'
import { runSimpleDirector } from './simpleDirector.ts'
import { createInspectTailFrameTool } from './inspectTailFrameTool.ts'

const MAX_BODY_BYTES = 1_000_000

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

const isCastableActor = (value: unknown): value is CastableActor => {
  if (!value || typeof value !== 'object') return false
  const actor = value as Partial<CastableActor>
  return typeof actor.id === 'string'
    && typeof actor.name === 'string'
    && (actor.gender === 'female' || actor.gender === 'male')
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

export function directorPlugin(): Plugin {
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
            agent?: string
            model?: unknown
            thinkingEnabled?: unknown
          }>(req)
          if (!isDirectorTurnContext(body.context)) throw new Error('故事输入无效。')
          if (!body.traceId) throw new Error('缺少 Trace ID。')
          if (!isDirectorModelId(body.model)) throw new Error('不支持该模型。')
          if (body.thinkingEnabled !== undefined && typeof body.thinkingEnabled !== 'boolean') {
            throw new Error('思考模式设置无效。')
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

          const runTurn = body.agent === 'simple' ? runSimpleDirector : runDirectorAgent
          await runTurn({
            apiKey: apiKey.trim(),
            modelId: body.model,
            thinkingEnabled: body.thinkingEnabled === true,
            context: body.context,
            actors: body.actors,
            castings: body.castings,
            traceId: body.traceId,
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
    },
  }
}
