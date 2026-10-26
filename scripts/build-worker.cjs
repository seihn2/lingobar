// Bundle project-local Workers code with the existing locked esbuild (Vite dependency). No install or deploy.
const { build } = require('esbuild')
const { mkdirSync, copyFileSync, cpSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')
const root = resolve(__dirname, '..'), out = join(root, 'dist/worker')
async function main() {
  mkdirSync(out, { recursive: true })
  const result = await build({ entryPoints: [join(root, 'src/worker/index.ts')], outfile: join(out, 'index.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', sourcemap: false, minify: false, metafile: true, logLevel: 'warning' })
  const inputs = Object.keys(result.metafile.inputs)
  if (inputs.some(name => name.includes('node_modules/') || /(?:^|\/)src\/main\/(?!translation\.ts$|japanese\.ts$)/.test(name))) throw new Error('Unexpected worker runtime dependency')
  for (const name of ['LICENSE', 'NOTICE.md']) copyFileSync(join(root, name), join(out, name))
  cpSync(join(root, 'licenses'), join(out, 'licenses'), { recursive: true })
  copyFileSync(join(root, 'worker.example.jsonc'), join(out, 'worker.example.jsonc'))
  writeFileSync(join(out, 'BUILD-INPUTS.json'), JSON.stringify({ note: 'Browser-target ESM bundle, not a workerd/Cloudflare deployment test.', inputs }, null, 2))
  console.log(`Workers ESM built with ${inputs.length} project-local inputs; no Node/Electron/third-party runtime and no deployment.`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
