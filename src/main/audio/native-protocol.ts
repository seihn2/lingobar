export const NATIVE_SYSTEM_AUDIO_ERROR_CODES = [
  'unsupported',
  'permission-denied',
  'device-unavailable',
  'format-unsupported',
  'transport-error',
  'buffer-overflow',
  'protocol-error',
  'helper-missing',
  'startup-timeout',
  'cancelled',
  'busy',
  'invalid-request',
  'not-selected',
  'missing-key',
  'asr-start-failed'
] as const

export type NativeSystemAudioErrorCode = (typeof NATIVE_SYSTEM_AUDIO_ERROR_CODES)[number]
export type NativeSystemAudioStartResult =
  | { ok: true; requestId: string }
  | { ok: false; error: NativeSystemAudioErrorCode }

export interface NativeSystemAudioDiagnostics {
  requestId: string
  chunks: number
  /** Peak and RMS amplitudes in [0, 1]; never raw audio. */
  level: number
  rms: number
}

export class NativeSystemAudioError extends Error {
  constructor(readonly code: NativeSystemAudioErrorCode) {
    super(code)
    this.name = 'NativeSystemAudioError'
  }
}

export function parseNativeSystemAudioRequestId(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null
}

export const NATIVE_AUDIO_MAX_FRAME_BYTES = 8192
export const NATIVE_AUDIO_PRE_ACTIVATE_BYTES = 64000

export const NATIVE_AUDIO_STARTUP_STAGES = [
  'initializing',
  'reading-output',
  'creating-tap',
  'creating-device',
  'starting-device'
] as const
export type NativeAudioStartupStage = (typeof NATIVE_AUDIO_STARTUP_STAGES)[number]

export type NativeSystemAudioMessage =
  | { type: 'ready'; protocol: 1; sampleRate: 16000; channels: 1; format: 'pcm_s16le' }
  | { type: 'error'; code: NativeSystemAudioErrorCode }
  | { type: 'stage'; stage: NativeAudioStartupStage }

/** Accept only the bounded control protocol, never arbitrary helper log messages. */
export function parseNativeSystemAudioMessage(line: string): NativeSystemAudioMessage {
  if (line.length > 4096) throw new NativeSystemAudioError('protocol-error')
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new NativeSystemAudioError('protocol-error')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NativeSystemAudioError('protocol-error')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (
    keys === 'stage,type' &&
    record.type === 'stage' &&
    NATIVE_AUDIO_STARTUP_STAGES.includes(record.stage as NativeAudioStartupStage)
  )
    return record as NativeSystemAudioMessage
  if (
    keys === 'channels,format,protocol,sampleRate,type' &&
    record.type === 'ready' &&
    record.protocol === 1 &&
    record.sampleRate === 16000 &&
    record.channels === 1 &&
    record.format === 'pcm_s16le'
  )
    return record as NativeSystemAudioMessage
  if (
    keys === 'code,type' &&
    record.type === 'error' &&
    NATIVE_SYSTEM_AUDIO_ERROR_CODES.includes(record.code as NativeSystemAudioErrorCode)
  )
    return record as NativeSystemAudioMessage
  throw new NativeSystemAudioError('protocol-error')
}

/** Stateful PCM1 framing; retains at most one 8-byte header and one bounded payload. */
export class NativeSystemAudioFrameParser {
  private header = new Uint8Array(8)
  private headerBytes = 0
  private payload: Uint8Array | null = null
  private payloadBytes = 0

  push(chunk: Uint8Array): Uint8Array[] {
    // Node pipe reads are normally <=64 KiB. Bound hostile injected/oversized reads too.
    if (chunk.byteLength > 1_048_576) throw new NativeSystemAudioError('buffer-overflow')
    const frames: Uint8Array[] = []
    let offset = 0
    while (offset < chunk.byteLength) {
      if (!this.payload) {
        const count = Math.min(8 - this.headerBytes, chunk.byteLength - offset)
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes)
        this.headerBytes += count
        offset += count
        if (this.headerBytes < 8) break
        if (
          this.header[0] !== 80 ||
          this.header[1] !== 67 ||
          this.header[2] !== 77 ||
          this.header[3] !== 49
        )
          throw new NativeSystemAudioError('protocol-error')
        const length = new DataView(this.header.buffer).getUint32(4, true)
        if (length < 2 || length > NATIVE_AUDIO_MAX_FRAME_BYTES || length % 2 !== 0)
          throw new NativeSystemAudioError('protocol-error')
        this.payload = new Uint8Array(length)
        this.payloadBytes = 0
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.byteLength - offset)
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadBytes)
      this.payloadBytes += count
      offset += count
      if (this.payloadBytes === this.payload.length) {
        frames.push(this.payload)
        this.payload = null
        this.payloadBytes = 0
        this.headerBytes = 0
      }
    }
    return frames
  }

  finish(): void {
    if (this.headerBytes || this.payload) throw new NativeSystemAudioError('protocol-error')
  }
}
