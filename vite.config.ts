import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { comfyPlugin } from './server/comfyPlugin.ts'

export default defineConfig({
  plugins: [react(), comfyPlugin()],
})
