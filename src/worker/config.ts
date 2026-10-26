import type { AsrModel, RelayConfig } from './types'

export interface Binding { fetch(request: Request): Promise<Response> }
export interface WorkerEnv {
  WEB_ENABLED?: string
  ASR_API_KEY?: string
  TRANSLATION_API_KEY?: string
  ASR_MODEL?: string
  AUTH_SERVICE?: Binding
  ASSETS?: Binding
}
const MODELS: readonly AsrModel[] = ['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'qwen3-asr-flash-realtime']
const key = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value)
/** These are future server bindings, never files/process.env or browser configuration. */
export function serverConfig(env: WorkerEnv): RelayConfig | null {
  const model = env.ASR_MODEL || MODELS[0]
  if (env.WEB_ENABLED !== '1' || !env.AUTH_SERVICE || typeof env.AUTH_SERVICE.fetch !== 'function' ||
    !key(env.ASR_API_KEY) || !key(env.TRANSLATION_API_KEY) || !MODELS.includes(model as AsrModel)) return null
  return { asrKey: env.ASR_API_KEY.trim(), translationKey: env.TRANSLATION_API_KEY.trim(), model: model as AsrModel }
}
/** An internal service binding must verify identity and access policy; raw request headers are not proof. */
export async function authorized(request: Request, binding: Binding): Promise<boolean> {
  const controller = new AbortController()
  let expire!: () => void
  const deadline = new Promise<Response>(resolve => { expire = () => { controller.abort(); resolve(new Response(null, { status: 408 })) } })
  const timer = setTimeout(expire, 3000)
  const cancel = () => expire()
  request.signal.addEventListener('abort', cancel, { once: true })
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const name of ['Cookie', 'Cf-Access-Jwt-Assertion']) {
    const value = request.headers.get(name)
    if (value) { if (value.length > 8192) { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); return false }; headers.set(name, value) }
  }
  try {
    if (request.signal.aborted) return false
    const response = await Promise.race([deadline, binding.fetch(new Request('https://auth.internal/authorize', {
      method: 'POST', headers, body: JSON.stringify({ origin: new URL(request.url).origin, path: '/api/session' }),
      redirect: 'error', signal: controller.signal
    }))])
    void response.body?.cancel().catch(() => {})
    return !controller.signal.aborted && !request.signal.aborted && response.status === 204
  } catch { return false }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel) }
}
