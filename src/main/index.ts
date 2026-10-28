import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioSource, ListeningState, Snapshot, Settings, SettingsInput } from '../shared/types'
import { Storage } from './storage'
import { CaptionQueue } from './captions'
import { AudioEngine } from './audio'
import { isTargetLanguage, languageInfo } from '../shared/languages'
import { trace } from './diagnostics'
import { desktopPlatform, platformLabels } from '../shared/platform'
import { mayUseLocalKeyImport, trustedRendererUrl } from './ipc-security'
import { installMediaPermissions } from './media-permissions'
import { LoginItems } from './login-items'
import { LearningStore } from './learning-store'
import { DesktopLearning } from './learning'
import { learningMarkdown } from './learning-export'
import { DictionaryStore } from './dictionary-store'
import { DictionaryLearning } from './dictionary-learning'
import { explainDictionary } from './dictionary-provider'
import { commitDictionaryExport } from './dictionary-file-export'

app.setName('LingoBar')
if (process.platform === 'win32') app.setAppUserModelId('com.lingobar.app')
app.setPath('userData', process.env.LINGOBAR_TEST_DATA || join(app.getPath('appData'), 'LingoBar'))
let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let storage: Storage
let queue: CaptionQueue
let audio: AudioEngine
let learning: DesktopLearning
let dictionary: DictionaryLearning
let dictionaryExporting = false
let dictionaryQuitApproved = false
let dictionaryQuitPrompt = false
let state: ListeningState = 'idle'
let message = '准备好后，开始聆听。'
let partial: Snapshot['partial'] = {}
let partialIds: Partial<Record<AudioSource, string>> = {}
let collapsed = false
let startGeneration = 0
let microphoneRun: number | null = null
let expandedBounds: Electron.Rectangle | null = null
const platform = desktopPlatform(process.platform)
const loginItems = new LoginItems(app, platform)
const labels = platformLabels(platform)
const rendererLocation = () => ({ packaged: app.isPackaged, htmlPath: join(__dirname, '../renderer/index.html'), developmentUrl: process.env.ELECTRON_RENDERER_URL })

function snapshot(): Snapshot {
  return { settings: storage.settings(), state, message, captions: queue.captions, partial, collapsed, learning: learning?.snapshot() }
}
function publish(): void {
  if (window && !window.isDestroyed()) window.webContents.send('lingo:changed', snapshot())
}
function microphone(enabled: boolean, run = startGeneration): void {
  if (window && !window.isDestroyed()) window.webContents.send('lingo:microphone', enabled, run, storage.settings().microphoneDeviceId)
}
function stop(): void {
  startGeneration++
  microphoneRun = null
  microphone(false)
  audio.stop()
  queue?.cancelAnnotationRetries()
  queue?.finishPartials()
  partial = {}
  partialIds = {}
  state = 'idle'
  message = '已暂停，可以继续阅读或收藏。'
  publish()
}
function fail(error: unknown): void {
  stop()
  state = 'error'
  message = error instanceof Error ? error.message : typeof error === 'string' ? error : '声音连接中断，请重试。'
  publish()
}
async function start(): Promise<void> {
  if (state === 'listening' || state === 'starting') return
  queue?.cancelAnnotationRetries()
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
  const dictionaryOwner = window.webContents.id
  window.webContents.on('render-process-gone', () => { dictionary?.releaseOwner(dictionaryOwner); stop() })
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) dictionary?.releaseOwner(dictionaryOwner) })
  window.webContents.on('destroyed', () => dictionary?.releaseOwner(dictionaryOwner))
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
function ownedHandle(channel: string, handler: (owner: number, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event) || !Number.isInteger(event.sender.id)) throw new Error('无法访问此操作。')
    return handler(event.sender.id, ...args)
  })
}
function wireDictionaryIPC(): void {
  ownedHandle('lingo:dictionary-availability', () => dictionary.availability())
  ownedHandle('lingo:dictionary-open', (owner, input) => dictionary.open(owner, input))
  ownedHandle('lingo:dictionary-open-encounter', (owner, id) => dictionary.openEncounter(owner, id))
  ownedHandle('lingo:dictionary-release', (owner, handle) => dictionary.release(owner, handle))
  ownedHandle('lingo:dictionary-explain', (owner, input) => dictionary.explain(owner, input))
  ownedHandle('lingo:dictionary-cancel', (_owner, id, attempt) => dictionary.cancel(id, attempt))
  ownedHandle('lingo:dictionary-retry-save', (_owner, id, attempt) => dictionary.retrySave(id, attempt))
  ownedHandle('lingo:dictionary-discard-unsaved', (_owner, id, attempt) => dictionary.discardUnsaved(id, attempt))
  ownedHandle('lingo:dictionary-list', (_owner, query) => dictionary.store.list(query))
  ownedHandle('lingo:dictionary-get', (_owner, id) => dictionary.get(id))
  ownedHandle('lingo:dictionary-edit', (_owner, id, input) => dictionary.edit(id, input))
  ownedHandle('lingo:dictionary-remove', (_owner, id) => dictionary.remove(id))
  ownedHandle('lingo:dictionary-review-start', owner => dictionary.startReview(owner))
  ownedHandle('lingo:dictionary-review-state', (owner, session) => dictionary.reviewState(owner, session))
  ownedHandle('lingo:dictionary-review-end', (owner, session) => dictionary.endReview(owner, session))
  ownedHandle('lingo:dictionary-review-reveal', (owner, session, id, explanation) => dictionary.reveal(owner, session, id, explanation))
  ownedHandle('lingo:dictionary-review-rate', (owner, session, reveal, response) => dictionary.rate(owner, session, reveal, response))
  ownedHandle('lingo:dictionary-review-skip', (owner, session) => dictionary.skip(owner, session))
  ownedHandle('lingo:dictionary-review-undo', (owner, session, event) => dictionary.undo(owner, session, event))
  ownedHandle('lingo:dictionary-export', async (_owner, format: unknown) => {
    if (format !== 'json' && format !== 'markdown') throw new Error('请选择 JSON 或 Markdown 导出。')
    if (dictionaryExporting) throw new Error('已有导出正在进行。')
    dictionaryExporting = true
    try {
      const result = await dialog.showSaveDialog(window!, { title: '导出独立学习历史', defaultPath: `LingoBar-learning-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`, filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [format === 'json' ? 'json' : 'md'] }] })
      if (result.canceled || !result.filePath) return { saved: false, message: '已取消导出。' }
      return await commitDictionaryExport(dictionary.store, result.filePath, format)
    } catch { throw new Error('学习历史导出未完成，请检查保存位置与写入权限。') }
    finally { dictionaryExporting = false }
  })
}
function wireIPC(): void {
  wireDictionaryIPC()
  handle('lingo:snapshot', snapshot)
  handle('lingo:settings', (input: SettingsInput) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式不正确。')
    const previousSettings = storage.settings()
    if (state === 'starting' || state === 'listening') {
      const serviceKeys: (keyof SettingsInput)[] = ['captureMode', 'microphoneDeviceId', 'asrEndpoint', 'asrModel', 'asrApiKey', 'translationBaseUrl', 'translationModel', 'translationApiKey']
      const current = storage.settings()
      if (serviceKeys.some(key => input[key] !== undefined && input[key] !== '' && input[key] !== current[key as keyof typeof current])) stop()
    }
    // The dedicated UI removal action sends exactly this one false field.
    // Full preference forms and ordinary opacity/font saves never touch OS login items.
    const removeLoginItem = input.launchAtLogin === false && Object.keys(input).length === 1
    if (removeLoginItem) loginItems.remove()
    let settings: Settings
    try {
      settings = storage.save(removeLoginItem ? { launchAtLogin: false } : input)
    } catch (error) {
      if (removeLoginItem) throw new Error('语伴登录项已确认关闭，但本地设置未能保存；应用不会恢复或启用它。')
      throw error
    }
    if (settings.showFurigana !== previousSettings.showFurigana || settings.targetLanguages.join('|') !== previousSettings.targetLanguages.join('|') ||
      settings.translationBaseUrl !== previousSettings.translationBaseUrl || settings.translationModel !== previousSettings.translationModel || Boolean(input.translationApiKey?.trim())) queue.cancelAnnotationRetries()
    applyPreferences()
    publish()
    return settings
  })
  handle('lingo:start', start)
  handle('lingo:stop', stop)
  handle('lingo:text', (text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请先输入一句话。')
    if (!storage.key('translation')) throw new Error('请先在设置中配置翻译密钥。')
    queue.add(text, 'text')
  })
  handle('lingo:retry', (id: unknown) => { if (typeof id === 'string') queue.retry(id) })
  handle('lingo:retry-annotation', (id: unknown) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 512) throw new Error('请选择有效的字幕段落。')
    queue.retryAnnotation(id)
  })
  handle('lingo:save-caption', (id: unknown) => { if (typeof id === 'string') learning.toggleSaved(id) })
  handle('lingo:learning-pin', (target: unknown) => learning.pin(target))
  handle('lingo:learning-save', (edit: unknown) => learning.save(edit))
  handle('lingo:learning-session', (name: unknown) => {
    if (name !== null && (typeof name !== 'string' || name.length > 80)) throw new Error('会话名称无效。')
    learning.store.session(name as string | null, queue.captions); publish()
  })
  handle('lingo:learning-remove-notes', (id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('字幕编号无效。')
    learning.store.remove(id, queue.captions); publish()
  })
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
    // Saving requires a completed translation; retries retain that useful text
    // even while pending or failed. Export the same collection shown in history.
    const saved = queue.captions.filter(c => c.saved)
    if (!saved.length) throw new Error('先收藏一句，再导出学习笔记。')
    const selectedIds = new Set(saved.map(caption => caption.id))
    const result = await dialog.showSaveDialog(window!, { title: '导出学习笔记', defaultPath: `LingoBar-${new Date().toISOString().slice(0, 10)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (result.canceled || !result.filePath) return false
    const exported = queue.captions.filter(caption => caption.saved && selectedIds.has(caption.id))
    const records = learning.snapshot().records
    const content = '# LingoBar 学习笔记\n\n' + exported.map(c => {
      const translations = c.translations || { zh: c.zh, en: c.en, ja: c.ja }
      const order = [...new Set([...(c.targetLanguages || []), ...Object.keys(translations).filter(isTargetLanguage)])]
      return `## ${new Date(c.createdAt).toLocaleString('zh-CN')}\n\n原文：${c.original}\n\n` +
        order.filter(code => translations[code]).map(code => `${languageInfo(code).nativeName}：${translations[code]}`).join('\n\n') +
        (translations.ja && c.reading ? `\n\n日语读音：${c.reading}` : '') + learningMarkdown(c.id, records) + '\n'
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
    if (trusted(event) && microphoneRun !== null && run === microphoneRun && (state === 'listening' || state === 'starting')) fail(typeof error === 'string' ? error.slice(0, 300) : '麦克风不可用，请检查系统权限。')
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
    learning = new DesktopLearning(new LearningStore(app.getPath('userData')), queue, () => storage.settings(), () => Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()), publish)
    dictionary = new DictionaryLearning(new DictionaryStore(app.getPath('userData')), () => queue.captions, () => {
      const settings = storage.settings()
      let providerLabel = '兼容翻译服务'
      try { if (new URL(settings.translationBaseUrl).hostname === 'api.deepseek.com') providerLabel = 'DeepSeek' } catch { /* Existing settings provide the endpoint; never disclose it here. */ }
      return { configured: settings.hasTranslationKey, providerLabel, model: settings.translationModel.trim() || 'deepseek-flash', offlineDictionaryAvailable: false }
    }, (input, signal) => {
      const settings = storage.settings()
      // This closure runs only after an explicit verified query and both durable outbound writes.
      return explainDictionary(input, { baseUrl: settings.translationBaseUrl, model: settings.translationModel, apiKey: storage.key('translation') }, signal)
    }, () => { if (window && !window.isDestroyed()) window.webContents.send('lingo:dictionary-changed') })
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
      { label: '开始 / 暂停聆听', click: () => { if (state === 'listening' || state === 'starting') stop(); else void start().catch(() => { /* start handles only its current generation. */ }) } },
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
    learning.shortcutAvailable = globalShortcut.register('CommandOrControl+Alt+S', () => {
      if (window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()) window.webContents.send('lingo:quick-pin')
    })
    publish()
    app.on('activate', show)
  })
  app.on('window-all-closed', () => { /* The tray/menu bar keeps the app resident. */ })
  app.on('before-quit', event => {
    if (dictionary?.hasUnsaved && !dictionaryQuitApproved) {
      event.preventDefault()
      if (dictionaryQuitPrompt) return
      dictionaryQuitPrompt = true
      void dialog.showMessageBox(window!, { type: 'warning', buttons: ['返回应用', '放弃并退出'], defaultId: 0, cancelId: 0, message: '有解释结果尚未保存，仅在本次应用内存。退出将丢失。', detail: '可先在学习历史重试保存，不会再次调用服务。退出不会自动重新发出请求。' }).then(result => {
        if (result.response === 1) { dictionaryQuitApproved = true; app.quit() }
      }).catch(() => { /* Keep the app and in-memory result if the native quit prompt cannot be shown. */ }).finally(() => { dictionaryQuitPrompt = false })
      return
    }
    quitting = true; dictionary?.close(); audio?.stop(); queue?.close(); globalShortcut.unregisterAll(); tray?.destroy()
  })
}
