import { CaptionQueue } from '../shared/caption-queue'
import { parseClientMessage, parseServerMessage, MAX_WEB_MESSAGE_BYTES, type WebSessionSettings, type WebServerMessage, type WebErrorCode } from '../shared/web-protocol'
import type { Caption } from '../shared/types'
import { createWorkerAsr } from './asr'
import { createCompletion, type CompletionService } from './completion'
import { RelayError, type AsrTranscript, type RelayConfig, type WorkerSocket, type WorkerFetch, type WorkerAsr } from './types'

export const SESSION_LIMITS = { durationMs: 300_000, audioBytes: 9_600_000, captions: 200, transcripts: 2000, firstControlMs: 5000, audioIdleMs: 35_000 }
interface Dependencies {
  fetch: WorkerFetch
  hold(promise: Promise<unknown>): void
  id(): string
  now?: () => number
  completion?: CompletionService
}
type Published = { fields: unknown[]; revision: number; live: boolean }
const fields = (caption: Caption): unknown[] => [caption.original, caption.translatedOriginal, caption.status, caption.live, caption.translationPending,
  caption.language, caption.translations, caption.zh, caption.en, caption.ja, caption.reading, caption.jaSegments, caption.furiganaStatus]

/** One authorized browser connection owns its ASR, queues, timers and cancellation. No persistent audio or shared user state. */
export class RelaySession {
  private closed = false
  private sessionId: string | null = null
  private asr: WorkerAsr | null = null
  private queue: CaptionQueue | null = null
  private ready = false
  private abort = new AbortController()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private firstTimer: ReturnType<typeof setTimeout>
  private idleTimer?: ReturnType<typeof setTimeout>
  private published = new Map<string, Published>()
  private completed = new Set<string>()
  private audioBytes = 0
  private transcripts = 0
  private outputBytes = 0
  private createdCaptions = 0
  private allowance = 64_000
  private lastAudioAt: number
  constructor(private peer: WorkerSocket, private config: RelayConfig, private dependencies: Dependencies) {
    this.lastAudioAt = this.now()
    this.firstTimer = this.timer(() => this.fail('protocol'), SESSION_LIMITS.firstControlMs)
    this.timer(() => this.fail('quota'), SESSION_LIMITS.durationMs)
    peer.addEventListener('message', event => this.receive((event as MessageEvent).data))
    peer.addEventListener('close', () => this.stop())
    peer.addEventListener('error', () => this.stop())
  }
  private now(): number { return this.dependencies.now?.() ?? Date.now() }
  private timer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.closed) callback() }, ms)
    this.timers.add(timer); return timer
  }
  private clear(timer?: ReturnType<typeof setTimeout>): void { if (timer) { clearTimeout(timer); this.timers.delete(timer) } }
  private receive(data: unknown): void {
    if (this.closed) return
    try {
      if (data instanceof ArrayBuffer) {
        if (!this.ready || !this.asr || !data.byteLength || data.byteLength > 64_000 || data.byteLength % 2) throw new RelayError('protocol')
        const now = this.now()
        this.allowance = Math.min(64_000, this.allowance + Math.max(0, now - this.lastAudioAt) * 32)
        this.lastAudioAt = now
        if (data.byteLength > this.allowance || this.audioBytes + data.byteLength > SESSION_LIMITS.audioBytes) throw new RelayError('quota')
        this.allowance -= data.byteLength; this.audioBytes += data.byteLength
        this.armIdle(); this.asr.push(data); return
      }
      const message = parseClientMessage(data)
      if (message.type === 'start') {
        if (this.sessionId !== null) throw new RelayError('protocol')
        this.sessionId = message.sessionId; this.clear(this.firstTimer)
        this.start(message.settings); return
      }
      if (message.sessionId !== this.sessionId) throw new RelayError('protocol')
      if (message.type === 'stop') { this.stop(); return }
      if (!this.ready || !this.queue) throw new RelayError('protocol')
      const caption = this.queue.captions.find(item => item.id === message.id)
      if (!caption) throw new RelayError('protocol')
      if (caption.live || caption.translationPending || caption.status === 'translating') return
      this.queue.retry(caption.id)
    } catch (error) { this.fail(error instanceof RelayError ? error.code : 'protocol') }
  }
  private start(settings: WebSessionSettings): void {
    const completion = this.dependencies.completion || createCompletion(this.config, this.dependencies.fetch)
    const operation = <T>(promise: Promise<T>): Promise<T> => {
      const observed = promise.catch(error => {
        if (!this.closed && error instanceof RelayError && ['unauthorized', 'quota'].includes(error.code)) this.fail(error.code)
        throw error
      })
      this.dependencies.hold(observed.catch(() => {})); return observed
    }
    this.queue = new CaptionQueue([], () => ({ baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', targetLanguages: [...settings.targetLanguages], generateFurigana: settings.showFurigana }),
      () => this.publish(), () => {},
      (original, config, signal) => operation(completion.translate(original, settings.targetLanguages, Boolean(config.partial), signal!)),
      (original, japanese, _config, signal) => operation(completion.annotate(original, japanese, signal!)),
      { id: () => { if (++this.createdCaptions > SESSION_LIMITS.captions) throw new RelayError('quota'); return this.dependencies.id() }, trace: () => {} })
    this.asr = createWorkerAsr(this.config, {
      onTranscript: transcript => this.transcript(transcript), onError: error => this.fail(error.code)
    }, { fetch: this.dependencies.fetch, signal: this.abort.signal, id: this.dependencies.id })
    const starting = this.asr.start().then(() => {
      if (this.closed) return
      this.ready = true; this.armIdle()
      this.send({ version: 1, type: 'ready', sessionId: this.sessionId! })
    }).catch(error => { if (!this.closed) this.fail(error instanceof RelayError ? error.code : 'upstream') })
    this.dependencies.hold(starting)
  }
  private transcript(transcript: AsrTranscript): void {
    if (this.closed || !this.ready || !this.queue) return
    if (++this.transcripts > SESSION_LIMITS.transcripts) { this.fail('quota'); return }
    if (transcript.id && this.completed.has(transcript.id)) return
    try {
      if (transcript.partial) this.queue.updatePartial(transcript.text, 'microphone', transcript.id)
      else {
        if (transcript.id) this.completed.add(transcript.id)
        this.queue.finishSentence(transcript.text, 'microphone', transcript.id)
      }
    } catch (error) { this.fail(error instanceof RelayError ? error.code : 'upstream') }
  }
  private publish(): void {
    if (this.closed || !this.queue || !this.sessionId) return
    const current = new Set(this.queue.captions.map(caption => caption.id))
    for (const [id, prior] of this.published) {
      if (!current.has(id) && prior.live) {
        this.send({ version: 1, type: 'retract', sessionId: this.sessionId, id })
        this.published.delete(id)
      }
    }
    for (const caption of this.queue.captions) {
      if (this.closed) return
      const next = fields(caption), prior = this.published.get(caption.id)
      if (prior && next.every((value, index) => value === prior.fields[index])) continue
      const revision = (prior?.revision || 0) + 1
      const safe: Caption = { ...caption, saved: false }
      delete safe.error
      this.published.set(caption.id, { fields: next, revision, live: Boolean(caption.live) })
      this.send({ version: 1, type: 'caption', sessionId: this.sessionId, revision, caption: safe })
    }
  }
  private send(message: WebServerMessage): void {
    if (this.closed || this.peer.readyState !== 1) return
    try {
      const text = JSON.stringify(message)
      if (text.length > MAX_WEB_MESSAGE_BYTES) throw new RelayError('upstream')
      parseServerMessage(text)
      const bytes = new TextEncoder().encode(text).byteLength
      if ((this.outputBytes += bytes) > 6_000_000) throw new RelayError('quota')
      this.peer.send(text)
    } catch (error) { this.fail(error instanceof RelayError ? error.code : 'upstream') }
  }
  private armIdle(): void { this.clear(this.idleTimer); this.idleTimer = this.timer(() => this.fail('unavailable'), SESSION_LIMITS.audioIdleMs) }
  private fail(code: WebErrorCode): void {
    if (this.closed) return
    // Use a direct, fixed error frame to avoid recursively validating a failed outgoing caption.
    try { if (this.sessionId && this.peer.readyState === 1) this.peer.send(JSON.stringify({ version: 1, type: 'error', sessionId: this.sessionId, code })) } catch { /* peer is gone */ }
    this.stop()
  }
  stop(): void {
    if (this.closed) return
    this.closed = true; this.ready = false
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear(); this.abort.abort(); this.asr?.stop(); this.queue?.close()
    try { this.peer.close(1000, 'Stopped') } catch { /* already closed */ }
    this.published.clear(); this.completed.clear()
  }
}
