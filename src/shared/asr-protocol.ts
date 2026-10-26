export const DEFAULT_ASR_MODEL = 'qwen-audio-3.1-asr-flash-streaming'
export const DEFAULT_ASR_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
export const REALTIME_ASR_MODEL = 'qwen3-asr-flash-realtime'

export interface AsrConnectionOptions { model: string; endpoint: string }
interface Transcript { partial: boolean; text: string; id?: string }

export function isStreamingModel(model: string): boolean {
  return /^qwen-audio-[0-9.]+-asr-flash-streaming(?:-|$)/i.test(model)
}

/** Correct built-in service paths while preserving custom provider URLs verbatim. */
export function asrConnection(options: AsrConnectionOptions): { url: string; model: string; streaming: boolean } {
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
