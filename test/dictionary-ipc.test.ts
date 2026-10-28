import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learningTarget } from '../src/shared/learning'
import { dictionarySourceVersion } from '../src/shared/dictionary'
import type { Caption } from '../src/shared/types'
const f = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const frame = { url: 'http://127.0.0.1:5173/' }
  const contents = { id: 9, mainFrame: frame, on: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn() }
  const window = { webContents: contents, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, on: vi.fn(), once: vi.fn(), show: vi.fn(), focus: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn() }
  const settings = { targetLanguages: ['zh', 'ja'], captureMode: 'system', microphoneDeviceId: 'default', showOriginal: true, showFurigana: true, launchAtLogin: false, fontSize: 16, opacity: .94, alwaysOnTop: false, hasAsrKey: false, hasTranslationKey: true, translationModel: 'synthetic-model', translationBaseUrl: 'https://fixture.invalid/private-endpoint', asrModel: 'synthetic', asrEndpoint: 'wss://fixture.invalid/asr' }
  const queue = { captions: [] as Caption[], close: vi.fn(), cancelAnnotationRetries: vi.fn(), finishPartials: vi.fn() }
  const storage = { settings: () => ({ ...settings }), key: vi.fn(() => 'synthetic-test-key'), saved: () => [], saveCaptions: vi.fn() }
  const audio = { stop: vi.fn(), start: vi.fn(() => { throw new Error('no audio permitted') }) }
  const app = { setName: vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(), getPath: () => f.directory, getAppPath: () => '/synthetic-app', isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on: vi.fn(), quit: vi.fn() }
  return { handlers, frame, contents, window, settings, queue, storage, audio, app, directory: '', provider: vi.fn(), renameCount: 0, failRename: 0, dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() } }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => { f.renameCount++; if (f.renameCount === f.failRename) throw new Error('synthetic disk failure'); return actual.renameSync(...args) } }
})
vi.mock('electron', () => ({
  app: f.app, BrowserWindow: vi.fn(function () { return f.window }),
  Tray: vi.fn(function () { return { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() } }),
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (value: unknown) => value },
  nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }), createFromPath: () => ({}) },
  globalShortcut: { register: () => true, unregisterAll: vi.fn() }, clipboard: {}, dialog: f.dialog,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 860, height: 560 } }) },
  session: { defaultSession: { setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() } },
  ipcMain: { handle: (channel: string, callback: (...args: any[]) => any) => f.handlers.set(channel, callback), on: vi.fn() }
}))
vi.mock('../src/main/storage', () => ({ Storage: vi.fn(function () { return f.storage }) }))
vi.mock('../src/main/captions', () => ({ CaptionQueue: vi.fn(function () { return f.queue }) }))
vi.mock('../src/main/audio', () => ({ AudioEngine: vi.fn(function () { return f.audio }) }))
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))
vi.mock('../src/main/dictionary-provider', () => ({ explainDictionary: f.provider }))
const trusted = () => ({ sender: f.contents, senderFrame: f.frame })
const invoke = (name: string, ...args: unknown[]) => f.handlers.get(`lingo:dictionary-${name}`)!(trusted(), ...args)
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
const caption = (): Caption => ({ id: 'synthetic-caption', original: 'pick it up', language: 'English', source: 'system', zh: '拿起来', ja: '拾って', en: '', reading: '', createdAt: 1, status: 'ready', saved: false, translations: { zh: '拿起来', ja: '拾って' } })
const open = () => { const c = f.queue.captions[0]; return invoke('open', { captionId: c.id, displayedText: c.original, sourceVersion: dictionarySourceVersion(c), displayedVersion: learningTarget(c, f.settings as any).version }) }
const query = (handle: string) => ({ handle, span: { start: 0, end: 10, exact: 'pick it up' }, language: 'zh' })
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); f.handlers.clear(); f.renameCount = 0; f.failRename = 0
  f.directory = mkdtempSync(join(tmpdir(), 'dictionary-ipc-')); f.queue.captions = [caption()]
  writeFileSync(join(f.directory, 'saved.json'), '[]'); writeFileSync(join(f.directory, 'learning-v1.json'), '{"schema":1,"sessions":[],"records":[]}')
  f.provider.mockReset().mockResolvedValue({ content: { schemaVersion: 1, status: 'ok', reasonCode: null, targetText: 'pick it up', headword: 'pick up', reading: null, partOfSpeech: '动词短语', contextMeaning: '拿起来', usageNote: null, examples: null }, finishReason: 'stop', usage: null, validationWarnings: [], promptVersion: 'dictionary-v1' })
  f.dialog.showMessageBox.mockResolvedValue({ response: 0 }); f.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('real network is forbidden') })); vi.stubGlobal('WebSocket', class { constructor() { throw new Error('real sockets are forbidden') } })
  vi.stubEnv('ELECTRON_RENDERER_URL', f.frame.url)
  await import('../src/main/index'); await settle()
})
afterEach(() => {
  f.app.on.mock.calls.find(call => call[0] === 'before-quit')?.[1]?.({ preventDefault() {} })
  rmSync(f.directory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
describe('actual installed dictionary IPC and lifecycle', () => {
  it('trust-gates all narrow channels before data/credentials/provider access', () => {
    const channels = [...f.handlers.keys()].filter(name => name.startsWith('lingo:dictionary-'))
    expect(channels.length).toBeGreaterThan(15)
    for (const name of channels) for (const event of [{ sender: {}, senderFrame: f.frame }, { sender: f.contents, senderFrame: { ...f.frame } }]) expect(() => f.handlers.get(name)!(event, {})).toThrow('无法访问')
    expect(f.provider).not.toHaveBeenCalled(); expect(f.storage.key).not.toHaveBeenCalled()
    expect(readdirSync(f.directory).sort()).toEqual(['learning-v1.json', 'saved.json'])
  })
  it('does not expose provider address/key or library in ASR snapshots and emits only an invalidation signal', async () => {
    expect(JSON.stringify(invoke('availability'))).not.toMatch(/fixture\.invalid|synthetic-test-key/)
    expect(f.storage.key).not.toHaveBeenCalled()
    const handle = open().handle, run = invoke('explain', query(handle)); await settle()
    expect(run.state).toBe('waiting'); expect(f.provider).toHaveBeenCalledOnce()
    const detail = invoke('get', run.encounterId)
    expect(detail.run.state).toBe('ready')
    expect(JSON.stringify(detail)).not.toMatch(/fixture\.invalid|synthetic-test-key/)
    expect(f.handlers.get('lingo:snapshot')!(trusted())).not.toHaveProperty('dictionary')
    for (const call of f.contents.send.mock.calls.filter(call => call[0] === 'lingo:dictionary-changed')) expect(call).toHaveLength(1)
    expect(f.window.show).not.toHaveBeenCalled(); expect(f.window.focus).not.toHaveBeenCalled(); expect(f.audio.start).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(join(f.directory, 'saved.json'), 'utf8')).toBe('[]')
    expect(readFileSync(join(f.directory, 'learning-v1.json'), 'utf8')).toBe('{"schema":1,"sessions":[],"records":[]}')
  })
  it('releases source handles on main-frame reload without cancelling an already dispatched encounter', async () => {
    let complete!: (value: unknown) => void
    f.provider.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const handle = open().handle, run = invoke('explain', query(handle))
    const navigation = f.contents.on.mock.calls.find(call => call[0] === 'did-start-navigation')![1]
    navigation({}, f.frame.url, false, true)
    expect(() => invoke('explain', query(handle))).toThrow(/在途|快照/)
    complete({ content: { schemaVersion: 1, status: 'ok', reasonCode: null, targetText: 'pick it up', headword: null, reading: null, partOfSpeech: null, contextMeaning: '拿起来', usageNote: null, examples: null }, finishReason: 'stop', usage: null, validationWarnings: [], promptVersion: 'dictionary-v1' }); await settle()
    expect(invoke('get', run.encounterId).run.state).toBe('ready')
    expect(() => invoke('explain', query(handle))).toThrow('快照')
    expect(f.provider).toHaveBeenCalledOnce()
  })
  it('guards normal quit with ReadyUnsaved and permits a save-only recovery without another service call', async () => {
    f.failRename = 3
    const run = invoke('explain', query(open().handle)); await settle()
    expect(invoke('get', run.encounterId).run.state).toBe('ready_unsaved')
    const quitting = f.app.on.mock.calls.find(call => call[0] === 'before-quit')![1], event = { preventDefault: vi.fn() }
    quitting(event); await settle()
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(f.dialog.showMessageBox).toHaveBeenCalledOnce(); expect(f.app.quit).not.toHaveBeenCalled()
    expect(invoke('retry-save', run.encounterId, run.attemptId).state).toBe('ready')
    expect(f.provider).toHaveBeenCalledOnce()
    const clean = { preventDefault: vi.fn() }; quitting(clean)
    expect(clean.preventDefault).not.toHaveBeenCalled(); expect(f.audio.stop).toHaveBeenCalled()
  })
})
