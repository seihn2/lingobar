import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSession, type WebCapture, type WebSocketPort } from '../src/web/session'
import { parseWebConfig } from '../src/web/config'
import { alignedOriginal, untranslatedErrorSource } from '../src/renderer/caption-text'

class Socket extends EventTarget {
  readyState = 0
  bufferedAmount = 0
  sent: Array<string | ArrayBuffer> = []
  closed = 0
  send(value: string | ArrayBuffer) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(value) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })) }
  close() { this.closed++; this.readyState = 3; this.dispatchEvent(new Event('close')) }
  packet(type: string, extra = {}, sessionId = 'run-1') { this.message({ version: 1, type, sessionId, ...extra }) }
}
const sessions = new Set<BrowserSession>()
const caption = (original = 'Synthetic source', extra = {}) => ({ id: 'one', source: 'microphone', original, language: 'English', zh: '', en: '', ja: '', reading: '', translations: { zh: '合成译文', ja: '天気' }, jaSegments: [{ text: '天気', reading: 'てんき' }], status: 'ready', saved: false, createdAt: 1, ...extra })
function fixture(options: { capture?: WebCapture; backend?: '/api/session' | null; startupMs?: number } = {}) {
  const sockets: Socket[] = [], signals: AbortSignal[] = []
  let chunks!: (value: ArrayBuffer) => void
  const cleanup = vi.fn()
  const capture = vi.fn<WebCapture>(options.capture || (async (chunk, _error, signal) => { chunks = chunk; signals.push(signal); return cleanup }))
  const session = new BrowserSession({ backend: options.backend === undefined ? '/api/session' : options.backend, origin: 'https://lingobar.example', capture,
    startupMs: options.startupMs, id: () => `run-${sockets.length + 1}`, socket: url => { expect(url).toBe('wss://lingobar.example/api/session'); const s = new Socket(); sockets.push(s); return s as unknown as WebSocketPort } })
  sessions.add(session)
  const start = async () => { const pending = session.start(); const s = sockets.at(-1)!; s.open(); s.packet('ready', {}, `run-${sockets.length}`); await pending; return s }
  return { session, sockets, cleanup, capture, signals, start, chunk: (value: ArrayBuffer) => chunks(value) }
}
afterEach(() => { for (const session of sessions) session.dispose(); sessions.clear(); vi.useRealTimers() })
describe('browser session, synthetic transport and capture only', () => {
  it('retracts only current live unsaved captions and keeps tombstones against later updates', async () => {
    const f = fixture(), s = await f.start()
    s.packet('caption', { revision: 1, caption: caption('Synthetic live', { live: true }) })
    s.packet('retract', { id: 'one' }, 'old-run'); expect(f.session.snapshot().captions).toHaveLength(1)
    s.packet('retract', { id: 'one' }); expect(f.session.snapshot().captions).toHaveLength(0)
    s.packet('caption', { revision: 99, caption: caption('Late removed draft') }); expect(f.session.snapshot().captions).toHaveLength(0)
    s.packet('caption', { revision: 1, caption: caption('Synthetic saved final', { id: 'saved' }) }); f.session.toggleSaved('run-1:saved')
    s.packet('caption', { revision: 2, caption: caption('Synthetic saved live', { id: 'saved', live: true }) }); s.packet('retract', { id: 'saved' })
    s.packet('caption', { revision: 1, caption: caption('Synthetic final', { id: 'final' }) }); s.packet('retract', { id: 'final' })
    expect(f.session.snapshot().captions.map(caption => caption.id)).toEqual(['run-1:saved', 'run-1:final'])
  })
  it('blocks duplicate local retry before the relay replies', async () => {
    const f = fixture(), s = await f.start(); s.packet('caption', { revision: 1, caption: caption('Synthetic retry', { status: 'error' }) })
    f.session.retry('run-1:one'); expect(() => f.session.retry('run-1:one')).toThrow('尚未定稿')
    expect(s.sent.filter(value => typeof value === 'string' && JSON.parse(value).type === 'retry')).toHaveLength(1)
    expect(f.session.snapshot().captions[0].translationPending).toBe(true)
  })
  it('unconfigured start never opens a socket or requests media; public config has no provider-key fields', async () => {
    const f = fixture({ backend: null }); expect(f.session.snapshot().message).toBe('后端未配置')
    await expect(f.session.start()).rejects.toThrow('后端未配置'); expect(f.sockets).toHaveLength(0); expect(f.capture).not.toHaveBeenCalled()
    expect(parseWebConfig({ version: 1, backend: null })).toEqual({ backend: null })
    expect(parseWebConfig({ version: 1, backend: '/api/session' })).toEqual({ backend: '/api/session' })
    for (const bad of [{ version: 1, backend: 'https://elsewhere.example/ws' }, { version: 1, backend: '/api/session', apiKey: 'synthetic-rejected-field' }, { version: 2, backend: null }]) expect(() => parseWebConfig(bad)).toThrow()
    expect(() => new BrowserSession({ backend: null, origin: 'http://not-local.example' })).toThrow('HTTPS')
  })
  it('waits for matching server readiness, starts one microphone, and sends only bounded binary PCM', async () => {
    const f = fixture(); const pending = f.session.start(); const s = f.sockets[0]
    expect(f.capture).not.toHaveBeenCalled(); s.open()
    expect(JSON.parse(s.sent[0] as string)).toMatchObject({ type: 'start', version: 1, sessionId: 'run-1', settings: { targetLanguages: ['zh', 'ja'] } })
    expect(s.sent[0]).not.toMatch(/apiKey|Authorization|asrEndpoint/)
    s.packet('ready', {}, 'old-run'); expect(f.capture).not.toHaveBeenCalled()
    s.packet('ready'); s.packet('ready'); await pending; expect(f.capture).toHaveBeenCalledTimes(1)
    const pcm = new ArrayBuffer(3200); f.chunk(pcm); expect(s.sent.at(-1)).toBe(pcm)
    expect(f.session.snapshot().state).toBe('listening'); f.session.dispose(); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.signals[0].aborted).toBe(true)
  })
  it('publishes an immediate translated partial, aligns source/ruby, and rejects older revisions', async () => {
    const f = fixture(), s = await f.start()
    s.packet('caption', { revision: 1, caption: caption('A longer synthetic draft', { translatedOriginal: 'A prefix', live: true, translationPending: true }) })
    expect(f.session.snapshot().captions[0]).toMatchObject({ id: 'run-1:one', translatedOriginal: 'A prefix', live: true, translations: { zh: '合成译文' }, jaSegments: [{ text: '天気', reading: 'てんき' }] })
    s.packet('caption', { revision: 2, caption: caption('Synthetic final') }); s.packet('caption', { revision: 1, caption: caption('Old late draft') })
    expect(f.session.snapshot().captions).toHaveLength(1); expect(f.session.snapshot().captions[0].original).toBe('Synthetic final'); f.session.dispose()
  })
  it('stop cancels a pending permission grant and releases its late stream exactly once', async () => {
    let grant!: (stop: () => void) => void
    const f = fixture({ capture: (_chunk, _error, _signal) => new Promise(resolve => { grant = resolve }) })
    const pending = f.session.start(); const observed = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const s = f.sockets[0]; s.open(); s.packet('ready'); f.session.stop(); await observed
    const cleanup = vi.fn(); grant(cleanup); await Promise.resolve(); await Promise.resolve()
    expect(cleanup).toHaveBeenCalledOnce(); expect(f.session.snapshot().state).toBe('idle'); expect(s.closed).toBe(1)
  })
  it('new runs retain history under separate IDs and ignore callbacks from the closed socket', async () => {
    const f = fixture(), old = await f.start(); old.packet('caption', { revision: 1, caption: caption('First session') }); f.session.stop()
    const next = await f.start(); old.packet('caption', { revision: 99, caption: caption('Late polluted text') }); old.dispatchEvent(new Event('error'))
    next.packet('caption', { revision: 1, caption: caption('Second session') }, 'run-2')
    expect(f.session.snapshot().state).toBe('listening')
    expect(f.session.snapshot().captions.map(c => [c.id, c.original])).toEqual([['run-1:one', 'First session'], ['run-2:one', 'Second session']]); f.session.dispose()
  })
  it('permission failure, network close and invalid server packets terminate without reconnect', async () => {
    const denied = fixture({ capture: async () => { throw new Error('synthetic denial') } }); const pending = denied.session.start(); const rejection = expect(pending).rejects.toThrow('浏览器权限')
    denied.sockets[0].open(); denied.sockets[0].packet('ready'); await rejection; expect(denied.session.snapshot().state).toBe('error'); expect(denied.sockets).toHaveLength(1)
    for (const fail of [(s: Socket) => s.close(), (s: Socket) => s.message('{invalid')]) {
      const f = fixture(); const s = await f.start(); fail(s)
      expect(f.session.snapshot().state).toBe('error'); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.sockets).toHaveLength(1)
    }
  })
  it('caps socket buffering and rejects malformed PCM without continuing capture', async () => {
    for (const bytes of [1, 64_002, 3200]) {
      const f = fixture(); const s = await f.start(); if (bytes === 3200) s.bufferedAmount = 512_000
      f.chunk(new ArrayBuffer(bytes)); expect(f.session.snapshot().state).toBe('error'); expect(f.cleanup).toHaveBeenCalledOnce()
      const count = s.sent.length; f.chunk(new ArrayBuffer(3200)); expect(s.sent).toHaveLength(count)
    }
  })
  it('timeout and repeated start stop do not revive cancelled runs', async () => {
    vi.useFakeTimers(); const f = fixture({ startupMs: 100 }); const pending = f.session.start(); const rejection = expect(pending).rejects.toThrow('超时')
    await expect(f.session.start()).rejects.toThrow('先暂停'); await vi.advanceTimersByTimeAsync(101); await rejection
    f.sockets[0].open(); f.sockets[0].packet('ready'); expect(f.capture).not.toHaveBeenCalled(); expect(f.session.snapshot().state).toBe('error'); f.session.stop(); f.session.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('translation-setting changes cancel the owner; key/startup/desktop inputs are rejected', async () => {
    const f = fixture(), s = await f.start(); f.session.saveSettings({ targetLanguages: ['fr', 'ja'] })
    expect(f.session.snapshot().state).toBe('idle'); expect(f.cleanup).toHaveBeenCalledOnce()
    s.packet('caption', { revision: 1, caption: caption() }); expect(f.session.snapshot().captions).toHaveLength(0)
    for (const input of [{ launchAtLogin: true }, { launchAtLogin: false }, { asrApiKey: 'synthetic-rejected-field' }, { targetLanguages: [] }, { targetLanguages: ['ja', 'ja'] }, { captureMode: 'system' }]) expect(() => f.session.saveSettings(input as never)).toThrow()
    expect(f.session.snapshot().settings.launchAtLogin).toBe(false)
  })
  it('local saves survive translation revisions; pause preserves the latest readable draft', async () => {
    const f = fixture(), s = await f.start(); s.packet('caption', { revision: 1, caption: caption() }); f.session.toggleSaved('run-1:one')
    s.packet('caption', { revision: 2, caption: caption('Revised source', { live: true, translationPending: true }) })
    f.session.stop(); expect(f.session.snapshot().captions[0]).toMatchObject({ saved: true, live: false, translationPending: false, status: 'ready', original: 'Revised source' })
    expect(() => f.session.retry('run-1:one')).toThrow('先连接')
  })
  it('bounded history retains favorites and an evicted caption cannot return through a late revision', async () => {
    const f = fixture(), s = await f.start()
    s.packet('caption', { revision: 1, caption: caption() }); f.session.toggleSaved('run-1:one')
    for (let i = 0; i < 501; i++) s.packet('caption', { revision: 1, caption: caption('Synthetic bounded history', { id: `row-${i}` }) })
    expect(f.session.snapshot().captions).toHaveLength(500)
    expect(f.session.snapshot().captions[0]).toMatchObject({ id: 'run-1:one', saved: true })
    expect(f.session.snapshot().captions.some(c => c.id === 'run-1:row-0')).toBe(false)
    s.packet('caption', { revision: 99, caption: caption('Late evicted synthetic text', { id: 'row-0' }) })
    expect(f.session.snapshot().captions.some(c => c.id === 'run-1:row-0')).toBe(false)
    s.packet('caption', { revision: 2, caption: caption('Saved retry failed', { status: 'error' }) })
    f.session.toggleSaved('run-1:one'); expect(f.session.snapshot().captions[0].saved).toBe(false)
  })
  it('quota/auth/provider failures use fixed feedback, retain history and never reconnect', async () => {
    for (const code of ['unauthorized', 'quota', 'upstream', 'protocol', 'unavailable']) {
      const f = fixture(), s = await f.start(); s.packet('caption', { revision: 1, caption: caption() })
      s.packet('error', { code, apiKey: 'synthetic-discarded-field', message: 'synthetic raw provider text' })
      expect(f.session.snapshot()).toMatchObject({ state: 'error', captions: [expect.objectContaining({ original: 'Synthetic source' })] })
      expect(JSON.stringify(f.session.snapshot())).not.toMatch(/synthetic-discarded|raw provider/); expect(f.sockets).toHaveLength(1)
    }
  })
  it('paused prefixes retain the untranslatable last source, without claiming a complete savable sentence', async () => {
    const f = fixture(), s = await f.start()
    s.packet('caption', { revision: 1, caption: caption('Synthetic prefix plus last heard tail', { translatedOriginal: 'Synthetic prefix', live: true, translationPending: true, status: 'translating', furiganaStatus: 'pending' }) })
    f.session.stop(); const stopped = f.session.snapshot().captions[0]
    expect(stopped).toMatchObject({ status: 'error', live: false, translationPending: false, furiganaStatus: 'error' })
    expect(alignedOriginal(stopped)).toBe('Synthetic prefix')
    expect(untranslatedErrorSource(stopped)).toEqual({ label: '未译原文', text: 'plus last heard tail' })
    expect(() => f.session.toggleSaved(stopped.id)).toThrow('翻译完成')
  })
  it('empty translation placeholders do not become ready on pause; completed text terminates only pending ruby', async () => {
    const f = fixture(), s = await f.start()
    s.packet('caption', { revision: 1, caption: caption('Raw only', { translations: { zh: '' }, ja: '', jaSegments: undefined, live: true, status: 'translating' }) })
    s.packet('caption', { revision: 1, caption: caption('Final translated source', { id: 'final', furiganaStatus: 'pending' }) })
    f.session.stop(); const stopped = f.session.snapshot().captions
    expect(stopped[0].status).toBe('error'); expect(() => f.session.toggleSaved(stopped[0].id)).toThrow('翻译完成')
    expect(stopped[1]).toMatchObject({ status: 'ready', furiganaStatus: 'error' })
  })
})
