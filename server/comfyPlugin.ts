import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { Plugin } from 'vite'
import { COMFY_PROXY_PREFIX, handleComfyProxy } from '../worker/comfyProxy.ts'

// 开发服务器上的薄壳：Node 请求转成 Request 交给转发处理函数，上线后同一个函数跑在 Cloudflare Worker 里。
const toRequest = (req: IncomingMessage): Request => {
  const protocol = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'
  const url = new URL(req.url ?? '/', `${protocol}://${req.headers.host ?? 'localhost'}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    // HTTP/2 的伪头（:authority 等）不是合法的头名。
    if (value === undefined || name.startsWith(':')) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  }
  return new Request(url, init)
}

const sendResponse = async (res: ServerResponse, response: Response) => {
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  if (!response.body) {
    res.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream), res)
}

export function comfyPlugin(): Plugin {
  return {
    name: 'local-comfy-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // 先按前缀筛：不是转发层的请求不要碰它的 body。
        if (!req.url?.startsWith(COMFY_PROXY_PREFIX)) {
          next()
          return
        }
        try {
          const response = await handleComfyProxy(toRequest(req))
          if (!response) {
            next()
            return
          }
          await sendResponse(res, response)
        } catch (error) {
          if (res.headersSent) res.destroy(error instanceof Error ? error : undefined)
          else next(error)
        }
      })
    },
  }
}
