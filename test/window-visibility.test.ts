import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the handlers installed by the actual main entrypoint. All media,
// services, storage and Electron APIs below are synthetic; no device is opened.
const f = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const listeners = new Map<string, (...args: any[]) => any>()
  const frame = { url: 'http://127.0.0.1:5173/' }
  const webContents = { mainFrame: frame, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
  const image = { setTemplateImage: vi.fn() }
  const visibility = { value: false }
  const window = { webContents, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined), loadFile: vi.fn().mockResolvedValue(undefined), setAlwaysOnTop: vi.fn(),
    show: vi.fn(() => { visibility.value = true }), hide: vi.fn(() => { visibility.value = false }),
    isVisible: () => visibility.value, focus: vi.fn() }
  const tray = { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn() }
  const shortcut = { register: vi.fn((_accelerator: string, _callback: () => void) => true) }
  const preferences = { captureMode: 'microphone', microphoneDeviceId: 'fixture-microphone', targetLanguages: ['en'],
    showOriginal: true, showFurigana: true, alwaysOnTop: true, opacity: .94, fontSize: 16, launchAtLogin: false,
    asrEndpoint: 'wss://fixture.invalid', asrModel: 'fixture', translationBaseUrl: 'https://fixture.invalid', translationModel: 'fixture',
    hasAsrKey: true, hasTranslationKey: true }
  const storage = { settings: vi.fn(() => ({ ...preferences })), saved: () => [], key: vi.fn(() => 'synthetic-only-key'), save: vi.fn(), saveCaptions: vi.fn() }
  const audio = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), pause: vi.fn(), pushMicrophone: vi.fn() }
  const callbacks = { changed: null as null | (() => void), audio: null as any }
  const queue = { captions: [], finishPartials: vi.fn(), close: vi.fn(), updatePartial: vi.fn(() => callbacks.changed?.()) }
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  const app = { setName: vi.fn(), setPath: vi.fn(), setAppUserModelId: vi.fn(), getPath: () => '/synthetic/lingobar', isPackaged: false,
    requestSingleInstanceLock: () => true, on: vi.fn(), quit: vi.fn(), whenReady: () => Promise.resolve(), getAppPath: () => '/synthetic-app' }
  return { handlers, listeners, frame, webContents, window, image, storage, audio, queue, session, app, preferences, visibility, tray, shortcut, callbacks }
})

vi.mock('electron', () => ({
  app: f.app,
  BrowserWindow: vi.fn(function () { return f.window }),
  Tray: vi.fn(function () { return f.tray }),
  nativeImage: { createFromDataURL: () => f.image, createFromPath: () => f.image },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (value: unknown) => value },
  globalShortcut: f.shortcut, clipboard: { writeText: vi.fn() }, dialog: {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: f.session },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => f.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: any[]) => any) => f.listeners.set(channel, listener) }
}))
vi.mock('../src/main/storage', () => ({ Storage: vi.fn(function () { return f.storage }) }))
vi.mock('../src/main/captions', () => ({ CaptionQueue: vi.fn(function (_saved: unknown, _config: unknown, changed: () => void) { f.callbacks.changed = changed; return f.queue }) }))
vi.mock('../src/main/audio', () => ({ AudioEngine: vi.fn(function (callbacks: unknown) { f.callbacks.audio = callbacks; return f.audio }) }))
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))

const trusted = () => ({ sender: f.webContents, senderFrame: f.frame })
const invoke = (channel: string, ...args: unknown[]) => f.handlers.get(channel)!(trusted(), ...args)
async function listening() {
  await invoke('lingo:start')
  const run = f.webContents.send.mock.calls.find(call => call[0] === 'lingo:microphone' && call[1] === true)![2]
  f.listeners.get('lingo:microphone-ready')!(trusted(), run)
  expect(invoke('lingo:snapshot').state).toBe('listening')
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  f.handlers.clear(); f.listeners.clear()
  f.frame.url = 'http://127.0.0.1:5173/'
  f.preferences.captureMode = 'microphone'
  f.visibility.value = false
  f.callbacks.audio = null; f.callbacks.changed = null
  f.audio.pause.mockImplementation(() => { f.callbacks.audio.onState('idle', 'Synthetic pause'); return Promise.resolve('finished') })
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
  await import('../src/main/index')
  await Promise.resolve(); await Promise.resolve()
})
afterEach(() => vi.unstubAllEnvs())

describe('installed window visibility routes', () => {
  it('hides through the trusted control without stopping or restarting an active capture', async () => {
    await listening()
    f.window.show()
    const state = invoke('lingo:snapshot').state
    invoke('lingo:hide')
    expect(f.visibility.value).toBe(false)
    expect(invoke('lingo:snapshot').state).toBe(state)
    expect(f.audio.stop).not.toHaveBeenCalled()
    expect(f.audio.start).toHaveBeenCalledOnce()
    expect(f.window.focus).not.toHaveBeenCalled()
  })

  it('rejects foreign hide requests and does not let them affect window visibility', () => {
    f.window.show()
    const hide = f.handlers.get('lingo:hide')!
    for (const event of [{ sender: {}, senderFrame: f.frame }, { sender: f.webContents, senderFrame: { ...f.frame } }])
      expect(() => hide(event)).toThrow('无法访问')
    f.frame.url = 'https://example.invalid'
    expect(() => hide(trusted())).toThrow('无法访问')
    expect(f.visibility.value).toBe(true)
    expect(f.window.hide).not.toHaveBeenCalled()
  })

  it('toggles the registered shortcut repeatedly and focuses only when showing', () => {
    expect(f.shortcut.register).toHaveBeenCalledWith('CommandOrControl+Alt+L', expect.any(Function))
    const toggle = f.shortcut.register.mock.calls[0][1] as () => void
    toggle()
    expect(f.visibility.value).toBe(true)
    expect(f.window.focus).toHaveBeenCalledOnce()
    toggle()
    expect(f.visibility.value).toBe(false)
    expect(f.window.focus).toHaveBeenCalledOnce()
    toggle()
    expect(f.visibility.value).toBe(true)
    expect(f.window.focus).toHaveBeenCalledTimes(2)
  })

  it('keeps ordinary snapshots and stop updates hidden until explicit application activation', async () => {
    await listening()
    f.window.show()
    invoke('lingo:hide')
    f.callbacks.audio.onPartial('system', 'Synthetic window visibility partial', 'synthetic-window')
    f.callbacks.audio.onPartial('system', 'Synthetic window visibility partial revised', 'synthetic-window')
    await invoke('lingo:stop')
    invoke('lingo:settings', { opacity: .45 })
    invoke('lingo:settings', { opacity: .94 })
    expect(f.webContents.send).toHaveBeenCalledWith('lingo:changed', expect.any(Object))
    expect(f.visibility.value).toBe(false)
    expect(f.window.show).toHaveBeenCalledOnce()
    for (const name of ['activate', 'second-instance']) {
      const callback = f.app.on.mock.calls.find(call => call[0] === name)![1] as () => void
      callback()
      expect(f.visibility.value).toBe(true)
      invoke('lingo:hide')
    }
  })

  it('routes native close to hide and retains explicit tray/menu recovery', () => {
    f.window.show()
    const preventDefault = vi.fn()
    const close = f.window.on.mock.calls.find(call => call[0] === 'close')![1] as (event: unknown) => void
    close({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.visibility.value).toBe(false)
    const trayClick = f.tray.on.mock.calls.find(call => call[0] === 'click')![1] as () => void
    trayClick()
    expect(f.visibility.value).toBe(true)
    invoke('lingo:hide')
    const menu = f.tray.setContextMenu.mock.calls[0][0] as Array<{ label: string; click?: () => void }>
    menu[0].click!()
    expect(f.visibility.value).toBe(true)
    expect(f.audio.start).not.toHaveBeenCalled()
  })

})
