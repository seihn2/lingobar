import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserSession } from '../src/web/session'
import { parseWebConfig } from '../src/web/config'
import type { TextTranslationRequest } from '../src/shared/text-protocol'

const sessions = new Set<BrowserSession>()
function translated(request: TextTranslationRequest, extra = {}) {
  return new Response(JSON.stringify({ version: 1, requestId: request.requestId, caption: {
    id: request.requestId, source: 'text', original: request.original, translatedOriginal: request.original,
    language: 'English', createdAt: 1, status: 'ready', saved: false, targetLanguages: request.targetLanguages,
    translations: Object.fromEntries(request.targetLanguages.map(code => [code, code === 'ja' ? '天気' : `Synthetic ${code}`])),
    zh: '', en: '', ja: request.targetLanguages.includes('ja') ? '天気' : '', reading: '',
    ...(request.showFurigana && request.targetLanguages.includes('ja') ? { jaSegments: [{ text: '天気', reading: 'てんき' }], furiganaStatus: 'ready' } : {}),
    ...extra
  } }))
}
function fixture(textFetch: typeof fetch, enabled = true) {
  const socket = vi.fn(() => { throw new Error('Audio socket forbidden') })
  const capture = vi.fn(async () => { throw new Error('Real microphone forbidden') })
  const session = new BrowserSession({ backend: null, textBackend: enabled ? '/api/translate' : null,
    origin: 'https://lingobar.example', textFetch, socket, capture })
  sessions.add(session)
  return { session, socket, capture }
}
function delayed() {
  let respond!: (value: Response) => void
  let request!: TextTranslationRequest
  const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(init!.body as string)
    return new Promise<Response>(resolve => { respond = resolve })
  })
  return { transport, complete: () => respond(translated(request)) }
}
afterEach(() => { for (const session of sessions) session.dispose(); sessions.clear(); vi.useRealTimers() })

describe('explicit browser text translation without audio', () => {
  it('accepts old public config and the optional fixed text route independently', () => {
    expect(parseWebConfig({ version: 1, backend: null })).toEqual({ backend: null })
    expect(parseWebConfig({ version: 1, backend: '/api/session' })).toEqual({ backend: '/api/session' })
    expect(parseWebConfig({ version: 1, backend: null, textBackend: '/api/translate' })).toEqual({ backend: null, textBackend: '/api/translate' })
    expect(parseWebConfig({ version: 1, backend: null, textBackend: null })).toEqual({ backend: null, textBackend: null })
    expect(() => parseWebConfig({ version: 1, backend: null, textBackend: 'https://elsewhere.example' })).toThrow()
    expect(() => parseWebConfig({ version: 1, backend: null, textBackend: '/api/translate', apiKey: 'synthetic-rejected' })).toThrow()
  })
  it('submits one explicit text request and keeps source, selected language order, ruby and favorites', async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => translated(JSON.parse(init!.body as string)))
    const f = fixture(transport)
    expect(f.session.configured).toBe(false); expect(f.session.textConfigured).toBe(true)
    expect(f.session.snapshot().message).toBe('文字翻译可用')
    f.session.saveSettings({ targetLanguages: ['ja', 'fr'], showFurigana: true })
    await f.session.translateText('Synthetic source sentence')
    expect(transport).toHaveBeenCalledOnce()
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe('https://lingobar.example/api/translate')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    expect(JSON.parse(init!.body as string)).toMatchObject({ original: 'Synthetic source sentence', targetLanguages: ['ja', 'fr'], showFurigana: true })
    expect(init!.body).not.toMatch(/apiKey|model|audio|Authorization/)
    const caption = f.session.snapshot().captions[0]
    expect(caption).toMatchObject({ source: 'text', original: 'Synthetic source sentence', targetLanguages: ['ja', 'fr'], jaSegments: [{ text: '天気', reading: 'てんき' }] })
    f.session.toggleSaved(caption.id); expect(f.session.snapshot().captions[0].saved).toBe(true)
    await expect(f.session.start()).rejects.toThrow('后端未配置')
    expect(f.capture).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled()
  })
  it('refuses absent text configuration, blank input and UTF8 overflow before fetch', async () => {
    const fetch = vi.fn()
    await expect(fixture(fetch, false).session.translateText('Synthetic source')).rejects.toThrow('尚未配置')
    const f = fixture(fetch)
    await expect(f.session.translateText(' ')).rejects.toThrow()
    await expect(f.session.translateText('漢'.repeat(667))).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled(); expect(f.socket).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
  })
  it('rejects duplicate submissions and ignores a cancelled late response', async () => {
    const d = delayed(), f = fixture(d.transport)
    const pending = f.session.translateText('Synthetic cancelled input')
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(f.session.translateText('Duplicate')).rejects.toThrow('当前文字翻译')
    f.session.cancelText(); d.complete(); await cancelled
    expect(d.transport).toHaveBeenCalledOnce(); expect(f.session.snapshot().captions).toEqual([])
  })
  it('stop and a language change cancel only the old request without reviving its caption', async () => {
    for (const cancel of [(session: BrowserSession) => session.stop(), (session: BrowserSession) => session.saveSettings({ targetLanguages: ['fr'] })]) {
      const d = delayed(), f = fixture(d.transport)
      const pending = f.session.translateText('Synthetic interrupted input')
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      cancel(f.session); d.complete(); await cancelled
      expect(f.session.snapshot().captions).toEqual([])
      expect(f.socket).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
    }
  })
  it('retries a text caption over HTTP while audio is paused, preserving ID and saved state', async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => translated(JSON.parse(init!.body as string)))
    const f = fixture(transport)
    await f.session.translateText('Synthetic retry source')
    const id = f.session.snapshot().captions[0].id; f.session.toggleSaved(id); f.session.stop()
    await f.session.retry(id)
    expect(transport).toHaveBeenCalledTimes(2)
    expect(f.session.snapshot().captions).toHaveLength(1)
    expect(f.session.snapshot().captions[0]).toMatchObject({ id, source: 'text', saved: true })
    expect(f.socket).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled()
  })
  it('reports quota and malformed responses without automatic retries', async () => {
    const quota = vi.fn(async () => new Response('{"error":"quota"}', { status: 429 }))
    await expect(fixture(quota).session.translateText('Synthetic quota')).rejects.toThrow('额度')
    expect(quota).toHaveBeenCalledOnce()
    const malformed = vi.fn(async () => new Response('{"version":1,"requestId":"old","caption":{}}'))
    const f = fixture(malformed)
    await expect(f.session.translateText('Synthetic malformed')).rejects.toThrow('格式')
    expect(malformed).toHaveBeenCalledOnce(); expect(f.session.snapshot().captions).toEqual([])
  })
  it('times out a request and clears the deadline without retrying', async () => {
    vi.useFakeTimers()
    const transport = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled synthetic transport', 'AbortError')))
    }))
    const f = fixture(transport), pending = f.session.translateText('Synthetic timeout')
    const failure = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(60_001); await failure
    expect(transport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
})
