import type { Caption, Settings, SettingsInput, Snapshot } from '../shared/types'
import { validTargetLanguages } from '../shared/languages'
import { parseServerMessage, MAX_WEB_CAPTIONS, type WebClientMessage } from '../shared/web-protocol'
import { startMicrophone } from '../renderer/microphone'

export type WebSocketPort = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>
export type WebCapture = (onChunk: (pcm: ArrayBuffer) => void, onError: (message: string) => void, signal: AbortSignal) => Promise<() => void>
interface Options {
  backend: '/api/session' | null
  origin: string
  socket?: (url: string) => WebSocketPort
  capture?: WebCapture
  id?: () => string
  startupMs?: number
}
interface Run {
  id: string
  socket: WebSocketPort
  abort: AbortController
  ready: boolean
  settled: boolean
  ids: Map<string, string>
  cleanup?: () => void
  timer?: ReturnType<typeof setTimeout>
  resolve(): void
  reject(error: Error): void
}
const MAX_BUFFERED_AUDIO = 512_000
const errors = {
  unauthorized: '服务未授权，请检查服务端配置。', quota: '服务额度已用尽。',
  upstream: '识别或翻译服务暂不可用。', protocol: '服务返回的数据格式不正确。', unavailable: '服务尚未配置完成。'
}
export const WEB_SETTINGS: Settings = {
  targetLanguages: ['zh', 'ja'], showOriginal: true, showFurigana: true,
  captureMode: 'microphone', microphoneDeviceId: 'default', alwaysOnTop: false,
  opacity: 1, fontSize: 16, launchAtLogin: false, asrModel: '', asrEndpoint: '',
  translationBaseUrl: '', translationModel: '', hasAsrKey: false, hasTranslationKey: false
}
function cancelled(): Error { const error = new Error('已取消开始录音。'); error.name = 'AbortError'; return error }

/** Browser-owned, microphone-only session. No provider keys, desktop bridge or automatic reconnect. */
export class BrowserSession {
  private state: Snapshot
  private owner: Run | null = null
  private revisions = new Map<string, number>()
  private listeners = new Set<(snapshot: Snapshot) => void>()
  private socket: (url: string) => WebSocketPort
  private capture: WebCapture
  readonly configured: boolean
  constructor(private options: Options) {
    // A fixed same-origin route is the only accepted backend. Public config cannot select an arbitrary upstream.
    const origin = new URL(options.origin)
    if (origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) ||
      (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('网页版需要 HTTPS。')
    if (options.backend !== null && options.backend !== '/api/session') throw new Error('网页服务地址不正确。')
    this.configured = options.backend === '/api/session'
    this.socket = options.socket || (url => new WebSocket(url))
    this.capture = options.capture || ((chunk, error, signal) => startMicrophone(chunk, error, { signal, platform: 'other' }))
    this.state = { settings: structuredClone(WEB_SETTINGS), state: 'idle', message: this.configured ? '尚未连接' : '后端未配置', captions: [], partial: {}, collapsed: false }
  }
  snapshot(): Snapshot { return structuredClone(this.state) }
  subscribe(listener: (snapshot: Snapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(): void { for (const listener of this.listeners) listener(this.snapshot()) }

  start(): Promise<void> {
    if (!this.configured) return Promise.reject(new Error('后端未配置，暂不能开始录音。'))
    if (this.owner) return Promise.reject(new Error('请先暂停当前录音。'))
    const url = new URL('/api/session', this.options.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return new Promise<void>((resolve, reject) => {
      const id = this.options.id?.() || crypto.randomUUID()
      let socket: WebSocketPort
      try { socket = this.socket(url.toString()) } catch { reject(new Error('无法连接网页服务。')); return }
      const owner: Run = { id, ids: new Map(), socket, abort: new AbortController(), ready: false, settled: false, resolve, reject }
      this.owner = owner
      this.revisions.clear()
      this.state = { ...this.state, state: 'starting', message: '正在连接', partial: {} }
      this.publish()
      owner.timer = setTimeout(() => this.fail(owner, '连接或麦克风启动超时，请重新开始。'), this.options.startupMs ?? 30_000)
      socket.addEventListener('open', () => {
        if (!this.owns(owner)) return
        this.send(owner, { version: 1, type: 'start', sessionId: owner.id, settings: {
          targetLanguages: [...this.state.settings.targetLanguages], showOriginal: this.state.settings.showOriginal, showFurigana: this.state.settings.showFurigana
        } })
      })
      socket.addEventListener('message', event => {
        if (!this.owns(owner)) return
        try {
          const message = parseServerMessage((event as MessageEvent).data)
          if (message.sessionId !== owner.id) return
          if (message.type === 'error') { this.fail(owner, errors[message.code]); return }
          if (message.type === 'ready') {
            if (owner.ready) return
            owner.ready = true
            void this.capture(pcm => this.push(owner, pcm), () => this.fail(owner, '麦克风已中断，请重新开始。'), owner.abort.signal).then(cleanup => {
              if (!this.owns(owner)) { cleanup(); return }
              owner.cleanup = cleanup
              clearTimeout(owner.timer)
              this.state = { ...this.state, state: 'listening', message: '正在聆听' }
              owner.settled = true; owner.resolve(); this.publish()
            }).catch(() => this.fail(owner, '无法使用麦克风，请检查浏览器权限后重新开始。'))
          } else if (owner.ready) {
            const prior = this.revisions.get(message.caption.id) || 0
            if (message.revision <= prior) return
            const id = `${owner.id}:${message.caption.id}`
            const current = this.state.captions.find(caption => caption.id === id)
            // An evicted segment cannot return via a late translation. IDs from a new run never overwrite old history.
            if (prior && !current) return
            if (this.revisions.size >= MAX_WEB_CAPTIONS * 4 && !prior) { this.fail(owner, '本次录音记录已满，请重新开始。'); return }
            if (!current && this.state.captions.length >= MAX_WEB_CAPTIONS && this.state.captions.every(item => item.saved)) { this.fail(owner, '本页记录已满，请先导出收藏。'); return }
            this.revisions.set(message.caption.id, message.revision)
            owner.ids.set(id, message.caption.id)
            const caption = { ...message.caption, id, saved: current?.saved || false }
            const captions = current ? this.state.captions.map(item => item.id === caption.id ? caption : item) : [...this.state.captions, caption]
            while (captions.length > MAX_WEB_CAPTIONS) {
              const index = captions.findIndex(item => !item.saved)
              if (index < 0) { this.fail(owner, '本页记录已满，请先导出收藏。'); return }
              captions.splice(index, 1)
            }
            this.state = { ...this.state, captions }; this.publish()
          }
        } catch { this.fail(owner, errors.protocol) }
      })
      socket.addEventListener('error', () => this.fail(owner, '网页服务连接失败，请重新开始。'))
      socket.addEventListener('close', () => this.fail(owner, '连接已断开，请重新开始。'))
    })
  }
  private owns(owner: Run): boolean { return this.owner === owner }
  private send(owner: Run, message: WebClientMessage): void {
    if (!this.owns(owner)) return
    try { owner.socket.send(JSON.stringify(message)) } catch { this.fail(owner, '发送失败，请重新开始。') }
  }
  private push(owner: Run, pcm: ArrayBuffer): void {
    if (!this.owns(owner) || !owner.ready || owner.abort.signal.aborted) return
    if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength || pcm.byteLength > 64_000 || pcm.byteLength % 2 || owner.socket.readyState !== 1 || owner.socket.bufferedAmount + pcm.byteLength > MAX_BUFFERED_AUDIO) {
      this.fail(owner, '音频发送积压或格式异常，请重新开始。'); return
    }
    try { owner.socket.send(pcm) } catch { this.fail(owner, '音频发送失败，请重新开始。') }
  }
  private release(owner: Run): void {
    if (!this.owns(owner)) return
    this.owner = null
    clearTimeout(owner.timer)
    owner.abort.abort(); owner.cleanup?.()
    try { owner.socket.close(1000, 'Stopped') } catch { /* already closed */ }
    if (!owner.settled) { owner.settled = true; owner.reject(cancelled()) }
    this.state = { ...this.state, partial: {}, captions: this.state.captions.map(caption => {
      const interrupted = caption.live || caption.translationPending || caption.status === 'translating'
      const annotationInterrupted = caption.furiganaStatus === 'pending'
      if (!interrupted && !annotationInterrupted) return caption
      const readable = Object.values(caption.translations || {}).some(value => Boolean(value?.trim()))
      const missingSource = caption.translatedOriginal !== undefined && caption.translatedOriginal !== caption.original
      const incomplete = interrupted && (!readable || missingSource)
      // Error rendering exposes the recognized remainder alongside the valid translated prefix.
      // Do not turn an interrupted prefix or an empty placeholder into a completed/savable sentence.
      return { ...caption, live: false, translationPending: false,
        furiganaStatus: annotationInterrupted ? 'error' : caption.furiganaStatus,
        status: incomplete ? 'error' : caption.status === 'translating' ? 'ready' : caption.status,
        error: incomplete ? '已暂停，译文尚未完成。' : caption.error }
    }) }
  }
  private fail(owner: Run, message: string): void {
    if (!this.owns(owner)) return
    if (!owner.settled) { owner.settled = true; owner.reject(new Error(message)) }
    this.release(owner)
    this.state = { ...this.state, state: 'error', message }; this.publish()
  }
  stop(): void {
    const owner = this.owner
    if (owner) { if (owner.socket.readyState === 1) this.send(owner, { version: 1, type: 'stop', sessionId: owner.id }); this.release(owner) }
    this.state = { ...this.state, state: 'idle', message: this.configured ? '已暂停' : '后端未配置' }; this.publish()
  }
  saveSettings(input: SettingsInput): Settings {
    const allowed = ['targetLanguages', 'showOriginal', 'showFurigana', 'fontSize', 'opacity']
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('此设置不适用于网页版。')
    if (input.targetLanguages !== undefined && !validTargetLanguages(input.targetLanguages)) throw new Error('请选择1–8种不重复的字幕语言。')
    for (const key of ['showOriginal', 'showFurigana'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('设置格式不正确。')
    if (input.fontSize !== undefined && (!Number.isFinite(input.fontSize) || input.fontSize < 14 || input.fontSize > 24)) throw new Error('字号须为14–24。')
    if (input.opacity !== undefined && (!Number.isFinite(input.opacity) || input.opacity < 0.45 || input.opacity > 1)) throw new Error('不透明度须为45–100%。')
    const changesTranslation = (input.targetLanguages !== undefined && input.targetLanguages.join('|') !== this.state.settings.targetLanguages.join('|')) || (input.showFurigana !== undefined && input.showFurigana !== this.state.settings.showFurigana)
    if (changesTranslation && this.owner) this.stop()
    this.state = { ...this.state, settings: { ...this.state.settings, ...input, targetLanguages: [...(input.targetLanguages || this.state.settings.targetLanguages)] } }
    this.publish(); return structuredClone(this.state.settings)
  }
  toggleSaved(id: string): void {
    const caption = this.state.captions.find(item => item.id === id)
    if (!caption || (!caption.saved && (caption.live || caption.translationPending || caption.status !== 'ready'))) throw new Error('请等待这段翻译完成。')
    this.state = { ...this.state, captions: this.state.captions.map(item => item.id === id ? { ...item, saved: !item.saved } : item) }; this.publish()
  }
  retry(id: string): void {
    if (!this.owner?.ready || this.state.state !== 'listening') throw new Error('请先连接服务，再重试这段翻译。')
    const caption = this.state.captions.find(item => item.id === id)
    if (!caption || caption.live || caption.translationPending) throw new Error('这段尚未定稿。')
    const upstreamId = this.owner.ids.get(id)
    if (!upstreamId) throw new Error('这段属于已结束的连接，仍可复制或收藏。')
    this.send(this.owner, { version: 1, type: 'retry', sessionId: this.owner.id, id: upstreamId })
  }
  dispose(): void { this.stop(); this.listeners.clear() }
}
