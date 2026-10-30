import { webApiPath } from './routes'
import type { AudioStatus } from './config'
import type { Caption, Settings, SettingsInput, Snapshot } from '../shared/types'
import { validTargetLanguages } from '../shared/languages'
import { parseServerMessage, MAX_WEB_CAPTIONS, type WebClientMessage } from '../shared/web-protocol'
import { startMicrophone } from '../renderer/microphone'
import { annotationText, type AnnotationRequest } from '../shared/annotation-protocol'
import { annotationCancelled, requestAnnotation } from './annotation-client'
import { parseTextRequest, parseTextResponse, type TextTranslationRequest } from '../shared/text-protocol'

export type WebSocketPort = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'>
export type WebCapture = (onChunk: (pcm: ArrayBuffer) => void, onError: (message: string) => void, signal: AbortSignal) => Promise<() => void>
interface Options {
  authBackend?: '/api/auth' | null
  backend: '/api/session' | null
  origin: string
  socket?: (url: string) => WebSocketPort
  capture?: WebCapture
  id?: () => string
  startupMs?: number
  disabledReason?: 'unauthorized'
  annotationFetch?: typeof fetch
  textBackend?: '/api/translate' | null
  textFetch?: typeof fetch
  credentialsBackend?: '/api/settings/translation-key' | null
  asrCredentialsBackend?: '/api/settings/asr-key' | null
  audioStatus?: AudioStatus
  credentialsFetch?: typeof fetch
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
interface AnnotationJob { request: AnnotationRequest; abort: AbortController; epoch: number }
interface TextJob { request: TextTranslationRequest; abort: AbortController; captionId?: string }
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
function textCancelled(): Error { const error = new Error('已取消文字翻译。'); error.name = 'AbortError'; return error }
function cancelled(): Error { const error = new Error('已取消开始录音。'); error.name = 'AbortError'; return error }

/** Browser-owned audio/text session. Provider calls stay server-side; no desktop bridge or automatic reconnect. */
export class BrowserSession {
  private state: Snapshot
  private owner: Run | null = null
  private revisions = new Map<string, number>()
  private captionRevisions = new Map<string, number>()
  private annotations = new Map<string, AnnotationJob>()
  private annotationEpoch = 0
  private annotationSession = crypto.randomUUID()
  private listeners = new Set<(snapshot: Snapshot) => void>()
  private socket: (url: string) => WebSocketPort
  private capture: WebCapture
  private textJob: TextJob | null = null
  private credentialRequest: AbortController | null = null
  private textServiceConfigured: boolean
  readonly authAvailable: boolean
  readonly configured: boolean
  readonly credentialsAvailable: boolean
  readonly asrCredentialsAvailable: boolean
  get audioStatusMessage(): string {
    if (this.options.disabledReason === 'unauthorized') return '服务未授权'
    if (this.configured) return ''
    if (this.authAvailable && !this.textConfigured) return '请登录或使用自己的 API Key'
    return ({ ready: '语音入口尚未启用', disabled: '语音入口尚未启用', 'missing-key': '请在字幕设置中保存百炼语音密钥', 'budget-unverified': '语音费用上界尚未核实，暂不能开始聆听；文字翻译仍按独立配置使用', quota: '本次语音测试预算已用尽' })[this.options.audioStatus || 'disabled']
  }
  get textConfigured(): boolean { return this.textServiceConfigured }
  constructor(private options: Options) {
    // A fixed same-origin route is the only accepted backend. Public config cannot select an arbitrary upstream.
    const origin = new URL(options.origin)
    if (origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) ||
      (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('网页版需要 HTTPS。')
    if (options.backend !== null && options.backend !== '/api/session') throw new Error('网页服务地址不正确。')
    if (options.textBackend !== undefined && options.textBackend !== null && options.textBackend !== '/api/translate') throw new Error('文字服务地址不正确。')
    if (options.credentialsBackend !== undefined && options.credentialsBackend !== null && options.credentialsBackend !== '/api/settings/translation-key') throw new Error('密钥配置地址不正确。')
    if (options.asrCredentialsBackend !== undefined && options.asrCredentialsBackend !== null && options.asrCredentialsBackend !== '/api/settings/asr-key') throw new Error('语音密钥配置地址不正确。')
    this.asrCredentialsAvailable = options.asrCredentialsBackend === '/api/settings/asr-key' && options.disabledReason !== 'unauthorized'
    if (options.authBackend !== undefined && options.authBackend !== null && options.authBackend !== '/api/auth') throw new Error('账号服务地址不正确。')
    this.authAvailable = options.authBackend === '/api/auth'
    this.configured = options.backend === '/api/session'
    this.textServiceConfigured = options.textBackend === '/api/translate'
    this.credentialsAvailable = options.credentialsBackend === '/api/settings/translation-key' && options.disabledReason !== 'unauthorized'
    this.socket = options.socket || (url => new WebSocket(url))
    this.capture = options.capture || ((chunk, error, signal) => startMicrophone(chunk, error, { signal, platform: 'other' }))
    this.state = { settings: structuredClone(WEB_SETTINGS), state: 'idle', message: this.configured ? '尚未连接' : this.textConfigured ? '文字翻译可用' : this.credentialsAvailable ? '请在字幕设置中配置翻译密钥' : options.disabledReason === 'unauthorized' ? '服务未授权' : '后端未配置', captions: [], partial: {}, collapsed: false }
  }
  snapshot(): Snapshot { return structuredClone(this.state) }
  subscribe(listener: (snapshot: Snapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(): void { for (const listener of this.listeners) listener(this.snapshot()) }

  /** Explicit owner settings action; the key never enters snapshots or browser storage. */
  async configureTranslationKey(apiKey: string): Promise<void> { return this.configureProviderKey(apiKey, false) }
  async configureAsrKey(apiKey: string): Promise<void> { return this.configureProviderKey(apiKey, true) }
  private async configureProviderKey(apiKey: string, asr: boolean): Promise<void> {
    if (!(asr ? this.asrCredentialsAvailable : this.credentialsAvailable) || new URL(this.options.origin).protocol !== 'https:') throw new Error('密钥配置服务不可用。')
    if (this.credentialRequest) throw new Error('正在保存密钥。')
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/u.test(apiKey)) throw new Error('请输入有效密钥。')
    const controller = new AbortController()
    this.credentialRequest = controller
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await (this.options.credentialsFetch || fetch)(new URL(webApiPath(asr ? '/api/settings/asr-key' : '/api/settings/translation-key'), this.options.origin).toString(), {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey })
      })
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '密钥配置未授权。' : '密钥保存未完成。')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 ||
        (result as Record<string, unknown>).configured !== true || controller.signal.aborted) throw new Error('密钥保存未完成。')
      if (asr) return // Saving is not provider verification or permission to capture; refresh to reload readiness.
      this.textServiceConfigured = true
      this.state = { ...this.state, message: this.configured ? this.state.message : '文字翻译可用' }
      this.publish()
    } catch (error) {
      // Never surface raw server/transport errors, which may echo request data.
      if (error instanceof Error && error.message === '密钥配置未授权。') throw error
      throw new Error('密钥保存未完成。')
    } finally {
      clearTimeout(timer)
      if (this.credentialRequest === controller) this.credentialRequest = null
    }
  }

  start(): Promise<void> {
    if (!this.configured) return Promise.reject(new Error('后端未配置，暂不能开始录音。'))
    if (this.owner) return Promise.reject(new Error('请先暂停当前录音。'))
    this.cancelAnnotations()
    const url = new URL(webApiPath('/api/session'), this.options.origin)
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
          } else if (message.type === 'retract') {
            if (!owner.ready) return
            const id = `${owner.id}:${message.id}`
            this.state = { ...this.state, captions: this.state.captions.filter(caption => caption.id !== id || !caption.live || caption.saved) }
            if (!this.state.captions.some(caption => caption.id === id)) { this.cancelAnnotation(id); this.captionRevisions.delete(id) }
            this.publish()
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
            this.cancelAnnotation(id)
            this.captionRevisions.set(id, message.revision)
            owner.ids.set(id, message.caption.id)
            const caption = { ...message.caption, id, saved: current?.saved || false }
            const captions = current ? this.state.captions.map(item => item.id === caption.id ? caption : item) : [...this.state.captions, caption]
            while (captions.length > MAX_WEB_CAPTIONS) {
              const index = captions.findIndex(item => !item.saved)
              if (index < 0) { this.fail(owner, '本页记录已满，请先导出收藏。'); return }
              const [evicted] = captions.splice(index, 1)
              this.cancelAnnotation(evicted.id); this.captionRevisions.delete(evicted.id)
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
    this.cancelAnnotations()
    if (!owner.settled) { owner.settled = true; owner.reject(new Error(message)) }
    this.release(owner)
    this.state = { ...this.state, state: 'error', message }; this.publish()
  }
  stop(): void {
    this.cancelText()
    this.cancelAnnotations()
    const owner = this.owner
    if (owner) { if (owner.socket.readyState === 1) this.send(owner, { version: 1, type: 'stop', sessionId: owner.id }); this.release(owner) }
    this.state = { ...this.state, state: 'idle', message: this.configured ? '已暂停' : this.textConfigured ? '文字翻译可用' : this.credentialsAvailable ? '请在字幕设置中配置翻译密钥' : this.options.disabledReason === 'unauthorized' ? '服务未授权' : '后端未配置' }; this.publish()
  }
  saveSettings(input: SettingsInput): Settings {
    const allowed = ['targetLanguages', 'showOriginal', 'showFurigana', 'fontSize', 'opacity']
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('此设置不适用于网页版。')
    if (input.targetLanguages !== undefined && !validTargetLanguages(input.targetLanguages)) throw new Error('请选择1–8种不重复的字幕语言。')
    for (const key of ['showOriginal', 'showFurigana'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('设置格式不正确。')
    if (input.fontSize !== undefined && (!Number.isFinite(input.fontSize) || input.fontSize < 14 || input.fontSize > 24)) throw new Error('字号须为14–24。')
    if (input.opacity !== undefined && (!Number.isFinite(input.opacity) || input.opacity < 0.45 || input.opacity > 1)) throw new Error('不透明度须为45–100%。')
    const changesTranslation = (input.targetLanguages !== undefined && input.targetLanguages.join('|') !== this.state.settings.targetLanguages.join('|')) || (input.showFurigana !== undefined && input.showFurigana !== this.state.settings.showFurigana)
    if (changesTranslation) { this.cancelText(); if (this.owner) this.stop(); else this.cancelAnnotations() }
    this.state = { ...this.state, settings: { ...this.state.settings, ...input, targetLanguages: [...(input.targetLanguages || this.state.settings.targetLanguages)] } }
    this.publish(); return structuredClone(this.state.settings)
  }
  toggleSaved(id: string): void {
    const caption = this.state.captions.find(item => item.id === id)
    if (!caption || (!caption.saved && (caption.live || caption.translationPending || caption.status !== 'ready'))) throw new Error('请等待这段翻译完成。')
    this.state = { ...this.state, captions: this.state.captions.map(item => item.id === id ? { ...item, saved: !item.saved } : item) }; this.publish()
  }
  retry(id: string): void | Promise<void> {
    const candidate = this.state.captions.find(item => item.id === id)
    if (candidate?.source === 'text') return this.requestText(candidate.original, id)
    if (!this.owner?.ready || this.state.state !== 'listening') throw new Error('请先连接服务，再重试这段翻译。')
    const caption = this.state.captions.find(item => item.id === id)
    if (!caption || caption.live || caption.translationPending) throw new Error('这段尚未定稿。')
    const upstreamId = this.owner.ids.get(id)
    if (!upstreamId) throw new Error('这段属于已结束的连接，仍可复制或收藏。')
    this.cancelAnnotation(id)
    this.state = { ...this.state, captions: this.state.captions.map(item => item === caption ? { ...item, translationPending: true } : item) }
    this.publish()
    this.send(this.owner, { version: 1, type: 'retry', sessionId: this.owner.id, id: upstreamId })
  }
  /** Explicit text only: never acquires media or creates an audio WebSocket. */
  translateText(original: string): Promise<void> { return this.requestText(original) }
  private async requestText(original: string, captionId?: string): Promise<void> {
    if (!this.textConfigured) throw new Error('文字翻译服务尚未配置。')
    if (this.textJob) throw new Error('请等待当前文字翻译完成，或先取消。')
    if (!captionId && this.state.captions.length >= MAX_WEB_CAPTIONS && this.state.captions.every(caption => caption.saved)) throw new Error('本页记录已满，请先导出收藏。')
    const request = parseTextRequest(JSON.stringify({ version: 1, requestId: crypto.randomUUID(), original,
      targetLanguages: [...this.state.settings.targetLanguages], showFurigana: this.state.settings.showFurigana }))
    const job: TextJob = { request, abort: new AbortController(), captionId }
    this.textJob = job
    if (captionId) {
      this.cancelAnnotation(captionId)
      this.state = { ...this.state, captions: this.state.captions.map(caption => caption.id === captionId ? { ...caption, translationPending: true } : caption) }
      this.publish()
    }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; job.abort.abort() }, 60_000)
    try {
      const response = await (this.options.textFetch || fetch)(new URL(webApiPath('/api/translate'), this.options.origin).toString(), {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: job.abort.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
      })
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '文字翻译服务未授权。' : response.status === 429 ? '服务额度已用尽。' : '文字翻译暂不可用。')
      const result = parseTextResponse(await response.text(), request)
      if (this.textJob !== job || job.abort.signal.aborted || (captionId && !this.state.captions.some(caption => caption.id === captionId))) throw textCancelled()
      const id = captionId || `text:${request.requestId}`
      const previous = this.state.captions.find(caption => caption.id === id)
      const caption: Caption = { ...result.caption, id, saved: previous?.saved || false }
      const captions = previous ? this.state.captions.map(item => item.id === id ? caption : item) : [...this.state.captions, caption]
      while (captions.length > MAX_WEB_CAPTIONS) {
        const index = captions.findIndex(item => !item.saved)
        if (index < 0) throw new Error('本页记录已满，请先导出收藏。')
        const [evicted] = captions.splice(index, 1)
        this.cancelAnnotation(evicted.id); this.captionRevisions.delete(evicted.id)
      }
      this.captionRevisions.set(id, (this.captionRevisions.get(id) || 0) + 1)
      this.state = { ...this.state, captions }; this.publish()
    } catch (error) {
      if (this.textJob !== job) throw textCancelled()
      const cancelled = job.abort.signal.aborted
      if (captionId) {
        this.state = { ...this.state, captions: this.state.captions.map(caption => caption.id === captionId ? {
          ...caption, translationPending: false, ...(cancelled ? {} : { status: 'error' as const, error: '这段文字翻译尚未完成。' })
        } : caption) }
        this.publish()
      }
      if (cancelled) { if (timedOut) throw new Error('文字翻译超时，请重试。'); throw textCancelled() }
      throw error
    } finally { clearTimeout(timer); if (this.textJob === job) this.textJob = null }
  }
  cancelText(): void {
    const job = this.textJob
    if (!job) return
    this.textJob = null; job.abort.abort()
    if (job.captionId) {
      this.state = { ...this.state, captions: this.state.captions.map(caption => caption.id === job.captionId ? { ...caption, translationPending: false } : caption) }
      this.publish()
    }
  }
  /** Retained finalized text can be annotated while paused, without an audio socket or capture. */
  async retryAnnotation(id: string): Promise<void> {
    if (!this.configured && !this.textConfigured) throw new Error('注音服务尚未配置完成。')
    if (this.annotations.has(id)) return
    const caption = this.state.captions.find(item => item.id === id)
    const text = caption && annotationText(caption), revision = this.captionRevisions.get(id)
    if (!caption || !text || !revision || !this.state.settings.showFurigana || !this.state.settings.targetLanguages.includes('ja') || caption.furiganaStatus === 'pending') throw new Error('请等待日语译文定稿后重试注音。')
    if (this.annotations.size >= 2) throw new Error('注音请求较多，请稍后重试。')
    const job: AnnotationJob = { abort: new AbortController(), epoch: this.annotationEpoch, request: {
      version: 1, type: 'annotation', requestId: crypto.randomUUID(), sessionId: this.annotationSession,
      captionId: id, sourceRevision: revision, language: 'ja', ...text
    } }
    this.annotations.set(id, job)
    this.state = { ...this.state, captions: this.state.captions.map(item => item.id === id ? { ...item, furiganaStatus: 'pending' } : item) }; this.publish()
    try {
      const result = await requestAnnotation(job.request, this.options.origin, job.abort.signal, this.options.annotationFetch, webApiPath(caption.source === 'microphone' ? '/api/audio-annotation' : '/api/annotation'))
      if (!this.annotationCurrent(job)) throw annotationCancelled()
      this.state = { ...this.state, captions: this.state.captions.map(item => item.id === id ? { ...item, reading: result.reading, jaSegments: result.jaSegments, furiganaStatus: 'ready' } : item) }
    } catch (error) {
      if (!this.annotationCurrent(job)) throw annotationCancelled()
      this.state = { ...this.state, captions: this.state.captions.map(item => item.id === id ? { ...item, furiganaStatus: 'error' } : item) }
      throw error
    } finally {
      if (this.annotations.get(id) === job) { this.annotations.delete(id); this.publish() }
    }
  }
  private annotationCurrent(job: AnnotationJob): boolean {
    const { captionId, sourceRevision, original, japanese } = job.request
    const caption = this.state.captions.find(item => item.id === captionId), text = caption && annotationText(caption)
    return !job.abort.signal.aborted && job.epoch === this.annotationEpoch && this.annotations.get(captionId) === job &&
      this.captionRevisions.get(captionId) === sourceRevision && text?.original === original && text.japanese === japanese &&
      this.state.settings.showFurigana && this.state.settings.targetLanguages.includes('ja')
  }
  private cancelAnnotation(id: string): void {
    const job = this.annotations.get(id)
    if (!job) return
    this.annotations.delete(id); job.abort.abort()
    this.state = { ...this.state, captions: this.state.captions.map(item => item.id === id && item.furiganaStatus === 'pending' ? { ...item, furiganaStatus: 'error' } : item) }
  }
  private cancelAnnotations(): void {
    const changed = this.annotations.size > 0
    this.annotationEpoch++; this.annotationSession = crypto.randomUUID()
    for (const id of [...this.annotations.keys()]) this.cancelAnnotation(id)
    if (changed) this.publish()
  }
  dispose(): void { this.credentialRequest?.abort(); this.stop(); this.listeners.clear() }
}
