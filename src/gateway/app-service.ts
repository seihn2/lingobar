import { createTextHandler } from './text'
import { createAnnotationHandler } from '../worker/annotation'
import { quoteWebTextRequest } from './text-budget'
import { AccountBudget } from './account-budget'
import type { AppAuth, Principal } from './app-auth'
import type { GatewayConfig } from './config'
import { RelayError, type RelayConfig, type WorkerFetch } from '../worker/types'

const ASR = 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'
export const APP_SESSION_LIMITS = { durationMs: 60_000, audioBytes: 1_920_000 }
/** Application sessions have their own funding policy. Never use either owner
 * test ledger. BYOK is explicitly the guest's provider bill, not the owner's ¥1. */
export class AppService {
  private inFlight = new Map<string, number>()
  constructor(private config: GatewayConfig, private auth: AppAuth, private budget: AccountBudget,
    private upstream: WorkerFetch, private now = Date.now) {}
  keys(p: Principal): RelayConfig {
    return { translationKey: p.kind === 'guest' ? p.translationKey : this.config.translationKey,
      asrKey: p.kind === 'guest' ? p.asrKey : this.config.asrKey, model: 'qwen3-asr-flash-realtime' }
  }
  audioStatus(p: Principal): 'ready' | 'missing-key' | 'budget-unverified' | 'quota' {
    const keys = this.keys(p)
    if (!keys.asrKey || !keys.translationKey) return 'missing-key'
    if (p.kind === 'account' && !this.config.app?.sharedAudioFreeStopVerified) return 'budget-unverified'
    if (p.kind === 'account' && this.budget.remaining(p.id, p.limitMicroCny) === 0) return 'quota'
    return 'ready'
  }
  publicConfig(p: Principal) {
    return { version: 1, backend: this.audioStatus(p) === 'ready' ? '/api/session' : null,
      textBackend: this.keys(p).translationKey && (p.kind === 'guest' || this.budget.remaining(p.id, p.limitMicroCny) > 0) ? '/api/translate' : null,
      authBackend: '/api/auth', audioStatus: this.audioStatus(p) }
  }
  valid(p: Principal, cookie: string | undefined): boolean {
    const current = this.auth.resolve(cookie)
    return current?.id === p.id && current.expiresAt === p.expiresAt && p.expiresAt > this.now()
  }
  transport(p: Principal, cookie: string | undefined): WorkerFetch {
    const completion = p.kind === 'account' ? this.budget.fetch(p.id, p.limitMicroCny, this.upstream) : this.upstream
    return async (input, init) => {
      if (!this.valid(p, cookie) || init?.signal?.aborted) throw new RelayError('unauthorized')
      if (String(input) === ASR) {
        if (this.audioStatus(p) !== 'ready' || new Headers(init?.headers).get('Upgrade') !== 'websocket' || init?.body != null || init?.method && init.method !== 'GET') throw new RelayError('unavailable')
        return this.upstream(input, init)
      }
      const quote = quoteWebTextRequest(input, init)
      return completion(input, quote.request)
    }
  }
  async request(request: Request, p: Principal): Promise<Response> {
    const cookie = request.headers.get('cookie') || undefined
    if (!this.valid(p, cookie)) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const count = this.inFlight.get(p.id) || 0
    if (count >= 1) return Response.json({ error: 'quota' }, { status: 429 })
    const keys = this.keys(p)
    if (!keys.translationKey) return Response.json({ error: 'unavailable' }, { status: 503 })
    const path = new URL(request.url).pathname
    if (!['/api/translate', '/api/annotation', '/api/audio-annotation'].includes(path) || request.method !== 'POST') return Response.json({ error: 'protocol' }, { status: 404 })
    this.inFlight.set(p.id, count + 1)
    try {
      const transport = this.transport(p, cookie)
      if (path === '/api/translate') return await createTextHandler(keys.translationKey, transport, { now: this.now })(request)
      const normalized = path === '/api/audio-annotation' ? new Request(new URL('/api/annotation', request.url), request) : request
      return await createAnnotationHandler(transport)(normalized, { WEB_ENABLED: '1', TRANSLATION_API_KEY: keys.translationKey,
        AUTH_SERVICE: { fetch: async () => new Response(null, { status: this.valid(p, cookie) ? 204 : 401 }) } })
    } finally { this.inFlight.delete(p.id) }
  }
}
