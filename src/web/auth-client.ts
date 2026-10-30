export interface AuthStatus { kind: 'anonymous' | 'owner' | 'account' | 'guest'; role?: 'admin' | 'user'; username?: string; initialized: boolean; bootstrapAllowed: boolean }
export interface AccountSummary { username: string; role: 'admin' | 'user'; limitMicroCny: number }
type AuthAction = 'status' | 'login' | 'guest' | 'logout' | 'bootstrap' | 'accounts'
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** Fixed same-origin endpoints, ephemeral request bodies, redacted errors. No browser persistence. */
export async function authRequest(origin: string, action: AuthAction, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', body: unknown, signal: AbortSignal, transport: typeof fetch = fetch): Promise<unknown> {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password || !['status', 'login', 'guest', 'logout', 'bootstrap', 'accounts'].includes(action)) throw new Error('账号服务不可用。')
  const controller = new AbortController(), abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15_000)
  try {
    if (signal.aborted) throw new Error()
    const response = await transport(new URL('/api/auth/' + action, url.origin), { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
      ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    if (!response.ok || controller.signal.aborted) throw new Error()
    const text = await response.text()
    if (controller.signal.aborted || text.length > 16_384) throw new Error()
    const value: unknown = JSON.parse(text)
    if (!object(value)) throw new Error()
    if (action === 'status') {
      if (!['anonymous', 'owner', 'account', 'guest'].includes(value.kind as string) || typeof value.initialized !== 'boolean' || typeof value.bootstrapAllowed !== 'boolean' ||
        Object.keys(value).some(key => !['kind', 'role', 'username', 'initialized', 'bootstrapAllowed'].includes(key)) ||
        value.role !== undefined && !['admin', 'user'].includes(value.role as string) || value.username !== undefined && (typeof value.username !== 'string' || value.username.length > 64)) throw new Error()
    } else if (action === 'accounts' && method === 'GET') {
      if (Object.keys(value).join(',') !== 'accounts' || !Array.isArray(value.accounts) || value.accounts.length > 100 || value.accounts.some(account => !object(account) ||
        Object.keys(account).some(key => !['username', 'role', 'limitMicroCny'].includes(key)) || typeof account.username !== 'string' || account.username.length > 64 ||
        !['admin', 'user'].includes(account.role as string) || !Number.isSafeInteger(account.limitMicroCny) || (account.limitMicroCny as number) < 0)) throw new Error()
    } else if (Object.keys(value).join(',') !== 'ok' || value.ok !== true) throw new Error()
    return value
  } catch { throw new Error(signal.aborted ? '已取消账号操作。' : '账号操作未完成，请检查输入、权限或服务配置。') }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort() }
}

/** Exact decimal CNY conversion; never round a user's quota upward. */
export function quotaMicroCny(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/u.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  return amount <= 100_000_000 ? amount : null
}
