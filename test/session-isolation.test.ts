import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../src/shared/types'

// Keep the real installed main handlers, AudioEngine, Qwen session, CaptionQueue
// and translation transport. Only OS/media/storage/network boundaries are fake.
const f = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const listeners = new Map<string, (...args: any[]) => any>()
  const frame = { url: 'http://127.0.0.1:5173/' }
  const webContents = { mainFrame: frame, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() }
  const window = { webContents, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), setVisibleOnAllWorkspaces: vi.fn(),
    loadURL: vi.fn(), loadFile: vi.fn(), setAlwaysOnTop: vi.fn(), show: vi.fn(), focus: vi.fn() }
  const preferences = { captureMode: 'both', microphoneDeviceId: 'fixture-a', targetLanguages: ['en'],
    showOriginal: true, showFurigana: false, alwaysOnTop: true, opacity: .94, fontSize: 16, launchAtLogin: false,
    asrEndpoint: 'wss://fixture.invalid', asrModel: '', translationBaseUrl: 'https://fixture.invalid', translationModel: 'fixture',
    hasAsrKey: true, hasTranslationKey: true }
  const storage = { settings: () => ({ ...preferences, targetLanguages: [...preferences.targetLanguages] }), saved: () => [],
    key: () => 'synthetic-only-key', save: vi.fn((input: object) => { Object.assign(preferences, input); return { ...preferences } }), saveCaptions: vi.fn() }
  const capture = { start: vi.fn(async (_id: string, callbacks: any) => { nativeCallbacks.push(callbacks) }), activate: vi.fn(() => true), stop: vi.fn() }
  const nativeCallbacks: any[] = []
  const sockets: any[] = []
  const app = { setName: vi.fn(), setPath: vi.fn(), setAppUserModelId: vi.fn(), getPath: () => '/synthetic/lingobar', isPackaged: false,
    requestSingleInstanceLock: () => true, on: vi.fn(), quit: vi.fn(), whenReady: () => Promise.resolve(), getAppPath: () => '/synthetic-app' }
  return { handlers, listeners, frame, webContents, window, storage, capture, nativeCallbacks, sockets, app, preferences }
})

vi.mock('electron', () => ({
  app: f.app, BrowserWindow: vi.fn(function () { return f.window }),
  Tray: vi.fn(function () { return { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() } }),
  nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }), createFromPath: () => ({}) },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: (value: unknown) => value },
  globalShortcut: { register: vi.fn(() => true), unregisterAll: vi.fn() }, clipboard: {}, dialog: {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => f.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: any[]) => any) => f.listeners.set(channel, listener) }
}))
vi.mock('../src/main/storage', () => ({ Storage: vi.fn(function () { return f.storage }) }))
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))
vi.mock('../src/main/audio/native-capture', () => ({ NativeSystemAudioCapture: vi.fn(function () { return f.capture }) }))
vi.mock('../src/main/audio/qwen', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/audio/qwen')>()
  return { ...actual, QwenAsrSession: vi.fn(function (callbacks: ConstructorParameters<typeof actual.QwenAsrSession>[0]) {
    return new actual.QwenAsrSession(callbacks, { createSocket: () => {
      const socket = new Socket(); f.sockets.push(socket); return socket as unknown as WebSocket
    }, startupTimeoutMs: 1000 })
  }) }
})

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0
  sent: any[] = []
  terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED })
  send(value: string | Buffer, callback?: (error?: Error) => void) {
    this.sent.push(Buffer.isBuffer(value) ? Buffer.from(value) : JSON.parse(value)); callback?.()
  }
  open() { this.readyState = WebSocket.OPEN; this.emit('open') }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))) }
}
interface Request { source: string; signal: AbortSignal; resolve(response: Response): void; reject(error: Error): void }
let requests: Request[]
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve() }
const trusted = () => ({ sender: f.webContents, senderFrame: f.frame })
const invoke = (channel: string, ...args: unknown[]) => f.handlers.get(channel)!(trusted(), ...args)
const snapshot = (): Snapshot => structuredClone(invoke('lingo:snapshot'))
const complete = (request: Request, text: string) => request.resolve(new Response(JSON.stringify({ choices: [{
  finish_reason: 'stop', message: { content: JSON.stringify({ language: '英语', translations: { en: text } }) }
}] })))
function microphoneReady() {
  const run = f.webContents.send.mock.calls.filter(call => call[0] === 'lingo:microphone' && call[1] === true).at(-1)![2]
  f.listeners.get('lingo:microphone-ready')!(trusted(), run)
  return run
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  f.handlers.clear(); f.listeners.clear(); f.sockets.length = 0; f.nativeCallbacks.length = 0
  Object.assign(f.preferences, { captureMode: 'both', microphoneDeviceId: 'fixture-a', targetLanguages: ['en'] })
  requests = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(0)
  vi.stubEnv('ELECTRON_RENDERER_URL', f.frame.url)
  // Deliberately ignores abort: late success/failure must still be rejected by
  // the real transport/queue guards, even with an uncooperative adapter.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
    const body = JSON.parse(init!.body as string)
    requests.push({ source: JSON.parse(body.messages[1].content).source_text, signal: init!.signal as AbortSignal, resolve, reject })
  })))
  await import('../src/main/index'); await settle()
})
afterEach(async () => {
  const quit = f.app.on.mock.calls.find(call => call[0] === 'before-quit')?.[1] as (() => void) | undefined
  quit?.()
  for (const request of requests) request.reject(new Error('synthetic cleanup'))
  await settle()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers()
})

describe.each(['streaming', 'realtime'] as const)('installed %s session isolation', protocol => {
  const event = (socket: Socket, kind: string, text = '', final = false) => protocol === 'streaming'
    ? { header: { event: kind, task_id: socket.sent[0].header.task_id }, payload: { output: { sentence: { sentence_id: 1, text, sentence_end: final } } } }
    : { type: kind, item_id: '1', ...(final ? { transcript: text } : { text }) }
  const transcript = (socket: Socket, text: string, final = false) => socket.message(event(socket,
    protocol === 'streaming' ? 'result-generated' : final ? 'conversation.item.input_audio_transcription.completed' : 'conversation.item.input_audio_transcription.text', text, final))
  const lateEvents = (socket: Socket) => {
    transcript(socket, 'STALE partial'); transcript(socket, 'STALE final', true)
    socket.emit('error', new Error('STALE socket failure')); socket.emit('close')
  }
  async function start() {
    f.preferences.asrModel = protocol === 'streaming' ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'
    const from = f.sockets.length
    const starting = invoke('lingo:start')
    const sockets = f.sockets.slice(from) as Socket[]
    for (const socket of sockets) { socket.open(); socket.message(event(socket, protocol === 'streaming' ? 'task-started' : 'session.updated')) }
    await starting
    microphoneReady()
    expect(snapshot().state).toBe('listening')
    return sockets
  }

  it.each(['success', 'failure'] as const)('keeps old history work separate through source switch, hard cancellation and late %s', async outcome => {
    const [oldSystem, oldMicrophone] = await start()
    const oldRun = microphoneReady()
    transcript(oldSystem, 'Synthetic system final', true)
    transcript(oldMicrophone, 'Synthetic microphone prefix')
    await vi.advanceTimersByTimeAsync(650)
    expect(requests.map(request => request.source)).toEqual(['Synthetic system final', 'Synthetic microphone prefix'])
    const oldIds = snapshot().captions.map(caption => caption.id)

    invoke('lingo:settings', { captureMode: 'microphone', microphoneDeviceId: 'fixture-b' })
    expect(snapshot().state).toBe('idle')
    expect(requests.every(request => !request.signal.aborted)).toBe(true) // Retained history is allowed to finish.
    const [current] = await start()
    transcript(current, 'Synthetic current phrase') // Provider ID is reused across sessions.
    const currentId = snapshot().captions.at(-1)!.id
    expect(oldIds).not.toContain(currentId)
    const beforeLate = snapshot()
    lateEvents(oldSystem); lateEvents(oldMicrophone)
    f.nativeCallbacks[0].onError('device-unavailable')
    f.listeners.get('lingo:microphone-failed')!(trusted(), 'STALE permission failure', oldRun)
    expect(snapshot()).toEqual(beforeLate)

    // Complete one legitimate old translation after the new caption exists.
    complete(requests[0], 'Synthetic old history translation'); await settle()
    expect(snapshot().captions[0]).toMatchObject({ id: oldIds[0], original: 'Synthetic system final', en: 'Synthetic old history translation' })
    expect(snapshot().captions.at(-1)).toMatchObject({ id: currentId, original: 'Synthetic current phrase', en: '' })

    // A real current-source error hard-cancels capture and finalizes its known
    // partial. Older service callbacks must not clear/replace that error.
    current.emit('error', new Error('synthetic current transport failure'))
    const failed = snapshot()
    expect(failed.state).toBe('error')
    lateEvents(current); lateEvents(oldSystem)
    expect(snapshot()).toEqual(failed)
    await settle()
    expect(requests).toHaveLength(3)
    if (outcome === 'success') complete(requests[1], 'Synthetic other old translation')
    else requests[1].reject(new Error('Synthetic old translation failure'))
    complete(requests[2], 'Synthetic current translation'); await settle()
    expect(snapshot()).toMatchObject({ state: 'error', message: failed.message, partial: {} })
    expect(snapshot().captions[1]).toMatchObject({ id: oldIds[1], original: 'Synthetic microphone prefix', live: false,
      status: outcome === 'success' ? 'ready' : 'error' })
    expect(snapshot().captions[2]).toMatchObject({ id: currentId, original: 'Synthetic current phrase', en: 'Synthetic current translation', status: 'ready', live: false })
    expect(JSON.stringify(snapshot())).not.toContain('STALE')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates late audio and historical translation after the installed pause IPC settles and listening restarts', async () => {
    f.preferences.captureMode = 'microphone'
    const [old] = await start()
    const oldRun = microphoneReady()
    transcript(old, 'Synthetic paused original')
    await vi.advanceTimersByTimeAsync(650)
    const oldId = snapshot().captions[0].id
    const paused = invoke('lingo:stop')
    // PR3 hard-stops immediately; a temporary PR4 combination drains for at
    // most 2 seconds. Test post-settlement isolation without conflating them.
    await vi.advanceTimersByTimeAsync(2000); await paused
    expect(snapshot()).toMatchObject({ state: 'idle', partial: {} })
    expect(snapshot().captions[0]).toMatchObject({ id: oldId, live: false, original: 'Synthetic paused original' })
    const [current] = await start()
    transcript(current, 'Synthetic resumed final', true); await settle()
    const resumed = snapshot()
    lateEvents(old)
    f.listeners.get('lingo:microphone-failed')!(trusted(), 'STALE permission failure', oldRun)
    expect(snapshot()).toEqual(resumed)
    complete(requests[0], 'Synthetic paused translation')
    complete(requests[1], 'Synthetic resumed translation'); await settle()
    expect(snapshot().captions[0]).toMatchObject({ id: oldId, original: 'Synthetic paused original', en: 'Synthetic paused translation', status: 'ready' })
    expect(snapshot().captions[1]).toMatchObject({ original: 'Synthetic resumed final', en: 'Synthetic resumed translation', status: 'ready' })
    expect(snapshot().state).toBe('listening')
    expect(JSON.stringify(snapshot())).not.toContain('STALE')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a timed-out startup and its late acknowledgement after a new start', async () => {
    f.preferences.asrModel = protocol === 'streaming' ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'
    const timedOut = expect(invoke('lingo:start')).rejects.toThrow('超时')
    const old = [...f.sockets] as Socket[]
    for (const socket of old) socket.open()
    await vi.advanceTimersByTimeAsync(1000); await timedOut
    expect(snapshot().state).toBe('error')
    invoke('lingo:settings', { captureMode: 'microphone' })
    const [current] = await start()
    const fresh = snapshot()
    for (const socket of old) {
      socket.open(); socket.message(event(socket, protocol === 'streaming' ? 'task-started' : 'session.updated')); lateEvents(socket)
    }
    expect(snapshot()).toEqual(fresh)
    transcript(current, 'Synthetic fresh final', true); await settle()
    complete(requests[0], 'Synthetic fresh translation'); await settle()
    expect(snapshot().captions).toHaveLength(1)
    expect(snapshot().captions[0]).toMatchObject({ original: 'Synthetic fresh final', en: 'Synthetic fresh translation', status: 'ready' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)('keeps a timed-out translation and its late %s out of the new session, then retries its original', async outcome => {
    const [oldSystem] = await start()
    transcript(oldSystem, 'Synthetic timeout original', true); await settle()
    const oldId = snapshot().captions[0].id
    await vi.advanceTimersByTimeAsync(25_000)
    expect(requests[0].signal.aborted).toBe(true)

    invoke('lingo:settings', { captureMode: 'microphone' })
    const [current] = await start()
    transcript(current, 'Synthetic new final', true); await settle()
    const currentId = snapshot().captions[1].id
    complete(requests[1], 'Synthetic new translation'); await settle()
    const freshCaption = snapshot().captions[1]
    if (outcome === 'success') complete(requests[0], 'STALE timed-out translation')
    else requests[0].reject(new Error('STALE timed-out transport failure'))
    await settle()
    expect(snapshot().state).toBe('listening')
    expect(snapshot().captions[1]).toEqual(freshCaption)
    expect(snapshot().captions[0]).toMatchObject({ id: oldId, original: 'Synthetic timeout original', status: 'error',
      error: '翻译等待超过 25 秒，请检查网络或稍后重试', translationPending: false, en: '' })

    invoke('lingo:retry', oldId); await settle()
    expect(requests[2].source).toBe('Synthetic timeout original')
    complete(requests[2], 'Synthetic retried translation'); await settle()
    expect(snapshot().captions[0]).toMatchObject({ id: oldId, status: 'ready', en: 'Synthetic retried translation' })
    expect(snapshot().captions[0].error).toBeUndefined()
    expect(snapshot().captions[1]).toMatchObject({ id: currentId, original: 'Synthetic new final', en: 'Synthetic new translation' })
    expect(JSON.stringify(snapshot())).not.toContain('STALE')
    expect(vi.getTimerCount()).toBe(0)
  })
})
