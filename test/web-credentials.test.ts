import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSession } from '../src/web/session'
import { loadWebConfig, parseWebConfig } from '../src/web/config'

const DUMMY = 'synthetic-only-not-an-actual-provider-key'
const sessions = new Set<BrowserSession>()
function fixture(transport: typeof fetch, options: { textBackend?: '/api/translate' | null; credentialsBackend?: '/api/settings/translation-key' | null; origin?: string; disabledReason?: 'unauthorized' } = {}) {
  const socket = vi.fn(() => { throw new Error('Audio socket forbidden') })
  const capture = vi.fn(async () => { throw new Error('Real microphone forbidden') })
  const session = new BrowserSession({ backend: null, textBackend: null,
    credentialsBackend: '/api/settings/translation-key', origin: 'https://lingobar.example',
    credentialsFetch: transport, socket, capture, ...options })
  sessions.add(session)
  return { session, socket, capture }
}
afterEach(() => {
  for (const session of sessions) session.dispose()
  sessions.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('explicit owner DeepSeek configuration', () => {
  it('distinguishes owner setup from missing service routes before and after suspension', async () => {
    const transport = vi.fn()
    for (const [options, message, settingsAvailable] of [
      [{}, '请在字幕设置中配置翻译密钥', true],
      [{ textBackend: '/api/translate' as const }, '文字翻译可用', true],
      [{ credentialsBackend: null }, '后端未配置', false],
      [{ disabledReason: 'unauthorized' as const }, '服务未授权', false]
    ] as const) {
      const f = fixture(transport, options)
      expect(f.session.snapshot().message).toBe(message)
      expect(f.session.credentialsAvailable).toBe(settingsAvailable)
      f.session.stop()
      expect(f.session.snapshot().message).toBe(message)
      await expect(f.session.start()).rejects.toThrow('暂不能开始录音')
      expect(f.socket).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
    }
    expect(transport).not.toHaveBeenCalled()
  })
  it('keeps legacy public config compatible and accepts only the fixed optional owner route', async () => {
    expect(parseWebConfig({ version: 1, backend: null })).toEqual({ backend: null })
    const publicConfig = { version: 1, backend: null, textBackend: null, credentialsBackend: '/api/settings/translation-key' }
    const transport = vi.fn(async () => new Response(JSON.stringify(publicConfig)))
    vi.stubGlobal('fetch', transport)
    expect(await loadWebConfig()).toEqual({ backend: null, textBackend: null, credentialsBackend: '/api/settings/translation-key' })
    expect(transport).toHaveBeenCalledWith('/app-config.json', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    for (const route of ['https://elsewhere.example/key', '/api/arbitrary', true]) {
      expect(() => parseWebConfig({ ...publicConfig, credentialsBackend: route })).toThrow()
    }
    expect(() => parseWebConfig({ ...publicConfig, apiKey: DUMMY })).toThrow()
  })
  it('does not submit for missing capability, known unauthorized state or plain HTTP', async () => {
    const transport = vi.fn()
    for (const options of [{ credentialsBackend: null }, { disabledReason: 'unauthorized' as const }, { origin: 'http://localhost' }]) {
      const f = fixture(transport, options)
      await expect(f.session.configureTranslationKey(DUMMY)).rejects.toThrow('不可用')
      expect(f.socket).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
    }
    expect(transport).not.toHaveBeenCalled()
  })
  it('posts once over same-origin HTTPS and enables text without exposing the key or using audio/storage', async () => {
    const transport = vi.fn(async () => new Response('{"configured":true}'))
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', storage)
    const log = vi.spyOn(console, 'log')
    const f = fixture(transport), updates: string[] = []
    f.session.subscribe(snapshot => updates.push(JSON.stringify(snapshot)))
    expect(f.session.textConfigured).toBe(false)
    await f.session.configureTranslationKey(DUMMY)
    expect(transport).toHaveBeenCalledOnce()
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://lingobar.example/api/settings/translation-key')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: DUMMY })
    expect(f.session.textConfigured).toBe(true); expect(f.session.configured).toBe(false)
    expect(f.session.snapshot().message).toBe('文字翻译可用')
    f.session.stop()
    expect(f.session.snapshot().message).toBe('文字翻译可用')
    expect(JSON.stringify(f.session.snapshot()) + updates.join('')).not.toContain(DUMMY)
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
  })
  it('reports fixed errors instead of request data or raw service errors and does not enable text on failure', async () => {
    for (const transport of [
      vi.fn(async () => { throw new Error(DUMMY) }),
      vi.fn(async () => new Response(DUMMY, { status: 500 })),
      vi.fn(async () => new Response(DUMMY, { status: 403 })),
      vi.fn(async () => new Response(JSON.stringify({ configured: true, apiKey: DUMMY })))
    ]) {
      const f = fixture(transport)
      const error = await f.session.configureTranslationKey(DUMMY).catch(error => error)
      expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain(DUMMY)
      expect(['密钥保存未完成。', '密钥配置未授权。']).toContain(error.message)
      expect(f.session.textConfigured).toBe(false); expect(transport).toHaveBeenCalledOnce()
      expect(f.session.snapshot().message).toBe('请在字幕设置中配置翻译密钥')
    }
  })
  it('rejects invalid input and duplicate saves without a second request', async () => {
    let resolve!: (response: Response) => void
    const transport = vi.fn(() => new Promise<Response>(done => { resolve = done }))
    const f = fixture(transport)
    for (const value of ['', ' ', 'synthetic\ninvalid', 'x'.repeat(4097)]) await expect(f.session.configureTranslationKey(value)).rejects.toThrow('有效密钥')
    expect(transport).not.toHaveBeenCalled()
    const pending = f.session.configureTranslationKey(DUMMY)
    await expect(f.session.configureTranslationKey(DUMMY)).rejects.toThrow('正在保存')
    resolve(new Response('{"configured":true}')); await pending
    expect(transport).toHaveBeenCalledOnce()
  })
  it('cleans up the timeout and never retries after interruption', async () => {
    vi.useFakeTimers()
    const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(DUMMY)))
    }))
    const f = fixture(transport), pending = f.session.configureTranslationKey(DUMMY)
    const failure = expect(pending).rejects.toThrow('密钥保存未完成')
    await vi.advanceTimersByTimeAsync(15_001); await failure
    expect(transport).toHaveBeenCalledOnce(); expect(f.session.textConfigured).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
