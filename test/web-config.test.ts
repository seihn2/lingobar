import { afterEach, expect, it, vi } from 'vitest'
import { loadWebConfig } from '../src/web/config'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('loads only public same-origin routing metadata, with credentials kept same-origin', async () => {
  const fetch = vi.fn(async () => new Response('{"version":1,"backend":"/api/session"}'))
  vi.stubGlobal('fetch', fetch)
  expect(await loadWebConfig()).toEqual({ backend: '/api/session' })
  expect(fetch).toHaveBeenCalledWith('/app-config.json', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }))
})
it.each(['not JSON', '{"version":1,"backend":"https://elsewhere.example/ws"}', '{"version":1,"backend":null,"secret":"synthetic-rejected-field"}', ' '.repeat(513)])('fails closed for malformed or oversized public config', async text => {
  vi.stubGlobal('fetch', async () => new Response(text))
  expect(await loadWebConfig()).toEqual({ backend: null })
})
it('missing, failed and timed-out config never enables a backend', async () => {
  vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 })); expect(await loadWebConfig()).toEqual({ backend: null })
  vi.stubGlobal('fetch', async () => { throw new Error('synthetic network failure') }); expect(await loadWebConfig()).toEqual({ backend: null })
  vi.useFakeTimers()
  vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('cancelled')))))
  const pending = loadWebConfig(); await vi.advanceTimersByTimeAsync(2001)
  expect(await pending).toEqual({ backend: null }); expect(vi.getTimerCount()).toBe(0)
})
