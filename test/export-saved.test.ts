import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caption } from '../src/shared/types'

// Real installed export handler, CaptionQueue and Storage; only desktop APIs,
// audio and the retry translator are synthetic. All files live in a new temp dir.
const f = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const frame = { url: 'http://127.0.0.1:5173/' }
  const contents = { mainFrame: frame, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
  const window = { webContents: contents, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(), loadURL: vi.fn(), show: vi.fn(), focus: vi.fn() }
  const dialog = { showSaveDialog: vi.fn() }
  const app = { setName: vi.fn(), setPath: vi.fn(), setAppUserModelId: vi.fn(), getPath: () => f.directory, isPackaged: false,
    requestSingleInstanceLock: () => true, on: vi.fn(), whenReady: () => Promise.resolve(), getAppPath: () => '/synthetic-app' }
  return { directory: '', handlers, frame, contents, window, dialog, app, queue: null as any, translate: vi.fn() }
})
vi.mock('electron', () => ({
  app: f.app, BrowserWindow: vi.fn(function () { return f.window }),
  Tray: vi.fn(function () { return { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() } }),
  nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }), createFromPath: () => ({}) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (value: unknown) => value },
  globalShortcut: { register: vi.fn(() => true), unregisterAll: vi.fn() }, clipboard: {}, dialog: f.dialog,
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => f.handlers.set(channel, handler), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => { throw new Error('Export must not access credentials') } },
}))
vi.mock('../src/main/audio', () => ({ AudioEngine: vi.fn(function () { return { stop: vi.fn() } }) }))
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))
vi.mock('../src/main/translation', async importOriginal => ({ ...await importOriginal<object>(), translateCaption: f.translate }))
vi.mock('../src/main/captions', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/captions')>()
  return { CaptionQueue: vi.fn(function (...args: ConstructorParameters<typeof actual.CaptionQueue>) {
    f.queue = new actual.CaptionQueue(...args); return f.queue
  }) }
})

const saved: Caption = { id: 'synthetic-saved', original: 'Synthetic original 你好 👩‍💻', source: 'text', language: '混合语言',
  translations: { fr: 'Texte synthétique', ja: '学校', en: 'Synthetic translation' }, targetLanguages: ['fr', 'ja', 'en'],
  zh: '', en: 'Synthetic translation', ja: '学校', reading: 'がっこう', jaSegments: [{ text: '学校', reading: 'がっこう' }],
  createdAt: 0, status: 'ready', saved: true }
const invoke = () => f.handlers.get('lingo:export')!({ sender: f.contents, senderFrame: f.frame })
const settle = () => new Promise<void>(resolve => setImmediate(resolve))
let originalDisk: string

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); f.handlers.clear()
  f.directory = mkdtempSync(join(tmpdir(), 'lingobar-export-'))
  writeFileSync(join(f.directory, 'saved.json'), JSON.stringify([saved]))
  originalDisk = readFileSync(join(f.directory, 'saved.json'), 'utf8')
  f.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(f.directory, 'notes.md') })
  f.translate.mockReset()
  vi.stubEnv('ELECTRON_RENDERER_URL', f.frame.url)
  await import('../src/main/index'); await settle()
})
afterEach(() => {
  const quit = f.app.on.mock.calls.find(call => call[0] === 'before-quit')?.[1] as (() => void) | undefined
  quit?.(); rmSync(f.directory, { recursive: true, force: true }); vi.unstubAllEnvs()
})

describe('saved-caption export through installed main IPC', () => {
  it('cancels without touching a destination, collection or persisted notes', async () => {
    const destination = join(f.directory, 'existing-synthetic.md')
    writeFileSync(destination, 'Synthetic file must remain unchanged')
    const before = structuredClone(f.queue.captions), names = readdirSync(f.directory)
    f.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: destination })
    await expect(invoke()).resolves.toBe(false)
    expect(readFileSync(destination, 'utf8')).toBe('Synthetic file must remain unchanged')
    expect(readdirSync(f.directory)).toEqual(names)
    expect(f.queue.captions).toEqual(before)
    expect(readFileSync(join(f.directory, 'saved.json'), 'utf8')).toBe(originalDisk)
    expect(f.translate).not.toHaveBeenCalled()
  })

  it('reports a real write failure without changing the collection, and permits a later successful export', async () => {
    const destination = join(f.directory, 'directory-not-a-file'); mkdirSync(destination)
    const before = structuredClone(f.queue.captions)
    f.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    await expect(invoke()).rejects.toBeInstanceOf(Error)
    expect(f.queue.captions).toEqual(before)
    expect(readFileSync(join(f.directory, 'saved.json'), 'utf8')).toBe(originalDisk)
    expect(readdirSync(destination)).toEqual([])
    f.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(f.directory, 'notes.md') })
    await expect(invoke()).resolves.toBe(true)
    const content = readFileSync(join(f.directory, 'notes.md'), 'utf8')
    for (const value of [saved.original, 'Français：Texte synthétique', '日本語：学校', 'English：Synthetic translation', '日语读音：がっこう']) expect(content).toContain(value)
    expect(f.translate).not.toHaveBeenCalled()
  })

  it.each(['pending', 'failed'])('exports the retained translation while its saved-caption retry is %s', async status => {
    let reject!: (reason: Error) => void
    f.translate.mockImplementation(() => new Promise((_resolve, no) => { reject = no }))
    f.queue.retry(saved.id); await settle()
    if (status === 'failed') { reject(new Error('Synthetic retry failure')); await settle() }
    expect(f.queue.captions[0]).toMatchObject({ saved: true, status: status === 'failed' ? 'error' : 'translating', translations: saved.translations })
    await expect(invoke()).resolves.toBe(true)
    const content = readFileSync(join(f.directory, 'notes.md'), 'utf8')
    expect(content).toContain(saved.original)
    expect(content).toContain('Français：Texte synthétique')
    expect(content).not.toContain('Synthetic retry failure')
    expect(f.queue.captions[0].status).toBe(status === 'failed' ? 'error' : 'translating')
    expect(readFileSync(join(f.directory, 'saved.json'), 'utf8')).toBe(originalDisk)
    if (status === 'pending') { reject(new Error('Synthetic cleanup')); await settle() }
  })
})
