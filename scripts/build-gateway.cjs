// Bundle the existing locked ws with project-local server code. No install, secrets, deploy or model inference.
const { build } = require('esbuild')
const { mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { resolve, join } = require('node:path')
const root = resolve(__dirname, '..'), out = join(root, 'dist/gateway')
async function main() {
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
  const result = await build({ entryPoints: [join(root, 'src/gateway/main.ts')], outfile: join(out, 'gateway.cjs'), bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, minify: false, metafile: true, logLevel: 'warning',
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' } })
  const inputs = Object.keys(result.metafile.inputs)
  if (inputs.some(name => /node_modules\/(?!ws\/)/.test(name) || /(?:^|\/)src\/main\/(?!translation\.ts$|japanese\.ts$)/.test(name))) throw new Error('Unexpected gateway runtime dependency')
  for (const name of ['LICENSE', 'NOTICE.md', 'gateway.env.example']) copyFileSync(join(root, name), join(out, name))
  cpSync(join(root, 'licenses'), join(out, 'licenses'), { recursive: true })
  copyFileSync(join(root, 'docs/vm-gateway.md'), join(out, 'DEPLOYMENT.md'))
  const textGuide = readFileSync(join(root, 'docs/one-rmb-test.md'), 'utf8')
    .replaceAll('](../evidence/', '](evidence/').replaceAll('](../scripts/', '](scripts/')
  writeFileSync(join(out, 'one-rmb-test.md'), textGuide)
  copyFileSync(join(root, 'scripts/plan-one-rmb-test.cjs'), join(out, 'plan-one-rmb-test.cjs'))
  // Preserve the source-relative proof path; this CLI is separate from the HTTP gateway.
  mkdirSync(join(out, 'scripts'), { recursive: true }); mkdirSync(join(out, 'evidence'), { recursive: true })
  const textTestInputs = ['scripts/plan-one-rmb-test.cjs', 'scripts/run-one-rmb-text-test.cjs', 'scripts/text-test-proof.cjs',
    'scripts/text-test-installation.json', 'evidence/text-test-proof.json']
  for (const name of textTestInputs) copyFileSync(join(root, name), join(out, name))
  writeFileSync(join(out, 'BUILD-INPUTS.json'), JSON.stringify({ runtime: 'Node.js 22 Linux, loopback HTTP/ws, existing ws 8.22.0 (MIT), no runtime npm install', inputs, textTestInputs }, null, 2) + '\n')
  console.log(`Disabled Node gateway built from ${inputs.length} project/ws inputs. No deployment or real service test.`)
}
main().catch(() => { console.error('Gateway build failed'); process.exitCode = 1 })
