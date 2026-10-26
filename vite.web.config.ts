import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'web'),
  envDir: false,
  plugins: [react(), { name: 'lingobar-web-notices', closeBundle() {
    const out = resolve(__dirname, 'dist/web')
    mkdirSync(out, { recursive: true })
    copyFileSync(resolve(__dirname, 'LICENSE'), resolve(out, 'LICENSE'))
    copyFileSync(resolve(__dirname, 'NOTICE.md'), resolve(out, 'NOTICE.md'))
    cpSync(resolve(__dirname, 'licenses'), resolve(out, 'licenses'), { recursive: true })
  } }],
  build: { outDir: resolve(__dirname, 'dist/web'), emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1' }
})
