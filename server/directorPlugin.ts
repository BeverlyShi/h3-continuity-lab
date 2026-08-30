import type { IncomingMessage } from 'node:http'
import type { Plugin } from 'vite'
import { runDirectorAgent } from './directorAgent.ts'
import type { DirectorStreamEvent } from '../src/types/director.ts'
import type { DirectorTurnContext } from '../src/types/game.ts'

const MAX_BODY_BYTES = 1_000_000

async function readJson(req: IncomingMessage) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('请求内容过大。')
  }
  return JSON.parse(body) as { context?: DirectorTurnContext; traceId?: string }
}

const isDirectorTurnContext = (context: DirectorTurnContext | undefined): context is DirectorTurnContext =>
  context?.ok === true &&
  typeof context.session?.id === 'string' &&
  typeof context.session?.turn === 'number' &&
  context.session.pendingAction !== undefined

export function directorPlugin(): Plugin {
  return {
    name: 'local-pi-director',
    configureServer(server) {
      server.middlewares.use('/api/director/turn', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }

        const apiKey = req.headers['x-deepseek-key']
        if (typeof apiKey !== 'string' || !apiKey.trim()) {
          res.statusCode = 401
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: '请先配置 DEEPSEEK_API_KEY。' }))
          return
        }

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
          if (!isDirectorTurnContext(body.context)) throw new Error('游戏上下文无效或没有待裁决行动。')
          if (!body.traceId) throw new Error('缺少 Trace ID。')
          await runDirectorAgent({
            apiKey: apiKey.trim(),
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
