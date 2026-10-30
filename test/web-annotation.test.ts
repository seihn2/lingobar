import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSession, type WebCapture, type WebSocketPort } from '../src/web/session'
import { requestAnnotation } from '../src/web/annotation-client'
import { ANNOTATION_TIMEOUT_MS, MAX_ANNOTATION_BYTES, type AnnotationRequest, type AnnotationResponse } from '../src/shared/annotation-protocol'
import { MAX_WEB_CAPTIONS } from '../src/shared/web-protocol'
import type { Caption } from '../src/shared/types'

vi.mock('electron', () => { throw new Error('Browser annotation must not load Electron') })
vi.mock('ws', () => { throw new Error('Browser annotation must not load provider sockets') })
const settle = async () => { for (let index = 0; index < 60; index++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class Socket extends EventTarget {
  readyState = 0
  bufferedAmount = 0
  sent: Array<string | ArrayBuffer> = []
  constructor(readonly sessionId: string) { super() }
  send(value: string | ArrayBuffer) { if (this.readyState !== 1) throw new Error('Synthetic closed socket'); this.sent.push(value) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  packet(type: string, extra = {}) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ version: 1, type, sessionId: this.sessionId, ...extra }) })) }
}
const row = (id = 'one', original = 'Synthetic finalized source'): Caption => ({ id, original, translatedOriginal: original,
  source: 'microphone', language: '英语', translations: { ja: '天気', en: 'Synthetic historical translation' }, targetLanguages: ['ja', 'en'],
  zh: '', en: 'Synthetic historical translation', ja: '天気', reading: '', status: 'ready', saved: false, createdAt: 1, furiganaStatus: 'error' })
const sample: AnnotationRequest = { version: 1, type: 'annotation', requestId: 'synthetic-request', sessionId: 'synthetic-text-session', captionId: 'run-1:one', sourceRevision: 3, language: 'ja', original: 'Synthetic finalized source', japanese: '天気' }
function annotated(input: AnnotationRequest): AnnotationResponse {
  const { original: _original, japanese: _japanese, ...identity } = input
  return { ...identity, reading: 'てんき', jaSegments: [{ text: '天気', reading: 'てんき' }] }
}
const response = (input: AnnotationRequest) => new Response(JSON.stringify(annotated(input)), { headers: { 'Content-Type': 'application/json' } })
function stable(value: Caption) { const { reading: _reading, jaSegments: _segments, furiganaStatus: _state, ...rest } = value; return rest }
type HttpJob = ReturnType<typeof deferred<Response>> & { input: AnnotationRequest; signal: AbortSignal }
const fixtures: Array<{ session: BrowserSession; jobs: HttpJob[] }> = []
function fixture(backend: '/api/session' | null = '/api/session', endpoint = '/api/audio-annotation') {
  const sockets: Socket[] = [], jobs: HttpJob[] = [], cleanup = vi.fn()
  const capture = vi.fn<WebCapture>(async () => cleanup)
  const annotationFetch = vi.fn<typeof fetch>((url, init) => {
    expect(String(url)).toBe('https://lingobar.example' + endpoint)
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' } })
    const job = { ...deferred<Response>(), input: JSON.parse(init!.body as string) as AnnotationRequest, signal: init!.signal as AbortSignal }
    jobs.push(job); return job.promise // Deliberately ignores AbortSignal.
  })
  const session = new BrowserSession({ backend, origin: 'https://lingobar.example', annotationFetch, capture,
    id: () => `run-${sockets.length + 1}`, socket: url => { expect(url).toBe('wss://lingobar.example/api/session'); const socket = new Socket(`run-${sockets.length + 1}`); sockets.push(socket); return socket as unknown as WebSocketPort } })
  const start = async () => { const pending = session.start(), socket = sockets.at(-1)!; socket.open(); socket.packet('ready'); await pending; return socket }
  const seed = (socket: Socket, caption = row(), revision = 3) => { socket.packet('caption', { caption, revision }); return `${socket.sessionId}:${caption.id}` }
  const result = { session, jobs, sockets, capture, cleanup, annotationFetch, start, seed }
  fixtures.push(result); return result
}
const network = vi.fn(() => { throw new Error('Real network forbidden in browser annotation tests') })
beforeEach(() => { vi.useFakeTimers(); network.mockClear(); vi.stubGlobal('fetch', network); vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Real socket forbidden') } }) })
afterEach(async () => {
  for (const f of fixtures) { f.session.dispose(); for (const job of f.jobs) job.reject(new Error('Synthetic cleanup')) }
  await settle(); fixtures.length = 0
  expect(network).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('browser annotation of retained text', () => {
  it('keeps microphone annotation retries in the audio batch and text retries in the original text batch', async () => {
    for (const source of ['microphone', 'text'] as const) {
      const endpoint = source === 'microphone' ? '/api/audio-annotation' : '/api/annotation'
      const f = fixture('/api/session', endpoint), socket = await f.start()
      const id = f.seed(socket, { ...row(), source }); f.session.stop()
      const pending = f.session.retryAnnotation(id)
      expect(String(f.annotationFetch.mock.calls[0][0])).toBe('https://lingobar.example' + endpoint)
      f.jobs[0].resolve(response(f.jobs[0].input)); await pending
      expect(f.capture).toHaveBeenCalledOnce(); expect(f.sockets).toHaveLength(1)
    }
  })

  it('annotates a saved ready caption after pause with HTTP only, preserving all source/translation fields', async () => {
    const f = fixture(), socket = await f.start(), id = f.seed(socket)
    f.session.toggleSaved(id); f.session.stop()
    const before = f.session.snapshot(), content = stable(before.captions[0]), sent = socket.sent.length
    const pending = f.session.retryAnnotation(id)
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0].input).toMatchObject({ version: 1, type: 'annotation', captionId: id, sourceRevision: 3, language: 'ja', original: content.original, japanese: '天気' })
    expect(f.jobs[0].input.sessionId).not.toBe('run-1')
    f.jobs[0].resolve(response(f.jobs[0].input)); await pending
    const after = f.session.snapshot()
    expect(after).toMatchObject({ state: 'idle', message: before.message })
    expect(after.captions[0]).toMatchObject({ reading: 'てんき', jaSegments: [{ text: '天気', reading: 'てんき' }], furiganaStatus: 'ready', saved: true })
    expect(stable(after.captions[0])).toEqual(content)
    expect(f.capture).toHaveBeenCalledOnce(); expect(f.sockets).toHaveLength(1); expect(socket.sent).toHaveLength(sent)
    expect(JSON.stringify(f.jobs[0].input)).not.toMatch(/apiKey|Authorization|endpoint|model/)
  })

  it('coalesces duplicate requests and permits at most two different captions in flight', async () => {
    const f = fixture(), socket = await f.start(), ids = ['one', 'two', 'three'].map(id => f.seed(socket, row(id)))
    f.session.stop()
    const one = f.session.retryAnnotation(ids[0]); await f.session.retryAnnotation(ids[0])
    const two = f.session.retryAnnotation(ids[1])
    await expect(f.session.retryAnnotation(ids[2])).rejects.toThrow('请求较多')
    expect(f.jobs).toHaveLength(2)
    f.jobs[0].resolve(response(f.jobs[0].input)); await one
    const three = f.session.retryAnnotation(ids[2]); expect(f.jobs).toHaveLength(3)
    f.jobs[1].resolve(response(f.jobs[1].input)); f.jobs[2].resolve(response(f.jobs[2].input)); await Promise.all([two, three])
    expect(f.session.snapshot().captions.every(caption => caption.furiganaStatus === 'ready')).toBe(true)
    expect(f.capture).toHaveBeenCalledOnce(); expect(f.sockets).toHaveLength(1)
  })

  it('keeps HTTP authorization errors local to the caption and does not restart audio', async () => {
    const f = fixture(), socket = await f.start(), id = f.seed(socket); f.session.toggleSaved(id); f.session.stop()
    const before = f.session.snapshot(), pending = f.session.retryAnnotation(id), denied = expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    f.jobs[0].resolve(new Response('SYNTHETIC-PRIVATE-PROVIDER-ERROR', { status: 401 })); await denied
    const after = f.session.snapshot()
    expect(after).toMatchObject({ state: 'idle', message: before.message }); expect(stable(after.captions[0])).toEqual(stable(before.captions[0]))
    expect(after.captions[0]).toMatchObject({ furiganaStatus: 'error', saved: true }); expect(JSON.stringify(after)).not.toContain('PRIVATE')
    expect(f.sockets).toHaveLength(1); expect(f.capture).toHaveBeenCalledOnce()
  })

  it('rejects an unconfigured or nonfinal caption without HTTP or additional media access', async () => {
    const disabled = fixture(null)
    await expect(disabled.session.retryAnnotation('unknown')).rejects.toThrow('尚未配置')
    expect(disabled.annotationFetch).not.toHaveBeenCalled(); expect(disabled.capture).not.toHaveBeenCalled(); expect(disabled.sockets).toHaveLength(0)
    const f = fixture(), socket = await f.start(), id = f.seed(socket, { ...row(), live: true, translationPending: true })
    await expect(f.session.retryAnnotation(id)).rejects.toThrow('定稿')
    expect(f.annotationFetch).not.toHaveBeenCalled(); expect(f.capture).toHaveBeenCalledOnce()
  })

  it.each(['stop', 'start', 'language', 'row-revision', 'eviction', 'dispose'] as const)('%s cancels old annotation ownership against late success and failure', async trigger => {
    for (const outcome of ['success', 'failure']) {
      const f = fixture(), socket = await f.start(), id = f.seed(socket)
      if (trigger === 'start') f.session.stop()
      const pending = f.session.retryAnnotation(id), cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      if (trigger === 'stop') f.session.stop()
      else if (trigger === 'start') await f.start()
      else if (trigger === 'language') f.session.saveSettings({ targetLanguages: ['en'] })
      else if (trigger === 'row-revision') f.seed(socket, row('one', 'Synthetic revised source with identical Japanese'), 4)
      else if (trigger === 'eviction') for (let index = 0; index < MAX_WEB_CAPTIONS; index++) f.seed(socket, row(`new-${index}`), 1)
      else f.session.dispose()
      await cancelled
      expect(f.jobs[0].signal.aborted).toBe(true)
      const afterCancellation = f.session.snapshot(), sockets = f.sockets.length, captures = f.capture.mock.calls.length
      if (outcome === 'success') f.jobs[0].resolve(response(f.jobs[0].input))
      else f.jobs[0].reject(new Error('SYNTHETIC-PRIVATE-LATE-ERROR'))
      await settle()
      expect(f.session.snapshot()).toEqual(afterCancellation)
      expect(f.sockets).toHaveLength(sockets); expect(f.capture).toHaveBeenCalledTimes(captures)
      if (trigger === 'row-revision') expect(afterCancellation.captions[0]).toMatchObject({ original: 'Synthetic revised source with identical Japanese', reading: '', furiganaStatus: 'error' })
      if (trigger === 'eviction') expect(afterCancellation.captions.some(caption => caption.id === id)).toBe(false)
    }
  })
})

describe('bounded same-origin annotation client', () => {
  it('rejects arbitrary destinations even when passed outside TypeScript', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, transport,
      'https://attacker.example/annotation' as '/api/annotation')).rejects.toMatchObject({ code: 'protocol' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('uses the fixed text-only request and accepts only the exact identity and Japanese alignment', async () => {
    const transport = vi.fn<typeof fetch>(async () => response(sample))
    expect(await requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, transport)).toEqual(annotated(sample))
    expect(String(transport.mock.calls[0][0])).toBe('https://lingobar.example/api/annotation')
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: JSON.stringify(sample) })
    for (const mismatch of [{ requestId: 'other' }, { sessionId: 'other' }, { captionId: 'other' }, { sourceRevision: 2 }, { language: 'en' }, { jaSegments: [{ text: '学校', reading: 'がっこう' }] }]) {
      await expect(requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, async () => new Response(JSON.stringify({ ...annotated(sample), ...mismatch })))).rejects.toMatchObject({ code: 'protocol' })
    }
  })

  it.each(['timeout', 'abort'] as const)('%s bounds an abort-ignoring transport and cancels its late response body', async cause => {
    const job = deferred<Response>(), parent = new AbortController(), transport = vi.fn<typeof fetch>(() => job.promise)
    const pending = requestAnnotation(sample, 'https://lingobar.example', parent.signal, transport)
    const interrupted = cause === 'timeout' ? expect(pending).rejects.toMatchObject({ code: 'timeout' }) : expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    if (cause === 'timeout') await vi.advanceTimersByTimeAsync(ANNOTATION_TIMEOUT_MS)
    else parent.abort()
    await interrupted; expect(transport.mock.calls[0][1]!.signal!.aborted).toBe(true)
    const cancel = vi.fn(); job.resolve(new Response(new ReadableStream({ cancel }))); await settle()
    expect(cancel).toHaveBeenCalledOnce()
    if (cause === 'abort') {
      await expect(requestAnnotation(sample, 'https://lingobar.example', parent.signal, transport)).rejects.toMatchObject({ name: 'AbortError' })
      expect(transport).toHaveBeenCalledOnce()
    }
  })

  it('bounds a stalled response body to30s and cancels its reader', async () => {
    const cancel = vi.fn(), pending = requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, async () => new Response(new ReadableStream({ cancel })))
    const timed = expect(pending).rejects.toMatchObject({ code: 'timeout' }); await settle()
    await vi.advanceTimersByTimeAsync(ANNOTATION_TIMEOUT_MS); await timed; expect(cancel).toHaveBeenCalledOnce()
  })

  it('bounds declared and streamed UTF8 bytes and rejects malformed UTF8 without leaking response data', async () => {
    for (const declared of [true, false]) {
      const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ start(controller) { if (!declared) controller.enqueue(new TextEncoder().encode('あ'.repeat(21_846))) }, cancel })
      await expect(requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, async () => new Response(body, { headers: declared ? { 'Content-Length': String(MAX_ANNOTATION_BYTES + 1) } : {} }))).rejects.toMatchObject({ code: 'protocol' })
      expect(cancel).toHaveBeenCalledOnce()
    }
    await expect(requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, async () => new Response(new Uint8Array([0xc3, 0x28])))).rejects.toMatchObject({ code: 'protocol' })
  })

  it('uses fixed error codes and messages for service errors, raw bodies and transport exceptions', async () => {
    for (const [status, code] of [[429, 'busy'], [504, 'timeout'], [401, 'unauthorized'], [429, 'quota'], [502, 'upstream'], [400, 'protocol'], [503, 'unavailable']] as const) {
      await expect(requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, async () => new Response(JSON.stringify({ version: 1, error: code }), { status }))).rejects.toMatchObject({ code })
    }
    for (const transport of [async () => new Response('SYNTHETIC-PRIVATE-RAW-ERROR', { status: 401 }), async () => { throw new Error('SYNTHETIC-PRIVATE-TRANSPORT-ERROR') }]) {
      const error = await requestAnnotation(sample, 'https://lingobar.example', new AbortController().signal, transport).catch(value => value as Error)
      expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain('PRIVATE')
    }
  })
})
