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
    production = await preview({ configFile: join(root, 'vite.web.config.ts'), preview: { host: '127.0.0.1', port: 0 } })
    const productionOrigin = `http://127.0.0.1:${production.httpServer.address().port}`
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      globalThis.__webSafety = { media: 0, sockets: 0 };
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {},
        getUserMedia() { globalThis.__webSafety.media++; throw new Error('Real media forbidden in regression'); }
      }});
      const DevelopmentSocket = globalThis.WebSocket;
      globalThis.WebSocket = class { constructor(url, protocol) {
        // The fixture's Vite module/CSS loader may use loopback HMR; this is test infrastructure, never a provider socket.
        if (['vite-hmr', 'vite-ping'].includes(protocol) && new URL(url).hostname === '127.0.0.1') return new DevelopmentSocket(url, protocol);
        globalThis.__webSafety.sockets++; throw new Error('Real services forbidden in regression');
      } };
    ` })
    await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
    await send('Page.navigate', { url: productionOrigin })
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      await pause()
      const result = await send('Runtime.evaluate', { expression: 'Boolean(document.querySelector(".web-shell"))', returnByValue: true })
      ready = result.result.value
    }
    assert.ok(ready, 'Production web page did not mount')
    const unconfigured = await send('Runtime.evaluate', { expression: `({
      status: document.querySelector('.web-capture [role=status]').textContent,
      disabled: document.querySelector('.listen-button').disabled,
      keys: document.querySelectorAll('input[type=password]').length,
      safety: globalThis.__webSafety,
      fits: document.documentElement.scrollWidth <= innerWidth
    })`, returnByValue: true })
    assert.deepEqual(unconfigured.result.value, { status: '后端未配置', disabled: true, keys: 0, safety: { media: 0, sockets: 0 }, fits: true })
    const output = join(root, 'artifacts', 'web-regression')
    mkdirSync(output, { recursive: true })
    let screenshot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(output, 'unconfigured-phone.png'), Buffer.from(screenshot.data, 'base64'))
    const results = [], touchFailures = []
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    for (const [width, height, scale] of [[375, 812, 1], [390, 844, 2], [860, 560, 1]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: true })
      await send('Page.navigate', { url: `${origin}/test/fixtures/web.html` })
      let ready = false
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        await pause()
        const result = await send('Runtime.evaluate', { expression: 'Boolean(window.__lingobarWebTest && document.querySelector(".web-shell"))', returnByValue: true })
        ready = result.result.value
      }
      assert.ok(ready, 'Web fixture did not mount')
      const result = await send('Runtime.evaluate', { expression: 'window.__lingobarWebTest.run()', awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(`Web ${width}px: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
      for (const mode of ['expanded', 'compact']) {
        const prepared = await send('Runtime.evaluate', { expression: 'window.__lingobarWebTest.prepareTouch(' + JSON.stringify(mode) + ')', awaitPromise: true, returnByValue: true })
        if (prepared.exceptionDetails) throw new Error('Touch preparation: ' + (prepared.exceptionDetails.exception?.description || prepared.exceptionDetails.text))
        const point = prepared.result.value
        assert.ok(point.overflow > 180, 'Synthetic touch caption must actually overflow')
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1, radiusX: 5, radiusY: 5 }] })
        for (let step = 1; step <= 20; step++) {
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + step * 5, id: 1, radiusX: 5, radiusY: 5 }] })
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await pause()
        const checked = await send('Runtime.evaluate', { expression: 'window.__lingobarWebTest.verifyTouch(' + JSON.stringify(point) + ')', awaitPromise: true, returnByValue: true })
        if (checked.exceptionDetails) throw new Error('Touch review: ' + (checked.exceptionDetails.exception?.description || checked.exceptionDetails.text))
        console.log('Synthetic touch observation: ' + JSON.stringify({ width, ...checked.result.value }))
        result.result.value.checks.push(...checked.result.value.checks)
        touchFailures.push(...checked.result.value.failures)
        const tap = async point => {
          await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1, radiusX: 5, radiusY: 5 }] })
          await new Promise(resolve => setTimeout(resolve, 50))
          await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await pause()
        }
        const getPoint = async expression => {
          const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (value.exceptionDetails) throw new Error('Touch control: ' + (value.exceptionDetails.exception?.description || value.exceptionDetails.text))
          return value.result.value
        }
        await tap(await getPoint('window.__lingobarWebTest.prepareTouchReturn(' + JSON.stringify(point) + ')'))
        const returned = await getPoint('window.__lingobarWebTest.verifyTouchReturn(' + JSON.stringify(point) + ')')
        result.result.value.checks.push(...returned.checks)
        await tap(await getPoint('window.__lingobarWebTest.touchPoint(".web-footer button:last-child")'))
        const historyPoint = await getPoint('window.__lingobarWebTest.prepareTouchHistory()')
        await tap(historyPoint)
        const selected = await getPoint('window.__lingobarWebTest.verifyTouchHistory(' + JSON.stringify(historyPoint.id) + ')')
        result.result.value.checks.push(...selected.checks)
      }
      results.push({ width, height, scale, ...result.result.value })
      screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(output, `synthetic-${width}.png`), Buffer.from(screenshot.data, 'base64'))
      console.log(`Web synthetic regression: ${result.result.value.checks.length} checks at ${width}x${height} scale ${scale}`)
    }
    writeFileSync(join(output, 'results.json'), JSON.stringify({ touchFailures, productionUnconfigured: unconfigured.result.value, results, note: 'Linux Chromium emulation and synthetic transport/media only. No iPhone/Safari, live Workers, provider or real microphone acceptance.' }, null, 2))
    assert.deepEqual(touchFailures, [], 'Native touch review regressions')
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
