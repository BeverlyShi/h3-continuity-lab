import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { comfyPlugin } from './server/comfyPlugin.ts'
import { directorPlugin } from './server/directorPlugin.ts'

export default defineConfig({
  plugins: [react(), directorPlugin(), comfyPlugin()],
})
