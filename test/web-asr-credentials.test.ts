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
