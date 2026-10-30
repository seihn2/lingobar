// Exercise the real renderer in a local browser with synthetic snapshots only.
// Set CHROMIUM_PATH to an already-installed Chromium/Chrome/Edge executable.
const { spawn } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')

const root = resolve(__dirname, '..')
const candidates = [
  process.env.CHROMIUM_PATH,
  // Prefer the real Chrome package over Ubuntu's optional snap-launcher stubs.
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean)
const executable = candidates.find(path => existsSync(path))
if (!executable) throw new Error('An installed Chromium browser is required. Set CHROMIUM_PATH; this test does not download software.')
console.log(`Synthetic UI browser: ${executable}`)

async function main() {
  const { createServer, preview } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({ root, configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false } })
  const profile = mkdtempSync(join(tmpdir(), 'lingobar-ui-'))
  let child, socket, production
  let nextId = 0
  const pending = new Map()
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    child = spawn(executable, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=860,560', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false })
    let browserDiagnostics = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { browserDiagnostics = (browserDiagnostics + chunk).slice(-8192) })
    let launchError
    child.once('error', error => { launchError = error })
    const deadline = Date.now() + 15_000
    let port
    while (!port && Date.now() < deadline) {
      if (launchError) throw launchError
      if (child.exitCode !== null) throw new Error(`Browser exited before startup (${child.exitCode}): ${browserDiagnostics}`)
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { await pause() }
      // Some installed browser wrappers put their profile in another location.
      if (!port) port = Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(browserDiagnostics)?.[1])
    }
    assert.ok(port, `Browser DevTools startup timed out: ${browserDiagnostics}`)
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    const page = targets.find(target => target.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, 'No browser page target')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    socket.addEventListener('message', event => {
      const response = JSON.parse(event.data)
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id); clearTimeout(request.timer)
      if (response.error) request.reject(new Error(JSON.stringify(response.error)))
      else request.resolve(response.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools request timed out: ${method}`)) }, 30_000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    await send('Page.enable')
    await send('Runtime.enable')
    const output = join(root, 'artifacts', 'web-auth'); mkdirSync(output, { recursive: true })
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
    await send('Page.navigate', { url: `${origin}/test/fixtures/web-auth.html` })
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }
    for (let i = 0; i < 100 && !await evaluate('Boolean(window.__authTest)'); i++) await pause()
    const results = []
    for (const stage of ['anonymous', 'interruption', 'owner', 'quota']) {
      results.push({ stage, ...await evaluate(`window.__authTest.${stage}()`) })
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(output, stage + '-375.png'), Buffer.from(screenshot.data, 'base64'))
    }
    writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results))
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('UI test finished')) }
    socket?.close()
    child?.kill()
    await server.close()
    if (production) await new Promise(resolve => production.httpServer.close(resolve))
    // Windows can keep profile locks briefly after termination; evidence is separate.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break } catch { await pause() }
    }
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
