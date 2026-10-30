import { AppAuth } from './app-auth'

const json = (value: unknown, status = 200, cookie?: string) => new Response(JSON.stringify(value), { status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cookie ? { 'Set-Cookie': cookie } : {})
} })
const failure = (status: number) => json({ error: status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'quota' : status === 503 ? 'unavailable' : 'protocol' }, status)
const shape = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k))
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' || !request.body) throw new Error()
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', size = 0
  try {
    while (true) {
      if (request.signal.aborted) throw new Error()
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 8192) throw new Error()
      text += decoder.decode(next.value, { stream: true })
    }
    text += decoder.decode()
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** The gateway MUST enforce trusted Host/same-origin mutation boundaries and derive
 * ownerVerified solely from its existing Access signature/issuer/audience/owner check.
 * No cookie, body field or publicly elected first account can authorize bootstrap. */
export function createAppAuthHandler(auth: AppAuth, options: { now?: () => number } | (() => number) = {}) {
  const now = typeof options === 'function' ? options : options.now || Date.now
  let windowAt = now(), loginAttempts = 0, guestWindowAt = now(), guestAttempts = 0
  return async (request: Request, ownerVerified: boolean | (() => boolean)): Promise<Response> => {
    const owner = () => typeof ownerVerified === 'function' ? ownerVerified() : ownerVerified
    try {
      const url = new URL(request.url), path = url.pathname
      const methods: Record<string, string[]> = {
        '/api/auth/status': ['GET'], '/api/auth/login': ['POST'], '/api/auth/guest': ['POST'], '/api/auth/logout': ['POST'],
        '/api/auth/bootstrap': ['POST'], '/api/auth/accounts': ['GET', 'POST', 'PATCH', 'DELETE']
      }
      if (url.search || !Object.hasOwn(methods, path)) return failure(404)
      if (!methods[path].includes(request.method)) return failure(405)
      if (request.signal.aborted) return failure(503)
      let principal = auth.resolve(request.headers.get('Cookie') || undefined)
      if (path === '/api/auth/status') return json({
        kind: owner() ? 'owner' : principal?.kind || 'anonymous',
        ...(owner() ? { role: 'admin' } : principal ? { role: principal.role, ...(principal.kind === 'account' ? { username: principal.username } : {}) } : {}),
        initialized: auth.initialized, bootstrapAllowed: owner() && !auth.initialized
      })
      if (path === '/api/auth/bootstrap' && !owner()) return failure(403)
      if (path === '/api/auth/accounts' && !owner() && !(principal?.kind === 'account' && principal.role === 'admin')) return failure(403)
      if (path === '/api/auth/accounts' && request.method === 'GET') {
        return json({ accounts: auth.listAccounts().map(({ username, role, limitMicroCny }) => ({ username, role, limitMicroCny })) })
      }
      let input: Record<string, unknown>
      try { input = await body(request) } catch { return failure(400) }
      if (request.signal.aborted) return failure(503)
      // Body upload can outlive logout, expiry or an administrator's revocation.
      // Re-authorize against the current session immediately before mutations.
      principal = auth.resolve(request.headers.get('Cookie') || undefined)
      if (path === '/api/auth/bootstrap' && !owner()) return failure(403)
      if (path === '/api/auth/accounts' && !owner() && !(principal?.kind === 'account' && principal.role === 'admin')) return failure(403)
      if (path === '/api/auth/login') {
        if (!shape(input, ['username', 'password']) || typeof input.username !== 'string' || typeof input.password !== 'string') return failure(400)
        if (now() - windowAt >= 60_000) { windowAt = now(); loginAttempts = 0 }
        if (++loginAttempts > 10) return failure(429)
        try {
          const session = await auth.login(input.username, input.password)
          if (request.signal.aborted) { auth.logout(session.cookie); return failure(503) }
          auth.logout(request.headers.get('Cookie') || undefined)
          return json({ ok: true }, 200, session.cookie)
        } catch (error) { return failure(error instanceof Error && error.message === 'Invalid account credentials' ? 401 : 503) }
      }
      if (path === '/api/auth/guest') {
        if (!shape(input, ['translationKey', 'acceptCharges'], ['asrKey']) || typeof input.translationKey !== 'string' || input.acceptCharges !== true || input.asrKey !== undefined && typeof input.asrKey !== 'string') return failure(400)
        if (now() - guestWindowAt >= 60_000) { guestWindowAt = now(); guestAttempts = 0 }
        if (++guestAttempts > 10) return failure(429)
        const session = auth.guest({ translationKey: input.translationKey, asrKey: input.asrKey as string | undefined, acceptCharges: true })
        // Replacing an existing browser session revokes its old key material/token.
        auth.logout(request.headers.get('Cookie') || undefined)
        return json({ ok: true }, 200, session.cookie)
      }
      if (path === '/api/auth/logout') {
        if (!shape(input, [])) return failure(400)
        return json({ ok: true }, 200, auth.logout(request.headers.get('Cookie') || undefined).cookie)
      }
      if (path === '/api/auth/bootstrap') {
        if (!shape(input, ['username', 'password']) || typeof input.username !== 'string' || typeof input.password !== 'string') return failure(400)
        if (auth.initialized) return failure(403)
        await auth.bootstrap(input.username, input.password)
        return json({ ok: true })
      }
      if (request.method === 'POST') {
        // Explicit administrator grants remain bounded by the independent site cap;
        // omitted allowance is always zero.
        if (!shape(input, ['username', 'password'], ['limitMicroCny']) || typeof input.username !== 'string' || typeof input.password !== 'string' || input.limitMicroCny !== undefined && (!Number.isSafeInteger(input.limitMicroCny) || (input.limitMicroCny as number) < 0 || (input.limitMicroCny as number) > 100_000_000)) return failure(400)
        await auth.createAccount(input.username, input.password, 'user', (input.limitMicroCny as number | undefined) ?? 0)
        return json({ ok: true })
      }
      if (request.method === 'PATCH') {
        if (!shape(input, ['username', 'limitMicroCny']) || typeof input.username !== 'string' || !Number.isSafeInteger(input.limitMicroCny) || (input.limitMicroCny as number) < 0 || (input.limitMicroCny as number) > 100_000_000) return failure(400)
        auth.setAccountLimit(input.username, input.limitMicroCny as number)
        return json({ ok: true })
      }
      if (!shape(input, ['username']) || typeof input.username !== 'string') return failure(400)
      const target = auth.listAccounts().find(a => a.username.toLowerCase() === (input.username as string).toLowerCase())
      if (!target || target.role === 'admin' || principal?.kind === 'account' && target.id === principal.id) return failure(403)
      auth.removeAccount(target.username)
      return json({ ok: true })
    } catch { return failure(503) }
  }
}
