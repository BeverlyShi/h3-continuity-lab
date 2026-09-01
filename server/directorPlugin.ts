import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
import { Check } from 'typebox/value'
import { getDirectorModelProvider, isDirectorModelId } from '../src/config/directorModels.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'
import { storyInputSchema } from '../src/types/story.ts'
import { runDirectorAgent } from './directorAgent.ts'
import { runSimpleDirector } from './simpleDirector.ts'

const MAX_BODY_BYTES = 1_000_000

async function readJson(req: IncomingMessage) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('请求内容过大。')
  }
  return JSON.parse(body) as { context?: DirectorTurnContext; traceId?: string; agent?: string; model?: unknown }
}

const isDirectorTurnContext = (context: DirectorTurnContext | undefined): context is DirectorTurnContext =>
  context?.ok === true &&
  typeof context.sessionId === 'string' &&
  Boolean(context.sessionId.trim()) &&
  Number.isInteger(context.turn) &&
  context.turn > 0 &&
  Check(storyInputSchema, context.input)

export function directorPlugin(): Plugin {
  return {
    name: 'local-pi-director',
    configureServer(server) {
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
          const body = await readJson(req)
          if (!isDirectorTurnContext(body.context)) throw new Error('故事输入无效。')
          if (!body.traceId) throw new Error('缺少 Trace ID。')
          if (!isDirectorModelId(body.model)) throw new Error('不支持该模型。')

          const provider = getDirectorModelProvider(body.model)
          const apiKey = provider === 'deepseek' ? deepseekKey : openRouterKey
          if (typeof apiKey !== 'string' || !apiKey.trim()) {
            throw new Error(provider === 'deepseek' ? '请先配置 DEEPSEEK_API_KEY。' : '请先配置 OPENROUTER_API_KEY。')
          }

          const runTurn = body.agent === 'simple' ? runSimpleDirector : runDirectorAgent
          await runTurn({
            apiKey: apiKey.trim(),
            modelId: body.model,
            context: body.context,
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
