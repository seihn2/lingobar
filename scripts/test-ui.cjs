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
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({ root, configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  const profile = mkdtempSync(join(tmpdir(), 'lingobar-ui-'))
  let child, socket
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
    const results = []
    for (const scale of [1, 1.5, 2]) {
      await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 560, deviceScaleFactor: scale, mobile: false })
      await send('Page.navigate', { url: `${origin}/test/fixtures/ui.html` })
      let ready = false
      const pageDeadline = Date.now() + 15_000
      while (!ready && Date.now() < pageDeadline) {
        const state = await send('Runtime.evaluate', { expression: 'Boolean(window.__lingobarUiTest && document.querySelector(".app-shell"))', returnByValue: true })
        ready = state.result?.value
        if (!ready) await pause()
      }
      assert.ok(ready, 'Renderer fixture startup timed out')
      const result = await send('Runtime.evaluate', { expression: 'window.__lingobarUiTest.run()', awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(`UI scale ${scale}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
      const focus = await send('Runtime.evaluate', { expression: 'window.__lingobarUiTest.panelFocus()', awaitPromise: true, returnByValue: true })
      if (focus.exceptionDetails) throw new Error(`Panel focus: ${focus.exceptionDetails.exception?.description}`)
      assert.deepEqual(focus.result.value.failures, [], `Panel focus regressions at scale ${scale}`)
      result.result.value.checks.push(...focus.result.value.checks)
      const exported = await send('Runtime.evaluate', { expression: 'window.__lingobarUiTest.exportRegression()', awaitPromise: true, returnByValue: true })
      if (exported.exceptionDetails) throw new Error(`Saved export: ${exported.exceptionDetails.exception?.description}`)
      assert.deepEqual(exported.result.value.failures, [], `Saved export regressions at scale ${scale}`)
      result.result.value.checks.push(...exported.result.value.checks)
      const login = await send('Runtime.evaluate', { expression: 'window.__lingobarUiTest.loginItemRegression()', awaitPromise: true, returnByValue: true })
      if (login.exceptionDetails) throw new Error(`Login-item feedback: ${login.exceptionDetails.exception?.description}`)
      result.result.value.checks.push(...login.result.value.checks)
      const press = async (key, code, virtualKey, modifiers = 0) => {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, ...(key === ' ' ? { text: ' ', unmodifiedText: ' ' } : {}) })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers })
      }
      for (const mode of ['settings', 'history']) {
        const prepared = await send('Runtime.evaluate', { expression: `window.__lingobarUiTest.preparePanelA11y('${mode}')`, awaitPromise: true })
        if (prepared.exceptionDetails) throw new Error(`Accessible panel preparation: ${prepared.exceptionDetails.exception?.description}`)
        const tree = await send('Accessibility.getFullAXTree')
        const labels = mode === 'settings' ? ['字幕语言', '服务连接', '显示与启动'] : ['全部', '学习收藏']
        const states = labels.map(label => {
          const node = tree.nodes.find(node => node.role?.value === 'button' && node.name?.value?.startsWith(label))
          return String(node?.properties?.find(property => property.name === 'pressed')?.value?.value)
        })
        assert.deepEqual(states, labels.map((_, index) => String(index === 0)), `${mode} current selection must reach the actual accessibility tree`)
        result.result.value.checks.push(`${mode} current selection reaches the browser accessibility tree`)
        if (mode === 'settings') {
          await press('Tab', 'Tab', 9, 8)
          let active = await send('Runtime.evaluate', { expression: 'document.activeElement.matches(".settings-form button[type=submit]")', returnByValue: true })
          assert.equal(active.result.value, true, 'Trusted Shift+Tab must wrap to the save control')
          await press('Tab', 'Tab', 9)
          active = await send('Runtime.evaluate', { expression: 'document.activeElement.getAttribute("aria-label") === "关闭面板"', returnByValue: true })
          assert.equal(active.result.value, true, 'Trusted Tab must wrap to the close control')
          result.result.value.checks.push('trusted browser Shift+Tab wraps within settings', 'trusted browser Tab wraps within settings')
        }
        await press('Escape', 'Escape', 27)
        await pause()
      }
      const spaceFailures = []
      for (const mode of ['expanded', 'compact']) {
        for (const [reverse, action] of [[false, 'scroll'], [true, 'scroll'], [false, 'modified'], ...(mode === 'expanded' ? [[false, 'copy']] : [])]) {
          const prepared = await send('Runtime.evaluate', { expression: `window.__lingobarUiTest.prepareSpaceScroll('${mode}', ${reverse}, '${action}')`, awaitPromise: true, returnByValue: true })
          if (prepared.exceptionDetails) throw new Error(`Space preparation: ${prepared.exceptionDetails.exception?.description}`)
          assert.ok(prepared.result.value.overflow > 120, 'Synthetic caption viewport must actually overflow')
          await press(' ', 'Space', 32, action === 'modified' ? 2 : reverse ? 8 : 0)
          await new Promise(resolve => setTimeout(resolve, 350))
          const checked = await send('Runtime.evaluate', { expression: `window.__lingobarUiTest.verifySpaceScroll('${mode}', ${reverse}, ${JSON.stringify(prepared.result.value)}, '${action}')`, awaitPromise: true, returnByValue: true })
          if (checked.exceptionDetails) throw new Error(`Space review: ${checked.exceptionDetails.exception?.description}`)
          result.result.value.checks.push(...checked.result.value.checks); spaceFailures.push(...checked.result.value.failures)
        }
      }
      assert.deepEqual(spaceFailures, [], `Trusted Space reading regressions at scale ${scale}`)
      for (const mode of ['expanded', 'compact']) {
        const prepared = await send('Runtime.evaluate', { expression: `window.__lingobarUiTest.prepareHide('${mode}')`, awaitPromise: true, returnByValue: true })
        if (prepared.exceptionDetails) throw new Error(`Hide preparation: ${prepared.exceptionDetails.exception?.description}`)
        const { x, y, calls } = prepared.result.value
        // Real browser input activates :hover; programmatic focus after a mouse
        // action need not match :focus-visible and cannot prove pointer access.
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await pause()
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
        const checked = await send('Runtime.evaluate', { expression: `window.__lingobarUiTest.verifyHide('${mode}', ${calls})`, awaitPromise: true, returnByValue: true })
        if (checked.exceptionDetails) throw new Error(`UI scale ${scale}: ${checked.exceptionDetails.exception?.description}`)
        result.result.value.checks.push(...checked.result.value)
      }
      const study = await send('Runtime.evaluate', { expression: 'window.__lingobarUiTest.learningRegression()', awaitPromise: true, returnByValue: true })
      if (study.exceptionDetails) throw new Error(`Desktop learning: ${study.exceptionDetails.exception?.description}`)
      result.result.value.checks.push(...study.result.value.checks)
      results.push(result.result.value)
      console.log(`UI synthetic regression: ${result.result.value.checks.length} checks at Chromium scale ${scale}`)
    }
    const output = join(root, 'artifacts', 'ui-regression')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'results.json'), JSON.stringify({ browser: executable, note: 'Chromium emulation only; Windows hardware, native drag and actual DPI remain unverified.', results }, null, 2))
    for (const [mode, height] of [['expanded', 560], ['compact', 180]]) {
      await send('Emulation.setDeviceMetricsOverride', { width: 860, height, deviceScaleFactor: 2, mobile: false })
      await send('Runtime.evaluate', { expression: `window.__lingobarUiTest.preview('${mode}')`, awaitPromise: true })
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(output, `synthetic-${mode}.png`), Buffer.from(screenshot.data, 'base64'))
    }
    console.log('UI evidence: artifacts/ui-regression/results.json (synthetic, no real audio/API)')
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('UI test finished')) }
    socket?.close()
    child?.kill()
    await server.close()
    // Windows can keep profile locks briefly after termination; evidence is separate.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break } catch { await pause() }
    }
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
