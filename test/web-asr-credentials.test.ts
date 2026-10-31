import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSession } from '../src/web/session'
import { parseWebConfig } from '../src/web/config'

const DUMMY = 'synthetic-only-not-an-actual-provider-key'
const sessions = new Set<BrowserSession>()
function fixture(transport: typeof fetch, options: Partial<ConstructorParameters<typeof BrowserSession>[0]> = {}) {
  const socket = vi.fn(() => { throw new Error('Audio socket forbidden') })
  const capture = vi.fn(async () => { throw new Error('Microphone forbidden') })
  const session = new BrowserSession({ backend: null, textBackend: '/api/translate',
    asrCredentialsBackend: '/api/settings/asr-key', audioStatus: 'budget-unverified',
    origin: 'https://lingobar.example', credentialsFetch: transport, socket, capture, ...options })
  sessions.add(session)
  return { session, socket, capture }
}
afterEach(() => { for (const s of sessions) s.dispose(); sessions.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('owner ASR configuration', () => {
  it('accepts only fixed metadata, without treating readiness text as capture capability', async () => {
    expect(parseWebConfig({ version: 1, backend: null, asrCredentialsBackend: '/api/settings/asr-key', audioStatus: 'ready' }))
      .toEqual({ backend: null, asrCredentialsBackend: '/api/settings/asr-key', audioStatus: 'ready' })
    for (const extra of [{ asrCredentialsBackend: 'https://other.example/key' }, { audioStatus: 'unknown' }, { apiKey: DUMMY }]) {
      expect(() => parseWebConfig({ version: 1, backend: null, ...extra })).toThrow()
    }
    const f = fixture(vi.fn(), { audioStatus: 'ready' })
    await expect(f.session.start()).rejects.toThrow('暂不能开始录音')
    expect(f.capture).not.toHaveBeenCalled()
  })
  it('saves once with no storage, snapshot disclosure, provider call or automatic capture', async () => {
    const transport = vi.fn(async () => new Response('{"configured":true}'))
    const storage = { setItem: vi.fn(), getItem: vi.fn() }; vi.stubGlobal('localStorage', storage)
    const f = fixture(transport), snapshots: string[] = []
    f.session.subscribe(s => snapshots.push(JSON.stringify(s)))
    await f.session.configureAsrKey(DUMMY)
    expect(transport).toHaveBeenCalledOnce()
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://lingobar.example/api/settings/asr-key')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: DUMMY })
    expect(f.session.configured).toBe(false); expect(f.session.textConfigured).toBe(true)
    expect(f.session.audioStatusMessage).toContain('费用上界尚未核实')
    expect(snapshots.join('') + JSON.stringify(f.session.snapshot())).not.toContain(DUMMY)
    expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled()
    expect(f.capture).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled()
  })
  it('requires capability, owner authorization and HTTPS', async () => {
    const transport = vi.fn()
    for (const options of [{ asrCredentialsBackend: null }, { disabledReason: 'unauthorized' as const }, { origin: 'http://localhost' }]) {
      await expect(fixture(transport, options).session.configureAsrKey(DUMMY)).rejects.toThrow('不可用')
    }
    expect(transport).not.toHaveBeenCalled()
  })
  it('suppresses raw errors and echoed key responses', async () => {
    for (const transport of [vi.fn(async () => { throw new Error(DUMMY) }), vi.fn(async () => new Response(JSON.stringify({ configured: true, apiKey: DUMMY })))]) {
      const f = fixture(transport)
      await expect(f.session.configureAsrKey(DUMMY)).rejects.toThrow('密钥保存未完成')
      expect(f.session.configured).toBe(false)
    }
  })
  it('blocks duplicate saves and aborts without retry on disposal', async () => {
    const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(DUMMY)))
    }))
    const f = fixture(transport), pending = f.session.configureAsrKey(DUMMY)
    const rejected = expect(pending).rejects.toThrow('密钥保存未完成')
    await expect(f.session.configureAsrKey(DUMMY)).rejects.toThrow('正在保存')
    f.session.dispose(); await rejected
    expect(transport).toHaveBeenCalledOnce()
  })
})

describe('persisted provider key presence on refresh (synthetic server only)', () => {
  const readError = '密钥状态读取失败，请重试；这不代表已保存的密钥被删除。'
  it.each([true, false])('reads the exact boolean %s via bodyless same-origin GET without changing capability', async configured => {
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ configured })))
    const f = fixture(transport), before = f.session.snapshot()
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).resolves.toBe(configured)
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe('https://lingobar.example/api/settings/asr-key')
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    expect(init).not.toHaveProperty('body'); expect(init).not.toHaveProperty('headers')
    expect(f.session.snapshot()).toEqual(before); expect(f.session.configured).toBe(false)
    expect(f.capture).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled()
  })
  it('uses owner-prefixed routes for both providers, without retrieving a mask', async () => {
    vi.stubGlobal('location', { pathname: '/owner/' })
    const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{"configured":true}'))
    const f = fixture(transport, { credentialsBackend: '/api/settings/translation-key' })
    await f.session.readProviderKeyStatus(true, new AbortController().signal)
    await f.session.readProviderKeyStatus(false, new AbortController().signal)
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'https://lingobar.example/owner/api/settings/asr-key',
      'https://lingobar.example/owner/api/settings/translation-key'
    ])
  })
  it('reloads presence after POST in a brand-new session without retaining the input or touching storage', async () => {
    let configured = false
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { expect(JSON.parse(init.body as string)).toEqual({ apiKey: DUMMY }); configured = true }
      return new Response(JSON.stringify({ configured }))
    })
    const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage)
    const first = fixture(transport), snapshots: string[] = []
    first.session.subscribe(s => snapshots.push(JSON.stringify(s)))
    await expect(first.session.readProviderKeyStatus(true, new AbortController().signal)).resolves.toBe(false)
    await first.session.configureAsrKey(DUMMY)
    first.session.dispose()
    const refreshed = fixture(transport)
    refreshed.session.subscribe(s => snapshots.push(JSON.stringify(s)))
    await expect(refreshed.session.readProviderKeyStatus(true, new AbortController().signal)).resolves.toBe(true)
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET'])
    expect(JSON.stringify(refreshed.session.snapshot()) + snapshots.join('')).not.toContain(DUMMY)
    // The input belongs only to the caller and the POST, not a session field.
    expect(Object.values(first.session).some(value => value === DUMMY)).toBe(false)
    expect(Object.values(refreshed.session).some(value => value === DUMMY)).toBe(false)
    for (const spy of Object.values(storage)) expect(spy).not.toHaveBeenCalled()
    for (const f of [first, refreshed]) {
      expect(f.capture).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled()
      expect(f.session.configured).toBe(false)
    }
  })
  it.each([401, 403, 500])('treats HTTP %s as retryable unknown, never as absent', async status => {
    const transport = vi.fn().mockResolvedValueOnce(new Response(DUMMY, { status }))
      .mockResolvedValueOnce(new Response('{"configured":true}'))
    const f = fixture(transport)
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).rejects.toThrow(readError)
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).resolves.toBe(true)
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it.each([
    JSON.stringify({ configured: true, apiKey: DUMMY }), '{"configured":true,"mask":"secret"}',
    '{"configured":"true"}', '{"configured":null}', '{}', 'null', '[]', 'true', DUMMY,
    ' '.repeat(65) + '{"configured":true}'
  ])('rejects malformed or secret-bearing status without echoing it: %s', async body => {
    const f = fixture(vi.fn(async () => new Response(body)))
    const error = await f.session.readProviderKeyStatus(true, new AbortController().signal).catch(e => e)
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe(readError)
    expect(JSON.stringify(f.session.snapshot())).not.toContain(DUMMY)
  })
  it('sanitizes raw transport errors and permits a subsequent read', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new Error(DUMMY)).mockResolvedValueOnce(new Response('{"configured":false}'))
    const f = fixture(transport)
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).rejects.toThrow(readError)
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).resolves.toBe(false)
  })
  it('does not dispatch for already aborted signals, and propagates later cancellation to fetch', async () => {
    const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(DUMMY)), { once: true })
    }))
    const f = fixture(transport), before = new AbortController(); before.abort()
    await expect(f.session.readProviderKeyStatus(true, before.signal)).rejects.toThrow(readError)
    expect(transport).not.toHaveBeenCalled()
    const during = new AbortController(), pending = f.session.readProviderKeyStatus(true, during.signal)
    const rejected = expect(pending).rejects.toThrow(readError)
    during.abort(); await rejected
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(f.capture).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled()
  })
  it('accepts at most 64 response characters and checks cancellation after reading the body', async () => {
    const valid = '{"configured":true}'
    const transport = vi.fn().mockResolvedValueOnce(new Response(valid.padEnd(64)))
      .mockResolvedValueOnce(new Response(valid.padEnd(65)))
    const f = fixture(transport)
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).resolves.toBe(true)
    await expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).rejects.toThrow(readError)
    const abort = new AbortController()
    const response = new Response(valid)
    vi.spyOn(response, 'text').mockImplementation(async () => { abort.abort(); return valid })
    transport.mockResolvedValueOnce(response)
    await expect(f.session.readProviderKeyStatus(true, abort.signal)).rejects.toThrow(readError)
  })
  it('times out a stalled status request without changing key presence or retrying automatically', async () => {
    vi.useFakeTimers()
    const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(DUMMY)), { once: true })
    }))
    const f = fixture(transport), before = f.session.snapshot()
    const pending = expect(f.session.readProviderKeyStatus(true, new AbortController().signal)).rejects.toThrow(readError)
    await vi.advanceTimersByTimeAsync(15_000); await pending
    expect(transport).toHaveBeenCalledOnce()
    expect(f.session.snapshot()).toEqual(before)
  })
  it('rejects disabled or missing provider capability without a request', async () => {
    const transport = vi.fn()
    for (const options of [{ asrCredentialsBackend: null }, { disabledReason: 'unauthorized' as const }, { origin: 'http://localhost' }]) {
      await expect(fixture(transport, options).session.readProviderKeyStatus(true, new AbortController().signal)).rejects.toThrow('不可用')
    }
    await expect(fixture(transport).session.readProviderKeyStatus(false, new AbortController().signal)).rejects.toThrow('不可用')
    expect(transport).not.toHaveBeenCalled()
  })
})
