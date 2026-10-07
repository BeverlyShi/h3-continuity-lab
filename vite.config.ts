import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { comfyPlugin } from './server/comfyPlugin.ts'

export default defineConfig({
  plugins: [react(), comfyPlugin()],
  // 导演模块是懒加载的，开发服务器启动时扫不到这些依赖；提前预构建，免得第一次开局时重新优化导致 504。
  optimizeDeps: {
    include: [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/api/openai-completions.lazy',
      '@earendil-works/pi-ai/providers/deepseek',
      '@earendil-works/pi-ai/providers/openrouter',
      '@earendil-works/pi-ai/providers/zai',
      'typebox',
      'typebox/value',
    ],
  },
})
