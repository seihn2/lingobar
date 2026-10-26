import type { WebErrorCode } from '../shared/web-protocol'

/** Minimal Workers WebSocket surface. Do not assume Node ws, send callbacks or bufferedAmount support. */
export interface WorkerSocket {
  readonly readyState: number
  binaryType?: string
  accept(): void
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, callback: (event: Event) => void): void
  removeEventListener(type: string, callback: (event: Event) => void): void
}
export type UpgradeResponse = Response & { webSocket?: WorkerSocket | null }
export type WorkerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<UpgradeResponse>
export class RelayError extends Error {
  constructor(readonly code: WebErrorCode) { super(code); this.name = 'RelayError' }
}
export function upstreamStatus(status: number): WebErrorCode {
  return status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'quota' : 'upstream'
}
export type AsrModel = 'qwen-audio-3.1-asr-flash-streaming' | 'qwen-audio-3.0-asr-flash-streaming' | 'qwen3-asr-flash-realtime'
export interface RelayConfig { asrKey: string; translationKey: string; model: AsrModel }
export interface AsrTranscript { partial: boolean; text: string; id?: string }
export interface WorkerAsr {
  start(): Promise<void>
  push(pcm: ArrayBuffer): void
  stop(): void
}
