import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { trace } from '../diagnostics'

export const DEFAULT_ASR_MODEL = 'qwen-audio-3.1-asr-flash-streaming'
export const DEFAULT_ASR_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
export const REALTIME_ASR_MODEL = 'qwen3-asr-flash-realtime'
const MAX_AUDIO_BYTES = 64_000
const MAX_SOCKET_BUFFER = 512_000

export interface AsrOptions { apiKey: string; model: string; endpoint: string }
export interface AsrCallbacks {
  onPartial(text: string, utteranceId?: string): void
  /** An empty final still closes the identified utterance's latest draft. */
  onSentence(text: string, utteranceId?: string): void
  onError(message: string): void
}
export interface AsrSession {
  start(options: AsrOptions): Promise<void>
  push(chunk: ArrayBuffer): void
  stop(): void
}
interface Transcript { partial: boolean; text: string; id?: string }
interface Dependencies {
  createSocket(url: string, apiKey: string): WebSocket
  startupTimeoutMs: number
}
interface Session {
  socket: WebSocket
  streaming: boolean
  taskId: string
  ready: boolean
  settled: boolean
  stopped: boolean
  resolve(): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
  buffered: Buffer[]
  bytes: number
  completed: Set<string>
  apiKey: string
}

export function isStreamingModel(model: string): boolean {
  return /^qwen-audio-[0-9.]+-asr-flash-streaming(?:-|$)/i.test(model)
}

/** Correct built-in service paths while preserving custom provider URLs verbatim. */
export function asrConnection(options: Pick<AsrOptions, 'model' | 'endpoint'>): { url: string; model: string; streaming: boolean } {
  const model = options.model || DEFAULT_ASR_MODEL
  const streaming = isStreamingModel(model)
  const url = new URL(options.endpoint || DEFAULT_ASR_ENDPOINT)
  if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('Invalid ASR endpoint')
  const knownHost = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(url.hostname) ||
    /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/i.test(url.hostname)
  if (knownHost && /^\/api-ws\/v1\/(?:inference|realtime)\/?$/.test(url.pathname)) {
    url.pathname = `/api-ws/v1/${streaming ? 'inference' : 'realtime'}`
  }
  if (!streaming) url.searchParams.set('model', model)
  return { url: url.toString(), model, streaming }
}

/** Streaming protocol uses binary PCM frames after the matching task-started event. */
export function streamingTask(taskId: string, model: string): Record<string, unknown> {
  return {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio', task: 'asr', function: 'recognition', model,
      parameters: { format: 'pcm', sample_rate: 16000, heartbeat: true }, input: {}
    }
  }
}

function streamingSentence(value: Record<string, unknown>): Record<string, unknown> | null {
  const payload = value.payload as { output?: { sentence?: unknown } } | undefined
  const sentence = payload?.output?.sentence
  if (!sentence || typeof sentence !== 'object' || Array.isArray(sentence)) return null
  return sentence as Record<string, unknown>
}

function sentenceId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
}

export function streamingTranscriptionEvent(value: Record<string, unknown>): Transcript | null {
  const item = streamingSentence(value)
  if (!item) return null
  if (item.heartbeat === true || typeof item.text !== 'string') return null
  return { partial: item.sentence_end !== true, text: item.text.trim(), id: sentenceId(item.sentence_id) }
}

/** A result can carry a completed sentence and the next sentence's draft. */
export function streamingTranscriptionEvents(value: Record<string, unknown>): Transcript[] {
  const item = streamingSentence(value)
  if (!item || item.heartbeat === true) return []
  const primary = streamingTranscriptionEvent(value)
  const events = primary ? [primary] : []
  const stash = item.stash
  if (!stash || typeof stash !== 'object' || Array.isArray(stash)) return events
  const draft = stash as Record<string, unknown>
  const id = sentenceId(draft.sentence_id)
  // The documented nested stash has its own, next sentence ID. A same-ID or
  // unlabelled stash has no documented merge rule, so do not guess a suffix.
  if (id && id !== sentenceId(item.sentence_id) && draft.heartbeat !== true && typeof draft.text === 'string' && draft.text.trim()) {
    events.push({ partial: true, text: draft.text.trim(), id })
  }
  return events
}

/** No language hint: Qwen automatically recognizes supported input languages. */
export function realtimeSessionConfig(): Record<string, unknown> {
  return {
    input_audio_format: 'pcm', sample_rate: 16000,
    turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 600 }
  }
}

export function transcriptionEvent(value: unknown): { partial: boolean; text: string; id?: string } | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  const id = typeof event.item_id === 'string' ? event.item_id : undefined
  if (event.type === 'conversation.item.input_audio_transcription.text') {
    const text = `${typeof event.text === 'string' ? event.text : ''}${typeof event.stash === 'string' ? event.stash : ''}`
    return { partial: true, text, id }
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') {
    return { partial: false, text: event.transcript.trim(), id }
  }
  return null
}

/** One source per session; sessions never reconnect or replay already-transcribed audio. */
export class QwenAsrSession implements AsrSession {
  private owner: Session | null = null
  private dependencies: Dependencies

  constructor(private callbacks: AsrCallbacks, dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      createSocket: (url, apiKey) => new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: 15_000, maxPayload: 1_048_576, followRedirects: false
      }),
      startupTimeoutMs: 20_000,
      ...dependencies
    }
  }

  start(options: AsrOptions): Promise<void> {
    this.stop()
    if (!options.apiKey.trim()) return Promise.reject(new Error('请先在设置中填写语音识别 API Key。'))
    let connection: ReturnType<typeof asrConnection>
    try { connection = asrConnection(options) } catch { return Promise.reject(new Error('语音识别地址必须是有效的 wss:// 地址。')) }

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket
      try { socket = this.dependencies.createSocket(connection.url, options.apiKey) }
      catch { reject(new Error('无法建立语音识别连接，请检查地址与网络。')); return }
      const owner: Session = {
        socket, streaming: connection.streaming, taskId: randomUUID(), resolve, reject, ready: false, settled: false, stopped: false,
        buffered: [], bytes: 0, completed: new Set(), apiKey: options.apiKey
      }
      this.owner = owner
      owner.timer = setTimeout(() => this.fail(owner, '语音识别连接超时，请检查网络、地区与 API Key。'), this.dependencies.startupTimeoutMs)
      owner.timer.unref?.()
      socket.on('open', () => {
        if (!this.owns(owner)) return
        this.send(owner, owner.streaming ? streamingTask(owner.taskId, connection.model) : { type: 'session.update', session: realtimeSessionConfig() })
      })
      socket.on('message', (data: WebSocket.RawData) => this.receive(owner, data))
      socket.on('error', () => this.fail(owner, '语音识别连接失败，请检查网络、地区与 API Key。'))
      socket.on('close', () => this.fail(owner, '语音识别连接已断开，请重新开始。'))
    })
  }

  push(chunk: ArrayBuffer): void {
    const owner = this.owner
    if (!owner || !this.owns(owner)) return
    if (!(chunk instanceof ArrayBuffer) || chunk.byteLength === 0 || chunk.byteLength > 16_384 || chunk.byteLength % 2) {
      this.fail(owner, '音频数据格式不正确，请重新开始。')
      return
    }
    const buffer = Buffer.from(new Uint8Array(chunk))
    if (!owner.ready) {
      if (owner.bytes + buffer.length > MAX_AUDIO_BYTES) {
        this.fail(owner, '语音识别尚未就绪，音频缓冲已满，请重新开始。')
        return
      }
      owner.buffered.push(buffer)
      owner.bytes += buffer.length
      return
    }
    this.sendAudio(owner, buffer)
  }

  stop(): void {
    const owner = this.owner
    if (!owner) return
    // Stop is immediate: invalidate callbacks before releasing the transport.
    this.release(owner)
    if (!owner.settled) { owner.settled = true; owner.reject(new Error('已取消启动。')) }
  }

  private owns(owner: Session): boolean { return this.owner === owner && !owner.stopped }

  private sendAudio(owner: Session, buffer: Buffer): boolean {
    return this.send(owner, owner.streaming ? buffer : { type: 'input_audio_buffer.append', audio: buffer.toString('base64') })
  }

  private send(owner: Session, event: Record<string, unknown> | Buffer): boolean {
    if (!this.owns(owner) || owner.socket.readyState !== WebSocket.OPEN) return false
    if (owner.socket.bufferedAmount > MAX_SOCKET_BUFFER) {
      this.fail(owner, '网络发送速度不足，已暂停收音。请检查网络后重新开始。')
      return false
    }
    try {
      const data = Buffer.isBuffer(event) ? event : JSON.stringify(owner.streaming ? event : { event_id: randomUUID(), ...event })
      owner.socket.send(data, (error) => {
        if (error) this.fail(owner, '音频发送失败，请重新开始。')
      })
      return true
    } catch { this.fail(owner, '音频发送失败，请重新开始。'); return false }
  }

  private receive(owner: Session, data: WebSocket.RawData): void {
    if (!this.owns(owner)) return
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    if (bytes.length > 1_048_576) { this.fail(owner, '语音服务返回了过大的响应。'); return }
    let event: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(bytes.toString())
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      event = value as Record<string, unknown>
    } catch { this.fail(owner, '语音服务返回了无效数据，请检查服务地址。'); return }
    const header = event.header as { task_id?: unknown; event?: unknown; error_message?: unknown } | undefined
    if (owner.streaming && (!header || header.task_id !== owner.taskId)) return
    const kind = owner.streaming ? header!.event : event.type
    if (kind === 'result-generated') {
      const output = (event.payload as any)?.output
      const sentence = output?.sentence
      const stash = sentence?.stash
      trace('asr.result', { task: owner.taskId, id: sentence?.sentence_id,
        chars: typeof sentence?.text === 'string' ? sentence.text.length : 0,
        final: sentence?.sentence_end === true, heartbeat: sentence?.heartbeat === true,
        stashType: Array.isArray(stash) ? 'array' : typeof stash,
        stashId: stash?.sentence_id,
        stashChars: typeof stash?.text === 'string' ? stash.text.length : typeof stash === 'string' ? stash.length : 0,
        outputChars: typeof output?.text === 'string' ? output.text.length : 0 })
    }
    // session.created describes defaults; only updated/task-started acknowledges our configuration.
    if ((owner.streaming ? kind === 'task-started' : kind === 'session.updated') && !owner.ready) {
      owner.ready = true
      if (owner.timer) clearTimeout(owner.timer)
      for (const buffered of owner.buffered) {
        if (!this.sendAudio(owner, buffered)) return
      }
      owner.buffered = []; owner.bytes = 0
      owner.settled = true
      owner.resolve()
      return
    }
    if (kind === 'task-failed' || kind === 'error' || kind === 'conversation.item.input_audio_transcription.failed') {
      const error = event.error as { message?: unknown } | undefined
      const errorMessage = owner.streaming ? header?.error_message : error?.message
      let message = typeof errorMessage === 'string' ? errorMessage : '语音识别失败。'
      message = message.split(owner.apiKey).join('[已隐藏]').replace(/sk-[a-zA-Z0-9_-]+/g, '[已隐藏]').slice(0, 400)
      this.fail(owner, message)
      return
    }
    if (kind === 'session.finished' || kind === 'task-finished') { this.fail(owner, '语音识别会话已结束，请重新开始。'); return }
    if (!owner.ready) return
    const realtime = owner.streaming ? null : transcriptionEvent(event)
    const transcripts = owner.streaming
      ? kind === 'result-generated' ? streamingTranscriptionEvents(event) : []
      : realtime ? [realtime] : []
    for (const transcript of transcripts) {
      if (!this.owns(owner)) return
      // A repeated completed sentence may carry a fresh stash for the next one.
      if (transcript.id && owner.completed.has(transcript.id)) continue
      // Provider IDs restart in each session. Keep every update and clear bound
      // to its utterance so an older final cannot overwrite a newer partial.
      const utteranceId = transcript.id ? `${owner.taskId}:${transcript.id}` : undefined
      if (transcript.partial) this.callbacks.onPartial(transcript.text, utteranceId)
      else {
        if (transcript.id) {
          owner.completed.add(transcript.id)
          if (owner.completed.size > 256) owner.completed.delete(owner.completed.values().next().value!)
        }
        this.callbacks.onPartial('', utteranceId)
        if (this.owns(owner)) this.callbacks.onSentence(transcript.text, utteranceId)
      }
    }
  }

  private fail(owner: Session, message: string): void {
    if (!this.owns(owner)) return
    const wasReady = owner.settled
    this.release(owner)
    if (!wasReady) { owner.settled = true; owner.reject(new Error(message)) }
    else this.callbacks.onError(message)
  }

  private release(owner: Session): void {
    owner.stopped = true
    if (this.owner === owner) this.owner = null
    if (owner.timer) clearTimeout(owner.timer)
    owner.buffered = []; owner.bytes = 0; owner.apiKey = ''
    // terminate also aborts a pending upgrade; error listener above remains to consume its error.
    try { owner.socket.terminate() } catch { /* Already closed. */ }
  }
}
