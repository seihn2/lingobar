// Runs only from test-media-permissions.cjs. No native helper, real hardware,
// service client, credentials or recordings are loaded by this fixture.
const { app, BrowserWindow, ipcMain, session } = require('electron')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const directory = process.env.LINGOBAR_MEDIA_FIXTURE_DIR
const origin = process.env.LINGOBAR_MEDIA_FIXTURE_ORIGIN
if (!directory || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Use the media permission test runner.')
app.setPath('userData', join(directory, 'profile'))
app.commandLine.appendSwitch('use-fake-device-for-media-stream', 'device-count=2')
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-background-networking')
app.on('window-all-closed', () => {})
const { installMediaPermissions } = require(join(directory, 'policy.cjs'))
const fixtureUrl = `${origin}/test/fixtures/media-permissions.html`
const foreignUrl = `${origin}/test/fixtures/media-permissions-foreign.html`
let window, run = null, generation = 0, state = 'idle', message = '', hold = false, denied = false
const requests = [], checks = [], held = []
const settings = { targetLanguages: ['en', 'ja'], showOriginal: true, showFurigana: true,
  captureMode: 'microphone', microphoneDeviceId: 'default', alwaysOnTop: true, opacity: .94, fontSize: 16, launchAtLogin: false,
  asrEndpoint: 'wss://example.invalid', asrModel: 'fixture', translationBaseUrl: 'https://example.invalid', translationModel: 'fixture',
  hasAsrKey: true, hasTranslationKey: true }
const snapshot = () => ({ settings: { ...settings }, state, message, captions: [], partial: {}, collapsed: false })
const publish = () => window.webContents.send('lingo:changed', snapshot())
const stop = () => { run = null; generation++; state = 'idle'; window.webContents.send('lingo:microphone', false, generation, settings.microphoneDeviceId); publish() }
const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === fixtureUrl
const handler = (channel, callback) => ipcMain.handle(channel, (event, ...args) => { assert.ok(trusted(event)); return callback(...args) })
const pause = () => new Promise(resolve => setTimeout(resolve, 20))

async function main() {
  await app.whenReady()
  assert.ok(app.commandLine.hasSwitch('use-fake-device-for-media-stream'))
  for (const forbidden of ['use-fake-ui-for-media-stream', 'auto-accept-camera-and-microphone-capture'])
    assert.equal(app.commandLine.hasSwitch(forbidden), false)
  const mediaSession = session.fromPartition('synthetic-media-permission')
  // Wrap callbacks only to record decisions / model a delayed or denied response.
  // The handlers themselves are bundled directly from the production module.
  installMediaPermissions({
    setPermissionCheckHandler(callback) {
      mediaSession.setPermissionCheckHandler((...args) => { const allowed = callback(...args); checks.push({ allowed, mediaType: args[3].mediaType, mainFrame: args[3].isMainFrame }); return allowed })
    },
    setPermissionRequestHandler(callback) {
      mediaSession.setPermissionRequestHandler((contents, permission, respond, details) => callback(contents, permission, allowed => {
        requests.push({ allowed, delivered: allowed && !denied, mainFrame: details.isMainFrame, mediaTypes: details.mediaTypes, state })
        if (hold && allowed) held.push(() => respond(allowed && !denied))
        else respond(allowed && !denied)
      }, details))
    }
  }, () => ({ contents: window?.webContents || null, location: { packaged: false, htmlPath: '', developmentUrl: fixtureUrl }, microphoneRun: run, state }))
  window = new BrowserWindow({ show: false, width: 860, height: 620,
    webPreferences: { session: mediaSession, preload: join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  mediaSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }))
  handler('lingo:snapshot', snapshot)
  handler('lingo:settings', input => { for (const key of Object.keys(settings)) if (key in input) settings[key] = input[key]; publish(); return { ...settings } })
  handler('lingo:start', () => { run = ++generation; state = 'starting'; message = ''; publish(); window.webContents.send('lingo:microphone', true, run, settings.microphoneDeviceId) })
  handler('lingo:stop', stop)
  handler('lingo:compact-height', () => {})
  ipcMain.on('lingo:pcm', event => { assert.ok(trusted(event)) /* Drop synthetic PCM; never save it. */ })
  ipcMain.on('lingo:microphone-ready', (event, id) => { assert.ok(trusted(event)); if (id === run) { state = 'listening'; publish() } })
  ipcMain.on('lingo:microphone-failed', (event, error, id) => { assert.ok(trusted(event)); if (id === run) { stop(); state = 'error'; message = error; publish() } })
  handler('fixture:control', (action, value) => {
    if (action === 'stats') return { requests: [...requests], checks: [...checks], state, run, held: held.length, settings: { ...settings } }
    if (action === 'hold') hold = value
    else if (action === 'deny') denied = value
    else if (action === 'release') { hold = false; for (const respond of held.splice(0)) respond() }
    else throw new Error('Unknown fixture action')
  })
  await window.loadURL(fixtureUrl)
  const deadline = Date.now() + 20000
  while (!await window.webContents.executeJavaScript('Boolean(window.__runMediaPermissionTests)')) {
    assert.ok(Date.now() < deadline, 'Renderer fixture startup timed out'); await pause()
  }
  const assertions = await window.webContents.executeJavaScript('window.__runMediaPermissionTests()')
  const check = (value, label) => { assert.ok(value, label); assertions.push(label) }
  // Keep an explicit run active so untrusted contexts cannot pass merely because
  // the application is idle. Same-URL iframe includes microphone permissions.
  run = ++generation; state = 'starting'
  await window.webContents.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.allow='microphone; camera';f.src=${JSON.stringify(fixtureUrl)};f.onload=()=>resolve();document.body.append(f)})`)
  const child = window.webContents.mainFrame.frames[0]
  const request = `navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'UNEXPECTED_CAPTURE'},e=>e.name)`
  const enumerate = `navigator.mediaDevices.enumerateDevices().then(ds=>ds.filter(d=>d.kind==='audioinput').map(d=>({id:d.deviceId,label:d.label})))`
  check(await child.executeJavaScript(request) === 'NotAllowedError', 'same-URL microphone-enabled subframe cannot capture during an active run')
  check((await child.executeJavaScript(enumerate)).every(device => !device.id && !device.label), 'subframe cannot enumerate named microphones')
  const foreign = new BrowserWindow({ show: false, webPreferences: { session: mediaSession, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await foreign.loadURL(fixtureUrl)
  check(await foreign.webContents.executeJavaScript(request) === 'NotAllowedError', 'other WebContents cannot capture during an active run')
  const metadata = await foreign.webContents.executeJavaScript(enumerate)
  check(metadata.every(device => !device.id && !device.label), 'untrusted WebContents cannot enumerate named microphones')
  foreign.destroy()
  await window.loadURL(foreignUrl)
  check(await window.webContents.executeJavaScript(request) === 'NotAllowedError', 'navigated main frame cannot capture during an active run')
  check((await window.webContents.executeJavaScript(enumerate)).every(device => !device.id && !device.label), 'navigated main frame cannot enumerate named microphones')
  check(requests.some(request => !request.mainFrame && !request.allowed), 'real request handler rejected the subframe')
  console.log('LINGOBAR_MEDIA_RESULT:' + JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome,
    platform: process.platform, arch: process.arch, fakeDevices: true, fakeUI: false, checks: assertions,
    requests, note: 'Synthetic Electron media devices and real production permission/preload/renderer code. No hardware or service acceptance.' }))
  window.destroy(); app.quit()
}
main().catch(error => { console.error(error.stack || error.message); app.exit(1) })
