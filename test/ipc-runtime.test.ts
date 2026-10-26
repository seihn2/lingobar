import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the handlers installed by the actual main entrypoint. All media,
// services, storage and Electron APIs below are synthetic; no device is opened.
const f = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const listeners = new Map<string, (...args: any[]) => any>()
  const frame = { url: 'http://127.0.0.1:5173/' }
  const webContents = { mainFrame: frame, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
  const image = { setTemplateImage: vi.fn() }
  const window = { webContents, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(),
    setAlwaysOnTop: vi.fn(), loadURL: vi.fn().mockResolvedValue(undefined), loadFile: vi.fn().mockResolvedValue(undefined), show: vi.fn(), focus: vi.fn() }
  const preferences = { captureMode: 'microphone', microphoneDeviceId: 'fixture-microphone', targetLanguages: ['en'],
    showOriginal: true, showFurigana: true, alwaysOnTop: true, opacity: .94, fontSize: 16, launchAtLogin: false,
    asrEndpoint: 'wss://fixture.invalid', asrModel: 'fixture', translationBaseUrl: 'https://fixture.invalid', translationModel: 'fixture',
    hasAsrKey: true, hasTranslationKey: true }
  const storage = { settings: vi.fn(() => ({ ...preferences })), saved: () => [], key: vi.fn(() => 'synthetic-only-key'), save: vi.fn(), saveCaptions: vi.fn() }
  const audio = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), pushMicrophone: vi.fn() }
  const queue = { captions: [], finishPartials: vi.fn(), close: vi.fn(), retryAnnotation: vi.fn(), cancelAnnotationRetries: vi.fn() }
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  const app = { setName: vi.fn(), setPath: vi.fn(), setAppUserModelId: vi.fn(), getPath: () => '/synthetic/lingobar', isPackaged: false,
    requestSingleInstanceLock: () => true, on: vi.fn(), quit: vi.fn(), whenReady: () => Promise.resolve(), getAppPath: () => '/synthetic-app' }
  return { handlers, listeners, frame, webContents, window, image, storage, audio, queue, session, app, preferences }
})

vi.mock('electron', () => ({
  app: f.app,
  BrowserWindow: vi.fn(function () { return f.window }),
  Tray: vi.fn(function () { return { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn() } }),
  nativeImage: { createFromDataURL: () => f.image, createFromPath: () => f.image },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (value: unknown) => value },
  globalShortcut: { register: vi.fn(() => true) }, clipboard: { writeText: vi.fn() }, dialog: {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: f.session },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => f.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: any[]) => any) => f.listeners.set(channel, listener) }
}))
vi.mock('../src/main/storage', () => ({ Storage: vi.fn(function () { return f.storage }) }))
vi.mock('../src/main/captions', () => ({ CaptionQueue: vi.fn(function () { return f.queue }) }))
vi.mock('../src/main/audio', () => ({ AudioEngine: vi.fn(function () { return f.audio }) }))
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))

const trusted = () => ({ sender: f.webContents, senderFrame: f.frame })
const invoke = (channel: string, ...args: unknown[]) => f.handlers.get(channel)!(trusted(), ...args)

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  f.handlers.clear(); f.listeners.clear()
  f.frame.url = 'http://127.0.0.1:5173/'
  f.storage.save.mockImplementation(input => ({ ...f.preferences, ...input }))
  f.preferences.captureMode = 'microphone'
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  await import('../src/main/index')
  await Promise.resolve(); await Promise.resolve()
})
afterEach(() => vi.unstubAllEnvs())

describe('installed main-process IPC and permission handlers', () => {
  it('rejects operations from external contents, subframes and navigated documents', () => {
    const snapshot = f.handlers.get('lingo:snapshot')!
    expect(() => snapshot({ sender: {}, senderFrame: f.frame })).toThrow('无法访问')
    expect(() => snapshot({ sender: f.webContents, senderFrame: { ...f.frame } })).toThrow('无法访问')
    f.frame.url = 'https://example.invalid'
    expect(() => snapshot(trusted())).toThrow('无法访问')
    expect(f.storage.key).not.toHaveBeenCalled()
    expect(f.audio.start).not.toHaveBeenCalled()
  })

  it('does not expose credentials through snapshots or accept malformed settings', () => {
    const snapshot = invoke('lingo:snapshot')
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-only-key')
    expect(snapshot.settings).not.toHaveProperty('asrKey')
    expect(() => invoke('lingo:settings', null)).toThrow('设置格式')
    expect(() => invoke('lingo:settings', [])).toThrow('设置格式')
    expect(f.storage.save).not.toHaveBeenCalled()
  })

  it('annotation retry accepts only a trusted main frame and never starts audio or reads ASR credentials', () => {
    const handler = f.handlers.get('lingo:retry-annotation')!
    for (const event of [{ sender: {}, senderFrame: f.frame }, { sender: f.webContents, senderFrame: { ...f.frame } }]) expect(() => handler(event, 'synthetic-caption')).toThrow('无法访问')
    for (const id of [null, 42, {}, '', ' ', 'x'.repeat(513)]) expect(() => invoke('lingo:retry-annotation', id)).toThrow('有效的字幕')
    invoke('lingo:retry-annotation', 'synthetic-caption')
    expect(f.queue.retryAnnotation).toHaveBeenCalledExactlyOnceWith('synthetic-caption')
    expect(f.audio.start).not.toHaveBeenCalled(); expect(f.storage.key).not.toHaveBeenCalled()
    expect(f.webContents.send.mock.calls.some(call => call[0] === 'lingo:microphone')).toBe(false)
  })

  it('cancels only manual annotation retries at stop/start or meaningful preference changes', async () => {
    invoke('lingo:settings', { fontSize: 20 }); expect(f.queue.cancelAnnotationRetries).not.toHaveBeenCalled()
    invoke('lingo:settings', { showFurigana: false }); expect(f.queue.cancelAnnotationRetries).toHaveBeenCalledOnce()
    invoke('lingo:settings', { targetLanguages: ['ja'] }); expect(f.queue.cancelAnnotationRetries).toHaveBeenCalledTimes(2)
    invoke('lingo:settings', { translationApiKey: 'synthetic-only-key' }); expect(f.queue.cancelAnnotationRetries).toHaveBeenCalledTimes(3)
    await invoke('lingo:start'); expect(f.queue.cancelAnnotationRetries).toHaveBeenCalledTimes(4)
    invoke('lingo:stop'); expect(f.queue.cancelAnnotationRetries).toHaveBeenCalledTimes(5)
  })

  it('allows only an explicitly started microphone and denies camera, subframe and foreign URL access', async () => {
    const request = f.session.setPermissionRequestHandler.mock.calls[0][0]
    const check = f.session.setPermissionCheckHandler.mock.calls[0][0]
    const callback = vi.fn()
    const details = { isMainFrame: true, requestingUrl: f.frame.url, mediaTypes: ['audio'] }
    request(f.webContents, 'media', callback, details)
    expect(callback).toHaveBeenLastCalledWith(false)
    expect(check(f.webContents, 'media', '', { isMainFrame: true, requestingUrl: f.frame.url, mediaType: 'audio' })).toBe(true)
    await invoke('lingo:start')
    request(f.webContents, 'media', callback, details)
    expect(callback).toHaveBeenLastCalledWith(true)
    for (const denied of [{ ...details, mediaTypes: ['audio', 'video'] }, { ...details, mediaTypes: ['video'] }, { ...details, isMainFrame: false }, { ...details, requestingUrl: 'https://example.invalid' }]) {
      request(f.webContents, 'media', callback, denied)
      expect(callback).toHaveBeenLastCalledWith(false)
    }
    expect(check(f.webContents, 'media', '', { isMainFrame: true, requestingUrl: f.frame.url, mediaType: 'audio' })).toBe(true)
    expect(check(f.webContents, 'media', '', { isMainFrame: true, requestingUrl: f.frame.url, mediaType: 'video' })).toBe(false)
    invoke('lingo:stop')
    request(f.webContents, 'media', callback, details)
    expect(callback).toHaveBeenLastCalledWith(false)
    expect(check(f.webContents, 'media', '', { isMainFrame: true, requestingUrl: f.frame.url, mediaType: 'audio' })).toBe(true)
  })

  it('binds PCM to the current microphone run and ignores old, malformed or foreign messages', async () => {
    const pcm = f.listeners.get('lingo:pcm')!
    const chunk = new ArrayBuffer(3200)
    await invoke('lingo:start')
    const firstRun = f.webContents.send.mock.calls.find(call => call[0] === 'lingo:microphone' && call[1] === true)![2]
    expect(f.webContents.send).toHaveBeenCalledWith('lingo:microphone', true, firstRun, 'fixture-microphone')
    pcm(trusted(), chunk, firstRun)
    expect(f.audio.pushMicrophone).toHaveBeenCalledExactlyOnceWith(chunk)
    invoke('lingo:stop')
    await invoke('lingo:start')
    const nextRun = f.webContents.send.mock.calls.filter(call => call[0] === 'lingo:microphone' && call[1] === true).at(-1)![2]
    expect(nextRun).not.toBe(firstRun)
    for (const invalid of [new ArrayBuffer(1), new ArrayBuffer(64002), new Uint8Array(2), 'bad']) pcm(trusted(), invalid, nextRun)
    pcm(trusted(), chunk, firstRun)
    pcm({ sender: {}, senderFrame: f.frame }, chunk, nextRun)
    expect(f.audio.pushMicrophone).toHaveBeenCalledOnce()
    pcm(trusted(), chunk, nextRun)
    expect(f.audio.pushMicrophone).toHaveBeenCalledTimes(2)
  })

  it('rejects platform keychain import before any external command on non-macOS', async () => {
    if (process.platform === 'darwin') return
    await expect(invoke('lingo:import-local-key')).rejects.toThrow('此平台不支持')
    expect(f.storage.save).not.toHaveBeenCalled()
  })
})
