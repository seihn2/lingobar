import { realtimeSessionConfig, streamingTask, streamingTranscriptionEvents, transcriptionEvent } from '../shared/asr-protocol'
import { MAX_WEB_MESSAGE_BYTES } from '../shared/web-protocol'
import { RelayError, upstreamStatus, type AsrTranscript, type RelayConfig, type WorkerAsr, type WorkerFetch, type WorkerSocket } from './types'

interface Callbacks { onTranscript(value: AsrTranscript): void; onError(error: RelayError): void }
interface Dependencies { fetch: WorkerFetch; signal: AbortSignal; id(): string; startupMs?: number }
interface Run {
  taskId: string
  streaming: boolean
  socket?: WorkerSocket
  abort: AbortController
  externalAbort(): void
  ready: boolean
  configured: boolean
  settled: boolean
  stopped: boolean
  completed: Set<string>
  listeners: Array<[string, (event: Event) => void]>
  timer?: ReturnType<typeof setTimeout>
  resolve(): void
  reject(error: RelayError): void
}
const MODELS = ['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'qwen3-asr-flash-realtime'] as const
const validText = (value: string) => value.length <= 8000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)
const validId = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)

/** Server-only adapter. The browser never selects a provider URL or supplies an API key. */
export function createWorkerAsr(config: RelayConfig, callbacks: Callbacks, deps: Dependencies): WorkerAsr {
  let current: Run | null = null
  const owns = (run: Run) => current === run && !run.stopped
  const close = (socket?: WorkerSocket) => { try { socket?.close(1000, 'Stopped') } catch { /* closed transport */ } }
  const release = (run: Run, error = new RelayError('unavailable')) => {
    if (!owns(run)) return
    current = null; run.stopped = true
    clearTimeout(run.timer)
    deps.signal.removeEventListener('abort', run.externalAbort)
    run.abort.abort()
    for (const [type, listener] of run.listeners) run.socket?.removeEventListener(type, listener)
    close(run.socket)
    run.completed.clear()
    if (!run.settled) { run.settled = true; run.reject(error) }
  }
  const fail = (run: Run, code: ConstructorParameters<typeof RelayError>[0]) => {
    if (!owns(run)) return
    const notify = run.ready && run.settled
    const error = new RelayError(code)
    release(run, error)
    if (notify) callbacks.onError(error)
  }
  const send = (run: Run, data: string | ArrayBuffer): boolean => {
    if (!owns(run)) return false
    try {
      if (!run.socket || run.socket.readyState !== 1) throw new Error()
      run.socket.send(data)
      return owns(run)
    } catch { fail(run, 'upstream'); return false }
  }
  const receive = (run: Run, data: unknown) => {
    if (!owns(run)) return
    if (typeof data !== 'string' || data.length > MAX_WEB_MESSAGE_BYTES || new TextEncoder().encode(data).byteLength > MAX_WEB_MESSAGE_BYTES) { fail(run, 'protocol'); return }
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      event = parsed as Record<string, unknown>
    } catch { fail(run, 'protocol'); return }
    const header = event.header as { task_id?: unknown; event?: unknown } | null | undefined
    if (run.streaming && (!header || header.task_id !== run.taskId)) return
    const kind = run.streaming ? header!.event : event.type
    if ((run.streaming ? kind === 'task-started' : kind === 'session.updated') && run.configured && !run.ready) {
      run.ready = true; run.settled = true
      clearTimeout(run.timer); run.resolve()
      return
    }
    if (kind === 'task-failed' || kind === 'error' || kind === 'conversation.item.input_audio_transcription.failed' || kind === 'task-finished' || kind === 'session.finished') { fail(run, 'upstream'); return }
    if (!run.ready) return
    const single = run.streaming ? null : transcriptionEvent(event)
    const transcripts = run.streaming ? kind === 'result-generated' ? streamingTranscriptionEvents(event) : [] : single ? [single] : []
    // Validate the whole envelope before dispatching even its first transcript.
    if (transcripts.some(value => !validText(value.text) || (value.id !== undefined && !validId(value.id)))) { fail(run, 'protocol'); return }
    for (const transcript of transcripts) {
      if (!owns(run)) return
      if (transcript.id && run.completed.has(transcript.id)) continue
      if (!transcript.partial && transcript.id) {
        run.completed.add(transcript.id)
        if (run.completed.size > 256) run.completed.delete(run.completed.values().next().value!)
      }
      callbacks.onTranscript({ partial: transcript.partial, text: transcript.text,
        ...(transcript.id ? { id: `${run.taskId}:${transcript.id}` } : {}) })
    }
  }
  const upgrade = async (run: Run) => {
    try {
      const url = run.streaming ? 'https://dashscope.aliyuncs.com/api-ws/v1/inference'
        : 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'
      const response = await deps.fetch(url, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${config.asrKey}` }, redirect: 'error', signal: run.abort.signal
      })
      if (!owns(run)) {
        close(response.webSocket || undefined)
        void response.body?.cancel().catch(() => {})
        return
      }
      if (response.status !== 101 || !response.webSocket) {
        close(response.webSocket || undefined)
        void response.body?.cancel().catch(() => {})
        fail(run, upstreamStatus(response.status)); return
      }
      run.socket = response.webSocket
      run.listeners = [
        ['message', event => { try { receive(run, (event as MessageEvent).data) } catch { fail(run, 'protocol') } }],
        ['error', () => fail(run, 'upstream')], ['close', () => fail(run, 'upstream')]
      ]
      for (const [type, listener] of run.listeners) run.socket.addEventListener(type, listener)
      run.socket.binaryType = 'arraybuffer'
      run.socket.accept()
      if (!owns(run)) return
      run.configured = true
      send(run, JSON.stringify(run.streaming ? streamingTask(run.taskId, config.model)
        : { event_id: deps.id(), type: 'session.update', session: realtimeSessionConfig() }))
    } catch { fail(run, 'upstream') }
  }
  return {
    start(): Promise<void> {
      if (current) release(current)
      if (deps.signal.aborted || !MODELS.includes(config.model) || typeof config.asrKey !== 'string' || !config.asrKey.trim() ||
        config.asrKey.length > 4096 || /[\u0000-\u001f\u007f]/u.test(config.asrKey)) return Promise.reject(new RelayError('unavailable'))
      let taskId: string
      try { taskId = deps.id(); if (!validId(taskId)) throw new Error() } catch { return Promise.reject(new RelayError('unavailable')) }
      return new Promise<void>((resolve, reject) => {
        const run: Run = { taskId, streaming: config.model !== 'qwen3-asr-flash-realtime', abort: new AbortController(),
          externalAbort: () => release(run), ready: false, configured: false, settled: false, stopped: false,
          completed: new Set(), listeners: [], resolve, reject }
        current = run
        deps.signal.addEventListener('abort', run.externalAbort, { once: true })
        run.timer = setTimeout(() => fail(run, 'upstream'), deps.startupMs ?? 20_000)
        void upgrade(run)
      })
    },
    push(pcm: ArrayBuffer): void {
      const run = current
      if (!run || !owns(run)) return
      if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength > 64_000 || pcm.byteLength % 2) { fail(run, 'protocol'); return }
      if (!run.ready) return
      if (run.streaming) { send(run, pcm); return }
      const bytes = new Uint8Array(pcm)
      let binary = ''
      for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
      try { send(run, JSON.stringify({ event_id: deps.id(), type: 'input_audio_buffer.append', audio: btoa(binary) })) }
      catch { fail(run, 'upstream') }
    },
    stop(): void { if (current) release(current) }
  }
}
