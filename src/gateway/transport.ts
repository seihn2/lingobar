import WebSocket from 'ws'
import { RelayError, type WorkerFetch, type WorkerSocket } from '../worker/types'

const ASR_URLS = new Set(['https://dashscope.aliyuncs.com/api-ws/v1/inference', 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'])
const COMPLETION_URL = 'https://api.deepseek.com/chat/completions'

/** Adapt the existing locked ws transport. Bounds apply before data enters the shared Worker protocol. */
export class NodePeer extends EventTarget implements WorkerSocket {
  private accepted = false
  private queued: Event[] = []
  private closeTimer?: ReturnType<typeof setTimeout>
  constructor(readonly socket: WebSocket, private beforeMessage?: (data: unknown) => boolean) {
    super(); socket.binaryType = 'arraybuffer'
    socket.on('message', (data, binary) => {
      const value = binary ? data : data.toString()
      try { if (this.beforeMessage && !this.beforeMessage(value)) return }
      catch { this.close(); return }
      const event = new MessageEvent('message', { data: value })
      if (this.accepted) this.dispatchEvent(event)
      else if (this.queued.length < 8) this.queued.push(event)
      else this.close()
    })
    socket.on('error', () => { if (this.accepted) this.dispatchEvent(new Event('error')); this.close() })
    socket.on('close', () => { clearTimeout(this.closeTimer); this.queued = []; this.dispatchEvent(new Event('close')) })
  }
  get readyState(): number { return this.socket.readyState }
  accept(): void { this.accepted = true; for (const event of this.queued.splice(0)) { if (this.readyState === 1) this.dispatchEvent(event) } }
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (this.socket.readyState !== 1 || this.socket.bufferedAmount + bytes > 256 * 1024) { this.close(); throw new RelayError('upstream') }
    this.socket.send(data, error => { if (error) this.close() })
  }
  close(code = 1000, reason = 'Stopped'): void {
    if (this.socket.readyState === WebSocket.CLOSED) return
    if (this.socket.readyState === WebSocket.CONNECTING) { this.socket.terminate(); return }
    this.socket.close(code, reason)
    if (!this.closeTimer) { this.closeTimer = setTimeout(() => this.socket.terminate(), 1000); this.closeTimer.unref() }
  }
}

/** No caller-controlled proxy destinations, redirects, Cookie, Access header or browser headers. */
export function nodeTransport(http: typeof fetch = fetch, connect = (url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options)): WorkerFetch {
  return async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers)
    if (init?.redirect !== 'error' || !/^Bearer [^\r\n]+$/u.test(headers.get('Authorization') || '') ||
      [...headers.keys()].some(name => !['authorization', 'content-type', 'upgrade'].includes(name))) throw new RelayError('protocol')
    if (url === COMPLETION_URL && init?.method === 'POST' && !headers.has('Upgrade')) return http(url, init)
    if (!ASR_URLS.has(url) || headers.get('Upgrade')?.toLowerCase() !== 'websocket' || init?.method && init.method !== 'GET') throw new RelayError('protocol')
    if (init.signal?.aborted) throw new RelayError('unavailable')
    return new Promise((resolve, reject) => {
      const socket = connect(url.replace(/^https:/u, 'wss:'), { headers: { Authorization: headers.get('Authorization')! },
        followRedirects: false, handshakeTimeout: 15_000, maxPayload: 128 * 1024, perMessageDeflate: false })
      const peer = new NodePeer(socket)
      let settled = false
      const cancel = () => { peer.close(); if (!settled) { settled = true; reject(new RelayError('unavailable')) } }
      init.signal?.addEventListener('abort', cancel, { once: true })
      const detach = () => init.signal?.removeEventListener('abort', cancel)
      socket.once('close', () => { detach(); if (!settled) { settled = true; reject(new RelayError('upstream')) } })
      socket.once('error', () => { if (!settled) { settled = true; detach(); reject(new RelayError('upstream')) } })
      socket.once('unexpected-response', (_request, response) => {
        if (settled) return
        settled = true; detach(); response.destroy(); peer.close()
        resolve({ status: response.statusCode || 502, webSocket: null } as unknown as Response)
      })
      socket.once('open', () => {
        if (settled || init.signal?.aborted) { cancel(); return }
        settled = true
        resolve({ status: 101, webSocket: peer } as unknown as Response)
      })
    })
  }
}
