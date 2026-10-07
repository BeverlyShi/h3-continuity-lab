// Worker 入口：只有 /api/* 会进到这里（见 wrangler.jsonc 的 run_worker_first），其余由静态资源直接响应。
// 不打印任何日志，避免把请求头里的 Key 写进 Cloudflare 日志。
import { handleComfyProxy } from './comfyProxy.ts'

export default {
  async fetch(request, env) {
    const proxied = await handleComfyProxy(request)
    if (proxied) return proxied
    // 未知的 /api/* 返回 404 JSON，不回退成首页 HTML，免得调用方把页面当接口响应解析。
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: '接口不存在。' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
