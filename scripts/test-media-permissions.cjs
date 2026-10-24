// Real Electron/Chromium permission chain. Only synthetic media devices; no UI
// auto-grant switches, provider calls, audio files or user's Electron profile.
const { spawn } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const { build } = require('esbuild')
const root = resolve(__dirname, '..')

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'lingobar-media-test-'))
  let server, child
  try {
    const { createServer } = await import('vite')
    const { default: react } = await import('@vitejs/plugin-react')
    server = await createServer({ root, configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' }
    await build({ ...common, entryPoints: [join(root, 'src/main/media-permissions.ts')], outfile: join(directory, 'policy.cjs') })
    await build({ ...common, stdin: {
      contents: `import ${JSON.stringify(join(root, 'src/preload/index.ts'))}; import { contextBridge, ipcRenderer } from 'electron'; contextBridge.exposeInMainWorld('__mediaFixture', { control: (action, value) => ipcRenderer.invoke('fixture:control', action, value) });`,
      resolveDir: root
    }, outfile: join(directory, 'preload.cjs') })
    const environment = { ...process.env, LINGOBAR_MEDIA_FIXTURE_DIR: directory, LINGOBAR_MEDIA_FIXTURE_ORIGIN: origin }
    delete environment.ELECTRON_RUN_AS_NODE
    // Keep Linux caches inside this disposable test directory.
    environment.XDG_CACHE_HOME = join(directory, 'cache')
    const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), join(root, 'test/fixtures/media-permissions-main.cjs')]
    let output = '', diagnostics = ''
    const result = await new Promise((resolve, reject) => {
      child = spawn(require('electron'), args, { cwd: root, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const deadline = setTimeout(() => { child.kill(); reject(new Error(`Electron media fixture timed out: ${diagnostics}`)) }, 90000)
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-131072) })
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192) })
      child.once('error', error => { clearTimeout(deadline); reject(error) })
      child.once('close', code => {
        clearTimeout(deadline)
        try {
          assert.equal(code, 0, `Electron fixture failed: ${diagnostics}\n${output}`)
          const line = output.split('\n').find(line => line.startsWith('LINGOBAR_MEDIA_RESULT:'))
          assert.ok(line, `Missing Electron result: ${diagnostics}`)
          resolve(JSON.parse(line.slice('LINGOBAR_MEDIA_RESULT:'.length)))
        } catch (error) { reject(error) }
      })
    })
    const destination = join(root, 'artifacts', 'media-permissions')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`Real Electron ${result.electron} / Chromium ${result.chromium}: ${result.checks.length} media permission checks passed (${result.platform}/${result.arch}); fake devices only, no fake UI or providers.`)
    console.log('Evidence: artifacts/media-permissions/results.json')
  } finally {
    if (child && child.exitCode === null) child.kill()
    if (server) await server.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
