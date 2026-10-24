import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioSource, ListeningState, PauseResult, Snapshot, SettingsInput } from '../shared/types'
import { Storage } from './storage'
import { CaptionQueue } from './captions'
import { AudioEngine } from './audio'
import { isTargetLanguage, languageInfo } from '../shared/languages'
import { trace } from './diagnostics'
import { desktopPlatform, platformLabels } from '../shared/platform'
import { mayUseLocalKeyImport, trustedRendererUrl } from './ipc-security'
import { installMediaPermissions } from './media-permissions'

app.setName('LingoBar')
if (process.platform === 'win32') app.setAppUserModelId('com.lingobar.app')
app.setPath('userData', process.env.LINGOBAR_TEST_DATA || join(app.getPath('appData'), 'LingoBar'))
let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let storage: Storage
let queue: CaptionQueue
let audio: AudioEngine
let state: ListeningState = 'idle'
let message = '准备好后，开始聆听。'
let partial: Snapshot['partial'] = {}
let partialIds: Partial<Record<AudioSource, string>> = {}
let collapsed = false
let startGeneration = 0
let microphoneRun: number | null = null
let drainingMicrophoneRun: number | null = null
let pauseTask: Promise<PauseResult> | null = null
let expandedBounds: Electron.Rectangle | null = null
const platform = desktopPlatform(process.platform)
const labels = platformLabels(platform)
const rendererLocation = () => ({ packaged: app.isPackaged, htmlPath: join(__dirname, '../renderer/index.html'), developmentUrl: process.env.ELECTRON_RENDERER_URL })

function snapshot(): Snapshot {
  return { settings: storage.settings(), state, message, captions: queue.captions, partial, collapsed }
}
function publish(): void {
  if (window && !window.isDestroyed()) window.webContents.send('lingo:changed', snapshot())
}
function microphone(enabled: boolean, run = startGeneration): void {
  if (window && !window.isDestroyed()) window.webContents.send('lingo:microphone', enabled, run, storage.settings().microphoneDeviceId)
}
function stop(): void {
  startGeneration++
  pauseTask = null
  drainingMicrophoneRun = null
  microphoneRun = null
  microphone(false)
  audio.stop()
  queue?.finishPartials()
  partial = {}
  partialIds = {}
  state = 'idle'
  message = '已暂停，可以继续阅读或收藏。'
  publish()
}
async function pause(): Promise<PauseResult> {
  if (pauseTask) return pauseTask
  // Cancelling a connection/permission prompt remains immediate.
  if (state !== 'listening') { stop(); return 'cancelled' }
  const generation = ++startGeneration
  drainingMicrophoneRun = microphoneRun
  microphoneRun = null
  microphone(false)
  const task = audio.pause().then(result => {
    if (quitting || generation !== startGeneration) return 'cancelled' as const
    queue.finishPartials()
    partial = {}; partialIds = {}
    drainingMicrophoneRun = null
    publish()
    return result
  })
  pauseTask = task
  try { return await task }
  finally { if (pauseTask === task) pauseTask = null }
}
function fail(error: unknown): void {
  stop()
  state = 'error'
  message = error instanceof Error ? error.message : typeof error === 'string' ? error : '声音连接中断，请重试。'
  publish()
}
async function start(): Promise<void> {
  if (state === 'listening' || state === 'starting') return
  if (pauseTask) stop()
  const generation = ++startGeneration
  try {
    const settings = storage.settings()
    const asrKey = storage.key('asr')
    const translationKey = storage.key('translation')
    if (!asrKey || !translationKey) throw new Error('请先在设置中配置语音识别和翻译密钥。')
    microphoneRun = settings.captureMode === 'system' ? null : generation
    state = 'starting'
    message = '正在连接语音识别…'
    publish()
    await audio.start({ mode: settings.captureMode, apiKey: asrKey, model: settings.asrModel, endpoint: settings.asrEndpoint })
    if (generation !== startGeneration) return
    if (settings.captureMode !== 'system') microphone(true, generation)
  } catch (error) {
    if (generation === startGeneration) fail(error)
    throw error
  }
}
function show(): void {
  window?.show()
  window?.focus()
}
function compactBounds(bounds: Electron.Rectangle, requestedHeight: number): Electron.Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(480, area.width - 16)
  const height = Math.round(Math.max(80, Math.min(requestedHeight, 440, area.height - 16)))
  return {
    width, height,
    x: Math.max(area.x + 8, Math.min(bounds.x, area.x + area.width - width - 8)),
    y: Math.max(area.y + 8, Math.min(bounds.y + bounds.height - height, area.y + area.height - height - 8))
  }
}
function applyPreferences(): void {
  const settings = storage.settings()
  window?.setAlwaysOnTop(settings.alwaysOnTop, 'floating')
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: app.getPath('exe') })
}
function createWindow(): void {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(860, area.width - 32)
  const height = Math.min(560, area.height - 48)
  window = new BrowserWindow({
    width, height, x: Math.round(area.x + (area.width - width) / 2), y: area.y + area.height - height - 24,
    minWidth: 600, minHeight: 420, maxHeight: 1000,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
    resizable: true, roundedCorners: true, show: false, title: 'LingoBar · 语伴',
    ...(platform === 'win32' ? { icon: app.isPackaged ? join(process.resourcesPath, 'icon.ico') : join(app.getAppPath(), 'build/icon.ico') } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  if (platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.on('render-process-gone', () => stop())
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide() } })
  window.once('ready-to-show', () => { applyPreferences(); show() })
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false
  return trustedRendererUrl(event.senderFrame?.url || '', rendererLocation())
}
function handle(channel: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('无法访问此操作。')
    return handler(...args)
  })
}
function wireIPC(): void {
  handle('lingo:snapshot', snapshot)
  handle('lingo:settings', (input: SettingsInput) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式不正确。')
    if (state === 'starting' || state === 'listening' || pauseTask) {
      const serviceKeys: (keyof SettingsInput)[] = ['captureMode', 'microphoneDeviceId', 'asrEndpoint', 'asrModel', 'asrApiKey', 'translationBaseUrl', 'translationModel', 'translationApiKey']
      const current = storage.settings()
      if (serviceKeys.some(key => input[key] !== undefined && input[key] !== '' && input[key] !== current[key as keyof typeof current])) stop()
    }
    const settings = storage.save(input)
    applyPreferences()
    publish()
    return settings
  })
  handle('lingo:start', start)
  handle('lingo:stop', pause)
  handle('lingo:text', (text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请先输入一句话。')
    if (!storage.key('translation')) throw new Error('请先在设置中配置翻译密钥。')
    queue.add(text, 'text')
  })
  handle('lingo:retry', (id: unknown) => { if (typeof id === 'string') queue.retry(id) })
  handle('lingo:save-caption', (id: unknown) => { if (typeof id === 'string') queue.toggleSaved(id) })
  handle('lingo:copy', (text: unknown) => {
    if (typeof text !== 'string' || text.length > 100000) throw new Error('复制内容过长。')
    clipboard.writeText(text)
  })
  handle('lingo:collapse', (value: unknown) => {
    if (!window || typeof value !== 'boolean' || collapsed === value) return
    collapsed = value
    if (value) {
      expandedBounds = window.getBounds()
      const settings = storage.settings()
      const bounds = compactBounds(expandedBounds, 20 + (1 + settings.targetLanguages.length) * 24 + (settings.targetLanguages.includes('ja') && settings.showFurigana ? 8 : 0))
      window.setMinimumSize(bounds.width, 80)
      window.setResizable(false)
      window.setBounds(bounds)
    } else {
      const now = window.getBounds()
      const area = screen.getDisplayMatching(now).workArea
      const height = Math.min(expandedBounds?.height || 560, area.height)
      const width = Math.min(expandedBounds?.width || 860, area.width)
      window.setBounds({ x: Math.max(area.x, Math.min(now.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(now.y + now.height - height, area.y + area.height - height)), height, width })
      window.setResizable(true)
      window.setMinimumSize(600, 420)
    }
    publish()
  })
  handle('lingo:compact-height', (height: unknown) => {
    if (!window || !collapsed || typeof height !== 'number' || !Number.isFinite(height)) return
    const current = window.getBounds()
    const next = compactBounds(current, height)
    if (Math.abs(next.height - current.height) >= 2) window.setBounds(next)
  })
  handle('lingo:export', async () => {
    const saved = queue.captions.filter(c => c.saved && c.status === 'ready')
    if (!saved.length) throw new Error('先收藏一句，再导出学习笔记。')
    const result = await dialog.showSaveDialog(window!, { title: '导出学习笔记', defaultPath: `LingoBar-${new Date().toISOString().slice(0, 10)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (result.canceled || !result.filePath) return false
    const content = '# LingoBar 学习笔记\n\n' + saved.map(c => {
      const translations = c.translations || { zh: c.zh, en: c.en, ja: c.ja }
      const order = [...new Set([...(c.targetLanguages || []), ...Object.keys(translations).filter(isTargetLanguage)])]
      return `## ${new Date(c.createdAt).toLocaleString('zh-CN')}\n\n原文：${c.original}\n\n` +
        order.filter(code => translations[code]).map(code => `${languageInfo(code).nativeName}：${translations[code]}`).join('\n\n') +
        (translations.ja && c.reading ? `\n\n日语读音：${c.reading}` : '') + '\n'
    }).join('\n---\n\n')
    await writeFile(result.filePath, content, { mode: 0o600 })
    return true
  })
  handle('lingo:import-local-key', async () => {
    if (!mayUseLocalKeyImport(process.platform)) throw new Error('此平台不支持本机钥匙串导入，请手动填写服务密钥。')
    stop()
    const key = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/security', ['find-generic-password', '-s', 'com.penumbra.rokid-translator.dashscope', '-a', 'cn', '-w'], { encoding: 'utf8', timeout: 15000, maxBuffer: 8192 }, (error, stdout) => {
        if (error || !stdout.trim()) reject(new Error('未能读取本机已保存的 DashScope 密钥，请手动填写。'))
        else resolve(stdout.trim())
      })
    })
    const settings = storage.save({ asrApiKey: key, asrModel: 'qwen-audio-3.1-asr-flash-streaming', asrEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference' })
    publish()
    return settings
  })
  handle('lingo:hide', () => window?.hide())
  handle('lingo:quit', () => app.quit())
  ipcMain.on('lingo:pcm', (event, chunk: unknown, run: unknown) => {
    if (trusted(event) && microphoneRun !== null && run === microphoneRun && chunk instanceof ArrayBuffer && chunk.byteLength > 0 && chunk.byteLength <= 64000 && chunk.byteLength % 2 === 0 && (state === 'listening' || state === 'starting')) audio.pushMicrophone(chunk)
  })
  ipcMain.on('lingo:microphone-failed', (event, error: unknown, run: unknown) => {
    const active = microphoneRun !== null && run === microphoneRun && (state === 'listening' || state === 'starting')
    const draining = pauseTask !== null && drainingMicrophoneRun !== null && run === drainingMicrophoneRun
    if (trusted(event) && (active || draining)) fail(typeof error === 'string' ? error.slice(0, 300) : '麦克风不可用，请检查系统权限。')
  })
  ipcMain.on('lingo:microphone-ready', (event, run: unknown) => {
    if (trusted(event) && microphoneRun !== null && run === microphoneRun && state === 'starting') {
      state = 'listening'
      message = storage.settings().captureMode === 'both' ? '正在听电脑声音和麦克风' : '正在听麦克风'
      publish()
    }
  })
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', show)
  void app.whenReady().then(() => {
    storage = new Storage(app.getPath('userData'))
    queue = new CaptionQueue(storage.saved(), () => {
      const settings = storage.settings()
      return { baseUrl: settings.translationBaseUrl, model: settings.translationModel, apiKey: storage.key('translation'), targetLanguages: [...settings.targetLanguages], generateFurigana: settings.showFurigana }
    }, publish, captions => storage.saveCaptions(captions))
    audio = new AudioEngine({
      onPartial(source, text, utteranceId) {
        trace('caption.partial', { source, id: utteranceId, chars: text.length })
        if (!text && utteranceId && partialIds[source] !== utteranceId) return
        partial[source] = text
        if (text.trim()) {
          partialIds[source] = utteranceId
          queue.updatePartial(text, source, utteranceId)
        }
        publish()
      },
      onSentence(source, text, utteranceId) {
        trace('caption.final', { source, id: utteranceId, chars: text.length })
        if (!utteranceId || partialIds[source] === utteranceId) {
          delete partial[source]
          delete partialIds[source]
        }
        queue.finishSentence(text, source, utteranceId)
      },
      onState(next, detail) {
        trace('audio.state', { state: next })
        state = next === 'listening' && microphoneRun !== null ? 'starting' : next
        message = next === 'listening' && microphoneRun !== null ? '正在启动麦克风，请允许麦克风权限…' : detail
        publish()
      },
      onError(error) { fail(error) }
    })
    installMediaPermissions(session.defaultSession, () => ({
      contents: window?.webContents || null, location: rendererLocation(), microphoneRun, state
    }))
    createWindow()
    wireIPC()
    const icon = platform === 'win32'
      ? nativeImage.createFromPath(app.isPackaged ? join(process.resourcesPath, 'tray.png') : join(app.getAppPath(), 'build/tray.png'))
      : nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAANUlEQVQ4T2NkoDJgpLJ5DKMGUh6hhv0H4v9ExQzDCBNoODAwMKwYNAyDiWBoKmDUsIEDhQoALbYP5wrmTn0AAAAASUVORK5CYII=')
    if (platform === 'darwin') icon.setTemplateImage(true)
    tray = new Tray(icon)
    if (platform === 'darwin') tray.setTitle('語')
    tray.setToolTip('LingoBar · 语伴')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `显示翻译条  ${labels.shortcut}`, click: show },
      { label: '开始 / 暂停聆听', click: () => { if (state === 'listening' || state === 'starting') void pause(); else void start().catch(() => { /* start handles only its current generation. */ }) } },
      { type: 'separator' }, { label: '退出 LingoBar', click: () => app.quit() }
    ]))
    tray.on('click', show)
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'LingoBar', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '显示翻译条', click: show }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
    ]))
    const registered = globalShortcut.register('CommandOrControl+Alt+L', () => { if (window?.isVisible()) window.hide(); else show() })
    if (!registered) {
      message = `${labels.shortcut} 已被其他应用占用，可以从${labels.residentArea}显示翻译条。`
      publish()
    }
    app.on('activate', show)
  })
  app.on('window-all-closed', () => { /* The tray/menu bar keeps the app resident. */ })
  app.on('before-quit', () => { quitting = true; audio?.stop(); queue?.close(); globalShortcut.unregisterAll(); tray?.destroy() })
}
