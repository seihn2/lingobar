import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_ONCE_PLAN, runAudioOnce } from '../src/gateway/audio-test'
import type { WorkerFetch, WorkerSocket } from '../src/worker/types'
const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); vi.unstubAllGlobals() })
const key = 'synthetic-test-key-never-real'
function fixture(bytes = 6400) {
  const directory = mkdtempSync(join(tmpdir(), 'lingobar-audio-once-')); chmodSync(directory, 0o700)
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const asrKeyFile = join(directory, 'asr.json'), translationKeyFile = join(directory, 'translation.json'), pcmFile = join(directory, 'synthetic.pcm')
  for (const file of [asrKeyFile, translationKeyFile]) writeFileSync(file, JSON.stringify({ apiKey: key }), { mode: 0o600 })
  writeFileSync(pcmFile, Buffer.alloc(bytes))
  const ledgerFile = join(directory, 'audio-budget.json')
  const writeLedger = (reservedMicroCny = 0, attempts = 0) => writeFileSync(ledgerFile, JSON.stringify({ version: 1, batch: AUDIO_ONCE_PLAN.batch, reservedMicroCny, attempts }), { mode: 0o600 })
  writeLedger()
  return { directory, ledgerFile, writeLedger, readLedger: () => JSON.parse(readFileSync(ledgerFile, 'utf8')),
    options: { execute: true, confirmSyntheticAudio: true, ledgerDirectory: directory, asrKeyFile, translationKeyFile, pcmFile } }
}
class Socket extends EventTarget implements WorkerSocket {
  readyState = 1
  sent: Record<string, unknown>[] = []
  closed = false
  constructor(private final: string | null = 'Hello, world.', private noFinal = false) { super() }
  accept(): void {}
  event(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  send(raw: string | ArrayBuffer | ArrayBufferView): void {
    const message = JSON.parse(String(raw)); this.sent.push(message)
    if (message.type === 'session.update') queueMicrotask(() => this.event({ type: 'session.updated' }))
    if (message.type === 'input_audio_buffer.commit') queueMicrotask(() => {
      this.event({ type: 'conversation.item.input_audio_transcription.text', text: 'ignored partial' })
      if (this.noFinal) { this.event({ type: 'session.finished' }); return }
      if (this.final !== null) {
        this.event({ type: 'conversation.item.input_audio_transcription.completed', transcript: this.final })
        this.event({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'ignored second final' })
      }
    })
  }
  close(): void { this.closed = true; this.readyState = 3 }
}
function transport(socket: Socket, before: () => void = () => {}, translation = '你好，世界。') {
  return vi.fn<WorkerFetch>(async (url, init) => {
    before()
    if (String(url).includes('dashscope')) return { status: 101, webSocket: socket } as unknown as Response
    expect(socket.closed).toBe(true)
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    const request = JSON.parse(String(init?.body))
    expect(request).toMatchObject({ model: 'deepseek-flash', max_tokens: 1024, stream: false, thinking: { type: 'disabled' }, tool_choice: 'none', response_format: { type: 'json_object' } })
    expect(request.messages).toHaveLength(2)
    expect(request.messages[1].content).toBe('Hello, world.')
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ zh: translation }) } }], usage: { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131, private: key } })
  })
}

describe.skipIf(process.platform === 'win32')('manual once-only synthetic audio runner', () => {
  it('defaults to dry-run without reading any paths, opening ledger or networking', async () => {
    const upstream = vi.fn<WorkerFetch>(), network = vi.fn(); vi.stubGlobal('fetch', network)
    const result = await runAudioOnce({ asrKeyFile: '/not/a/file' }, { upstream })
    expect(result.status).toBe('dry-run'); expect(result.reservedMicroCny).toBe(0)
    expect(upstream).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
  })
  it('requires both execution and synthetic-audio acknowledgement', async () => {
    const f = fixture(), upstream = vi.fn<WorkerFetch>()
    expect((await runAudioOnce({ ...f.options, confirmSyntheticAudio: false }, { upstream })).status).toBe('blocked')
    expect(f.readLedger().reservedMicroCny).toBe(0); expect(upstream).not.toHaveBeenCalled()
  })
  it('reserves the whole new yuan before ANY dispatch, sends finite manual PCM, translates ONLY first final once', async () => {
    const f = fixture(320000), socket = new Socket(), upstream = transport(socket, () => expect(f.readLedger()).toMatchObject({ reservedMicroCny: 1000000, attempts: 1 }))
    const result = await runAudioOnce(f.options, { upstream, chunkIntervalMs: 0 })
    expect(result).toMatchObject({ status: 'completed', reservedMicroCny: 1000000, asrAttempts: 1, translationAttempts: 1,
      transcript: 'Hello, world.', translationZh: '你好，世界。', asrUsage: null, deepseekUsage: { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131 } })
    expect(JSON.stringify(result)).not.toContain(key); expect(result.plan.actualChargeCny).toBeNull()
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(socket.sent[0]).toMatchObject({ type: 'session.update', session: { turn_detection: null, sample_rate: 16000, input_audio_format: 'pcm' } })
    expect(socket.sent.filter(v => v.type === 'input_audio_buffer.commit')).toHaveLength(1)
    expect(socket.sent.filter(v => v.type === 'input_audio_buffer.append').reduce((n, v) => n + Buffer.from(v.audio as string, 'base64').length, 0)).toBe(320000)
    const second = await runAudioOnce(f.options, { upstream, chunkIntervalMs: 0 })
    expect(second.status).toBe('blocked'); expect(upstream).toHaveBeenCalledTimes(2)
    expect(f.readLedger()).toMatchObject({ reservedMicroCny: 1000000, attempts: 1 })
  })
  it.each([[1, 0], [0, 1], [1000000, 1]])('refuses any existing new-batch reservation/attempt (%s,%s), without resetting it', async (spent, attempts) => {
    const f = fixture(), upstream = vi.fn<WorkerFetch>(); f.writeLedger(spent, attempts)
    expect((await runAudioOnce(f.options, { upstream })).status).toBe('blocked')
    expect(f.readLedger()).toMatchObject({ reservedMicroCny: spent, attempts }); expect(upstream).not.toHaveBeenCalled()
  })
  it.each([0, 1, 320002])('refuses empty, odd or oversized PCM of %s bytes before reservation', async bytes => {
    const f = fixture(bytes), upstream = vi.fn<WorkerFetch>()
    expect((await runAudioOnce(f.options, { upstream })).status).toBe('blocked')
    expect(f.readLedger().reservedMicroCny).toBe(0); expect(upstream).not.toHaveBeenCalled()
  })
  it('refuses WAV/symlink input and unprivate or malformed key JSON without disclosing content', async () => {
    const f = fixture(), upstream = vi.fn<WorkerFetch>()
    writeFileSync(f.options.pcmFile, Buffer.from('RIFFabcdefgh'))
    expect((await runAudioOnce(f.options, { upstream })).status).toBe('blocked')
    writeFileSync(f.options.pcmFile, Buffer.alloc(3200)); const alias = join(f.directory, 'alias.pcm'); symlinkSync(f.options.pcmFile, alias)
    expect((await runAudioOnce({ ...f.options, pcmFile: alias }, { upstream })).status).toBe('blocked')
    chmodSync(f.options.asrKeyFile, 0o644)
    expect((await runAudioOnce(f.options, { upstream })).status).toBe('blocked')
    chmodSync(f.options.asrKeyFile, 0o600); writeFileSync(f.options.asrKeyFile, key)
    const result = await runAudioOnce(f.options, { upstream })
    expect(JSON.stringify(result)).not.toContain(key); expect(upstream).not.toHaveBeenCalled(); expect(f.readLedger().reservedMicroCny).toBe(0)
  })
  it('does not translate partials/no-final, retains all reservation and disconnects', async () => {
    const f = fixture(), socket = new Socket(null, true), upstream = transport(socket)
    const result = await runAudioOnce(f.options, { upstream, chunkIntervalMs: 0 })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'asr-no-final', translationAttempts: 0, reservedMicroCny: 1000000 })
    expect(upstream).toHaveBeenCalledOnce(); expect(socket.closed).toBe(true); expect(f.readLedger().reservedMicroCny).toBe(1000000)
  })
  it('times out a silent or unresolved ASR without retry or translation', async () => {
    const f = fixture(), upstream = vi.fn<WorkerFetch>(() => new Promise(() => {}))
    const result = await runAudioOnce(f.options, { upstream, asrTimeoutMs: 10 })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'asr-timeout', translationAttempts: 0 })
    expect(upstream).toHaveBeenCalledOnce(); expect(f.readLedger().reservedMicroCny).toBe(1000000)
  })
  it('keeps full reservation after unknown network failure and redacts raw supplier messages', async () => {
    const f = fixture(), upstream = vi.fn<WorkerFetch>(async () => { throw new Error(key) })
    const result = await runAudioOnce(f.options, { upstream })
    expect(result.status).toBe('incomplete'); expect(JSON.stringify(result)).not.toContain(key)
    expect(upstream).toHaveBeenCalledOnce(); expect(f.readLedger().reservedMicroCny).toBe(1000000)
  })
  it('makes no more than one translation when supplier JSON fails or times out', async () => {
    for (const never of [false, true]) {
      const f = fixture(), socket = new Socket(), upstream = vi.fn<WorkerFetch>(async url => {
        if (String(url).includes('dashscope')) return { status: 101, webSocket: socket } as unknown as Response
        if (never) return new Promise(() => {})
        return new Response(key, { status: 500 })
      })
      const result = await runAudioOnce(f.options, { upstream, chunkIntervalMs: 0, translationTimeoutMs: 10 })
      expect(result).toMatchObject({ status: 'incomplete', asrAttempts: 1, translationAttempts: 1, reservedMicroCny: 1000000 })
      expect(upstream).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain(key)
    }
  })
  it('retains numeric supplier usage even if the returned translation format fails', async () => {
    const f = fixture(), socket = new Socket()
    const upstream = vi.fn<WorkerFetch>(async url => String(url).includes('dashscope') ? { status: 101, webSocket: socket } as unknown as Response :
      Response.json({ choices: [{ finish_reason: 'length', message: { content: 'not-json' } }], usage: { prompt_tokens: 123, completion_tokens: 1024 } }))
    const result = await runAudioOnce(f.options, { upstream, chunkIntervalMs: 0 })
    expect(result).toMatchObject({ status: 'incomplete', translationAttempts: 1, deepseekUsage: { prompt_tokens: 123, completion_tokens: 1024 }, reservedMicroCny: 1000000 })
    expect(upstream).toHaveBeenCalledTimes(2)
  })
  it('does not dispatch a translation beyond full-input bounds or echo an accidental key as text', async () => {
    for (const final of ['字'.repeat(2660), key]) {
      const f = fixture(), socket = new Socket(final), upstream = transport(socket)
      const result = await runAudioOnce(f.options, { upstream, chunkIntervalMs: 0 })
      expect(result.status).toBe('incomplete'); expect(result.translationAttempts).toBe(0); expect(upstream).toHaveBeenCalledOnce()
      expect(JSON.stringify(result)).not.toContain(key)
    }
  })
  it('reports reservation-write uncertainty and never dispatches after a failed durable reservation', async () => {
    const f = fixture(), upstream = vi.fn<WorkerFetch>()
    writeFileSync(join(f.directory, 'audio-budget.pending'), 'existing unresolved write', { mode: 0o600 })
    const result = await runAudioOnce(f.options, { upstream })
    expect(result).toMatchObject({ status: 'blocked', reservationState: 'uncertain', reservedMicroCny: null, reason: 'reservation-write-uncertain-do-not-retry' })
    expect(upstream).not.toHaveBeenCalled()
  })
  it('cancels an active ASR with no retry/translation and retains the full reservation', async () => {
    const f = fixture(), abort = new AbortController(), socket = new Socket(null), upstream = transport(socket)
    const pending = runAudioOnce(f.options, { upstream, signal: abort.signal, chunkIntervalMs: 0 })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
    abort.abort()
    const result = await pending
    expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled', translationAttempts: 0, reservedMicroCny: 1000000 })
    expect(socket.closed).toBe(true); expect(upstream).toHaveBeenCalledOnce()
  })
  it('holds the shared audio lock until completion and never touches an old text ledger', async () => {
    const f = fixture(), old = join(f.directory, 'test-budget.json'); writeFileSync(old, '{"reservedMicroCny":4444}')
    let finish!: (value: Response) => void
    const upstream = vi.fn<WorkerFetch>(() => new Promise(resolve => { finish = resolve }))
    const first = runAudioOnce(f.options, { upstream, asrTimeoutMs: 100 })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
    expect((await runAudioOnce(f.options, { upstream })).status).toBe('blocked')
    finish(new Response(null, { status: 503 })); await first
    expect(readFileSync(old, 'utf8')).toBe('{"reservedMicroCny":4444}')
    expect(f.readLedger().reservedMicroCny).toBe(1000000)
  })
})
