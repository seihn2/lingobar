// Actual desktop renderer; synthetic learning data and mocked providers only.
const { spawn } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const executable = [process.env.CHROMIUM_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(existsSync)
if (!executable) throw new Error('Use an already installed Chromium via CHROMIUM_PATH; no software is downloaded.')
async function main() {
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({ root, configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  const profile = mkdtempSync(join(tmpdir(), 'lingobar-dictionary-ui-'))
  const pending = new Map(), results = []
  let child, socket, sequence = 0
  const delay = () => new Promise(resolve => setTimeout(resolve, 50))
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    child = spawn(executable, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=860,560', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false })
    let diagnostics = '', launchError, port
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8192) }); child.once('error', error => { launchError = error })
    const deadline = Date.now() + 15000
    while (!port && Date.now() < deadline) {
      if (launchError) throw launchError
      if (child.exitCode !== null) throw new Error(`Chromium exited before startup: ${diagnostics}`)
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) } catch { await delay() }
      if (!port) port = Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(diagnostics)?.[1])
    }
    assert.ok(port, `Chromium startup deadline: ${diagnostics}`)
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(result => result.json())
    const page = pages.find(page => page.type === 'page'); assert.ok(page?.webSocketDebuggerUrl)
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let blockedExternal = 0
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP deadline: ${method}`)) }, 30000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Fetch.requestPaused') {
        const url = new URL(message.params.request.url)
        const local = url.origin === origin || ['data:', 'blob:', 'about:'].includes(url.protocol)
        if (!local) blockedExternal++
        void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', local ? { requestId: message.params.requestId } : { requestId: message.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {})
        return
      }
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id); clearTimeout(request.timer)
      if (message.error) request.reject(new Error(JSON.stringify(message.error)))
      else request.resolve(message.result)
    })
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
      return response.result?.value
    }
    await send('Page.enable'); await send('Runtime.enable'); await send('Accessibility.enable')
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    for (const scale of [1, 1.5, 2]) {
      await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 560, deviceScaleFactor: scale, mobile: false })
      await send('Page.navigate', { url: `${origin}/test/fixtures/dictionary.html` })
      let ready = false
      const readyDeadline = Date.now() + 15000
      while (!ready && Date.now() < readyDeadline) { ready = await evaluate('Boolean(window.__lingobarDictionaryTest)'); if (!ready) await delay() }
      assert.ok(ready, 'Dictionary fixture did not mount')
      const result = await evaluate('window.__lingobarDictionaryTest.run()')
      assert.deepEqual(result.failures, [])
      const evidenceDirectory = join(root, 'artifacts/dictionary-ui'); mkdirSync(evidenceDirectory, { recursive: true })
      const offlineScreenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(evidenceDirectory, `offline-synthetic-scale-${scale}.png`), Buffer.from(offlineScreenshot.data, 'base64'))
      const app = await evaluate('window.__lingobarDictionaryTest.appIntegration()')
      assert.deepEqual(app.failures, []); result.checks.push(...app.checks)
      const preparation = await evaluate('window.__lingobarDictionaryTest.prepareReviewAx()')
      const ax = await send('Accessibility.getFullAXTree')
      const exposed = ax.nodes.filter(node => !node.ignored).flatMap(node => [node.name?.value, node.value?.value, node.description?.value]).filter(value => typeof value === 'string').join('\n')
      assert.ok(!preparation.forbidden.some(value => value && exposed.includes(value)), 'Review answer leaked before reveal in the accessibility tree')
      const dom = await evaluate('window.__lingobarDictionaryTest.verifyReviewAx()')
      assert.equal(dom.answerNodes, 0, 'Review retained answer-bearing DOM before reveal')
      const offlinePreparation = await evaluate('window.__lingobarDictionaryTest.prepareOfflineReviewAx()')
      const offlineAx = await send('Accessibility.getFullAXTree')
      const offlineExposed = offlineAx.nodes.filter(node => !node.ignored).flatMap(node => [node.name?.value, node.value?.value, node.description?.value]).filter(value => typeof value === 'string').join('\n')
      assert.ok(!offlinePreparation.forbidden.some(value => value && offlineExposed.includes(value)), 'Offline answer leaked before reveal in the accessibility tree')
      const offlineDom = await evaluate('window.__lingobarDictionaryTest.verifyReviewAx()')
      assert.equal(offlineDom.answerNodes, 0, 'Offline review retained answer-bearing DOM before reveal')
      assert.equal(blockedExternal, 0, 'The synthetic UI attempted an external network request (blocked)')
      results.push({ scale, checks: result.checks, axNodes: ax.nodes.length, offlineAxNodes: offlineAx.nodes.length, answerLeaks: 0, answerDomNodes: dom.answerNodes, offlineAnswerDomNodes: offlineDom.answerNodes })
      console.log(`Dictionary synthetic UI: ${result.checks.length} DOM checks, ${ax.nodes.length} AX nodes, zero answer leaks at scale${scale}`)
    }
    const output = join(root, 'artifacts/dictionary-ui'); mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'results.json'), JSON.stringify({ source: 'actual renderer with synthetic providers/data only', browser: executable, blockedExternal, hardwareAcceptance: false, results }, null, 2))
  } finally {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('UI test finished')) }
    socket?.close(); child?.kill(); await server.close()
    for (let attempt = 0; attempt < 20; attempt++) { try { rmSync(profile, { recursive: true, force: true }); break } catch { await delay() } }
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
