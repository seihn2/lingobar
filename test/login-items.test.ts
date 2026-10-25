import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Packaged main + real Storage. All native login-item operations are stubs;
// only synthetic preferences in this test's own temporary directory are written.
const f = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const frame = { url: '' }
  const contents = { mainFrame: frame, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
  const window = { webContents: contents, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(),
    loadFile: vi.fn(), setAlwaysOnTop: vi.fn(), show: vi.fn(), focus: vi.fn() }
  const native = { status: 'not-registered', openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] as any[] }
  const app = { setName: vi.fn(), setPath: vi.fn(), setAppUserModelId: vi.fn(), getPath: (kind: string) => kind === 'exe' ? join(f.directory, 'LingoBar.exe') : f.directory,
    isPackaged: true, requestSingleInstanceLock: () => true, on: vi.fn(), whenReady: () => Promise.resolve(), getAppPath: () => '/synthetic-app',
    setLoginItemSettings: vi.fn(), getLoginItemSettings: vi.fn(() => structuredClone(native)) }
  return { directory: '', platform: 'darwin' as 'darwin' | 'win32', handlers, frame, contents, window, native, app,
    encrypt: vi.fn((text: string) => Buffer.from('synthetic-encrypted:' + text)) }
})
vi.mock('electron', () => ({
  app: f.app, BrowserWindow: vi.fn(function () { return f.window }),
  Tray: vi.fn(function () { return { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() } }),
  nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }), createFromPath: () => ({}) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (v: unknown) => v },
  globalShortcut: { register: vi.fn(() => true), unregisterAll: vi.fn() }, clipboard: {}, dialog: {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => f.handlers.set(name, fn), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'synthetic', encryptString: f.encrypt },
}))
vi.mock('../src/shared/platform', async original => ({ ...await original<object>(), desktopPlatform: () => f.platform }))
vi.mock('../src/main/audio', () => ({ AudioEngine: vi.fn(function () { return { stop: vi.fn() } }) }))
vi.mock('../src/main/captions', () => ({ CaptionQueue: vi.fn(function () { return { captions: [], close: vi.fn(), finishPartials: vi.fn() } }) }))
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))
const event = () => ({ sender: f.contents, senderFrame: f.frame })
const snapshot = () => f.handlers.get('lingo:snapshot')!(event())
const save = (input: object) => f.handlers.get('lingo:settings')!(event(), input)
let originalDisk: string
let resources: PropertyDescriptor | undefined
function applyNative(input: { openAtLogin: boolean }) {
  if (input.openAtLogin !== false) throw new Error('Synthetic guard: startup registration is prohibited')
  f.native.openAtLogin = false
  f.native.status = 'not-registered'
  f.native.launchItems = f.native.launchItems.filter(item => item.name !== 'com.lingobar.app' || item.scope !== 'user')
  f.native.executableWillLaunchAtLogin = f.native.launchItems.some(item => item.enabled)
}
function existingLogin(pending = false) {
  Object.assign(f.native, { status: pending ? 'requires-approval' : 'enabled', openAtLogin: !pending,
    executableWillLaunchAtLogin: !pending, launchItems: [{ name: 'com.lingobar.app', scope: 'user', enabled: true }] })
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); f.handlers.clear()
  f.directory = mkdtempSync(join(tmpdir(), 'lingobar-login-items-'))
  writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({ preferences: { launchAtLogin: false, fontSize: 16 } }))
  originalDisk = readFileSync(join(f.directory, 'settings.json'), 'utf8')
  Object.assign(f.native, { status: 'not-registered', openAtLogin: false, executableWillLaunchAtLogin: false, launchItems: [] })
  f.app.isPackaged = true
  f.app.setLoginItemSettings.mockImplementation(applyNative)
  f.app.getLoginItemSettings.mockImplementation(() => structuredClone(f.native))
  f.encrypt.mockImplementation(text => Buffer.from('synthetic-encrypted:' + text))
  f.frame.url = pathToFileURL(resolve('src/renderer/index.html')).href
  resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: f.directory })
})
afterEach(() => {
  const quit = f.app.on.mock.calls.find(call => call[0] === 'before-quit')?.[1] as (() => void) | undefined
  quit?.(); expect(f.app.setLoginItemSettings.mock.calls.every(([item]) => item.openAtLogin === false)).toBe(true)
  rmSync(f.directory, { recursive: true, force: true })
  if (resources) Object.defineProperty(process, 'resourcesPath', resources)
  else Reflect.deleteProperty(process, 'resourcesPath')
})
async function boot(platform: 'darwin' | 'win32') {
  f.platform = platform
  await import('../src/main/index'); await Promise.resolve(); await Promise.resolve()
}
const ready = () => (f.window.once.mock.calls.find(call => call[0] === 'ready-to-show')![1] as () => void)()

describe.each(['darwin', 'win32'] as const)('packaged %s startup prohibition', platform => {
  it.each([false, true])('keeps startup off without changing OS items at launch (legacy flag=%s)', async legacy => {
    writeFileSync(join(f.directory, 'settings.json'), JSON.stringify({ preferences: { launchAtLogin: legacy, fontSize: 16 } }))
    originalDisk = readFileSync(join(f.directory, 'settings.json'), 'utf8')
    if (legacy) existingLogin()
    await boot(platform); ready()
    expect(snapshot().settings.launchAtLogin).toBe(false)
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
    expect(readFileSync(join(f.directory, 'settings.json'), 'utf8')).toBe(originalDisk)
  })
  it('does not touch login items for ordinary partial or full preference saves', async () => {
    existingLogin(); await boot(platform)
    save({ fontSize: 20 }); save({ opacity: .55 }); save({ ...snapshot().settings, showFurigana: false })
    expect(snapshot().settings).toMatchObject({ fontSize: 20, opacity: .55, showFurigana: false, launchAtLogin: false })
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
  })
  it('rejects new enable requests before changing native items, encryption or persisted preferences', async () => {
    await boot(platform)
    expect(() => save({ launchAtLogin: true, fontSize: 20, translationApiKey: 'synthetic-key' })).toThrow('不允许开机启动')
    expect(snapshot().settings).toMatchObject({ launchAtLogin: false, fontSize: 16 })
    expect(readFileSync(join(f.directory, 'settings.json'), 'utf8')).toBe(originalDisk)
    expect(f.encrypt).not.toHaveBeenCalled()
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(f.app.getLoginItemSettings).not.toHaveBeenCalled()
  })
  it('removes this app login item only on an explicit standalone disable request', async () => {
    existingLogin(); await boot(platform)
    expect(save({ launchAtLogin: false }).launchAtLogin).toBe(false)
    expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
    expect(f.app.getLoginItemSettings).toHaveBeenCalledTimes(2)
    expect(f.native.openAtLogin).toBe(false)
    if (platform === 'win32') expect(f.app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false, path: join(f.directory, 'LingoBar.exe'), args: [], name: 'com.lingobar.app' })
    save({ fontSize: 19 }); ready()
    expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
  })
  it('does not confuse an absent service or a path-filtered Windows result with a new registration', async () => {
    await boot(platform)
    if (platform === 'darwin') {
      save({ launchAtLogin: false }); save({ launchAtLogin: false })
      expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
    } else {
      expect(() => save({ launchAtLogin: false })).toThrow('旧路径')
      expect(() => save({ launchAtLogin: false })).toThrow('旧路径')
      expect(f.app.setLoginItemSettings).toHaveBeenCalledTimes(2)
    }
    expect(snapshot().settings.launchAtLogin).toBe(false)
  })
  it('reports silent removal failure without automatic retry, then permits an explicit retry', async () => {
    existingLogin(); await boot(platform); f.app.setLoginItemSettings.mockImplementation(() => {})
    expect(() => save({ launchAtLogin: false })).toThrow('登录项')
    expect(readFileSync(join(f.directory, 'settings.json'), 'utf8')).toBe(originalDisk)
    expect(snapshot().settings.launchAtLogin).toBe(false)
    save({ fontSize: 20 }); ready()
    expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
    f.app.setLoginItemSettings.mockImplementation(applyNative)
    save({ launchAtLogin: false })
    expect(f.app.setLoginItemSettings).toHaveBeenCalledTimes(2)
    expect(f.native.openAtLogin).toBe(false)
  })
  it.each(['setter', 'getter', 'incomplete'] as const)('reports unconfirmed %s removal without ever enabling or looping', async failure => {
    existingLogin(); await boot(platform)
    if (failure === 'setter') f.app.setLoginItemSettings.mockImplementation(() => { throw new Error('synthetic native failure') })
    else if (failure === 'getter') f.app.getLoginItemSettings.mockImplementation(() => { throw new Error('synthetic native failure') })
    else f.app.getLoginItemSettings.mockReturnValue({} as any)
    expect(() => save({ launchAtLogin: false })).toThrow('无法确认')
    expect(snapshot().settings.launchAtLogin).toBe(false)
    expect(readFileSync(join(f.directory, 'settings.json'), 'utf8')).toBe(originalDisk)
    save({ opacity: .8 }); ready()
    expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ openAtLogin: false }))
  })
  it('keeps an item removed if the subsequent local settings write fails; never restores startup', async () => {
    existingLogin(); await boot(platform); mkdirSync(join(f.directory, 'settings.json.tmp'))
    expect(() => save({ launchAtLogin: false })).toThrow(/关闭.*未能保存/)
    expect(f.native.openAtLogin).toBe(false)
    expect(snapshot().settings.launchAtLogin).toBe(false)
    expect(readFileSync(join(f.directory, 'settings.json'), 'utf8')).toBe(originalDisk)
    ready(); expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
  })
})
it('removes a macOS pending registration only when explicitly requested', async () => {
  existingLogin(true); await boot('darwin'); ready()
  expect(f.app.setLoginItemSettings).not.toHaveBeenCalled()
  save({ launchAtLogin: false })
  expect(f.native.status).toBe('not-registered')
  expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({ openAtLogin: false })
})
it('reports a still-pending macOS item rather than claiming successful removal', async () => {
  existingLogin(true); await boot('darwin'); f.app.setLoginItemSettings.mockImplementation(() => {})
  expect(() => save({ launchAtLogin: false })).toThrow('待批准')
  expect(f.native.status).toBe('requires-approval')
  expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
})
it('leaves other Windows startup names and machine-scope entries untouched', async () => {
  existingLogin(); f.native.launchItems.push({ name: 'synthetic-other', scope: 'machine', enabled: true })
  await boot('win32'); save({ launchAtLogin: false })
  expect(f.native.executableWillLaunchAtLogin).toBe(true)
  expect(f.native.launchItems).toEqual([{ name: 'synthetic-other', scope: 'machine', enabled: true }])
  expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce()
})
it('requests removal of a Windows old-path item and reports that filtered readback cannot prove complete cleanup', async () => {
  await boot('win32')
  let oldPathItem = true
  f.app.getLoginItemSettings.mockReturnValue({ ...f.native, openAtLogin: false, launchItems: [] })
  f.app.setLoginItemSettings.mockImplementation(input => { if (!input.openAtLogin) oldPathItem = false })
  expect(() => save({ launchAtLogin: false })).toThrow('无法确认旧路径残留')
  expect(oldPathItem).toBe(false)
  expect(snapshot().settings.launchAtLogin).toBe(false)
  expect(f.app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ openAtLogin: false, name: 'com.lingobar.app' }))
})
