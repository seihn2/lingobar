import { afterEach, describe, expect, it, vi } from 'vitest'
import { authRequest, quotaMicroCny } from '../src/web/auth-client'
import { BrowserSession } from '../src/web/session'
import { parseWebConfig } from '../src/web/config'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const origin = 'https://lingobar.example', secret = 'synthetic-secret-not-real'
const anonymous = { kind: 'anonymous', initialized: false, bootstrapAllowed: false }
describe('ephemeral browser account and BYOK client', () => {
  it('converts exact micro-CNY quotas without rounding and caps at 100 CNY', () => {
    for (const [value, expected] of [['0', 0], ['0.000001', 1], ['1.234567', 1234567], ['100', 100000000]] as const) expect(quotaMicroCny(value)).toBe(expected)
    for (const value of ['-1', '101', '100.000001', '1.0000001', '1e2', '', ' 1']) expect(quotaMicroCny(value)).toBe(null)
  })

  it('sends quota changes only to the fixed account endpoint with exact integer micro-CNY', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
    await authRequest(origin, 'accounts', 'PATCH', { username: 'synthetic-user', limitMicroCny: quotaMicroCny('1.234567') }, new AbortController().signal, transport)
    expect(String(transport.mock.calls[0][0])).toBe(origin + '/api/auth/accounts')
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ username: 'synthetic-user', limitMicroCny: 1234567 }) })
  })
  it('accepts only the fixed optional auth backend without enabling capture', async () => {
    expect(parseWebConfig({ version: 1, backend: null, authBackend: '/api/auth' })).toEqual({ backend: null, authBackend: '/api/auth' })
    expect(() => parseWebConfig({ version: 1, backend: null, authBackend: 'https://attacker.example' })).toThrow()
    const capture = vi.fn(), socket = vi.fn()
    const s = new BrowserSession({ backend: null, origin, authBackend: '/api/auth', capture, socket })
    expect(s.authAvailable).toBe(true); expect(s.audioStatusMessage).toBe('请登录或使用自己的 API Key')
    await expect(s.start()).rejects.toThrow(); expect(capture).not.toHaveBeenCalled(); expect(socket).not.toHaveBeenCalled(); s.dispose()
  })
  it('uses same-origin cookie auth and never persists BYOK/password values', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage)
    for (const [action, body] of [['login', { username: 'synthetic', password: secret }], ['guest', { translationKey: secret, asrKey: secret, acceptCharges: true }], ['bootstrap', { username: 'synthetic', password: secret }], ['logout', {}]] as const) {
      const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
      expect(await authRequest(origin, action, 'POST', body, new AbortController().signal, transport)).toEqual({ ok: true })
      expect(String(transport.mock.calls[0][0])).toBe(origin + '/api/auth/' + action)
      expect(transport.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store', method: 'POST', body: JSON.stringify(body) })
    }
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('returns only validated status and account summaries', async () => {
    expect(await authRequest(origin, 'status', 'GET', undefined, new AbortController().signal, async () => Response.json(anonymous))).toEqual(anonymous)
    const accounts = { accounts: [{ username: 'synthetic', role: 'user', limitMicroCny: 0 }] }
    expect(await authRequest(origin, 'accounts', 'GET', undefined, new AbortController().signal, async () => Response.json(accounts))).toEqual(accounts)
    for (const bad of [{ ...anonymous, password: secret }, { ...anonymous, kind: 'invented' }, { ...anonymous, username: secret.repeat(100) }]) {
      await expect(authRequest(origin, 'status', 'GET', undefined, new AbortController().signal, async () => Response.json(bad))).rejects.toThrow('账号操作未完成')
    }
  })
  it('redacts response/transport errors and rejects key echoes', async () => {
    for (const transport of [async () => { throw new Error(secret) }, async () => new Response(secret, { status: 401 }), async () => Response.json({ ok: true, translationKey: secret })]) {
      const failure = await authRequest(origin, 'guest', 'POST', { translationKey: secret, acceptCharges: true }, new AbortController().signal, transport).catch(error => error)
      expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).not.toContain(secret)
    }
  })
  it('rejects arbitrary routes and HTTP before transmitting, and cancels without retry', async () => {
    const transport = vi.fn<typeof fetch>()
    await expect(authRequest('http://localhost', 'login', 'POST', {}, new AbortController().signal, transport)).rejects.toThrow()
    await expect(authRequest(origin, '../other' as 'login', 'POST', {}, new AbortController().signal, transport)).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
    vi.useFakeTimers()
    const controller = new AbortController()
    const waiting = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error(secret)))))
    const pending = authRequest(origin, 'login', 'POST', { password: secret }, controller.signal, waiting)
    const rejected = expect(pending).rejects.toThrow('已取消账号操作')
    controller.abort(); await rejected
    expect(waiting).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
})
