import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: { build: { rollupOptions: { external: ['bufferutil', 'utf-8-validate'] } } },
  preload: {},
  renderer: { plugins: [react()] }
})
