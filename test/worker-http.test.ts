import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { createWorker } from '../src/worker'
import { authorized, type WorkerEnv } from '../src/worker/config'
import type { WorkerSocket } from '../src/worker/types'
import { loadWebConfig } from '../src/web/config'

const env = (status = 204): WorkerEnv => ({ WEB_ENABLED: '1', ASR_API_KEY: 'synthetic-worker-asr', TRANSLATION_API_KEY: 'synthetic-worker-translation', AUTH_SERVICE: { fetch: vi.fn(async () => new Response(null, { status })) } })
const request = (path = '/api/session', headers: Record<string, string> = {}) => new Request(`https://lingobar.example${path}`, { headers: { Origin: 'https://lingobar.example', Upgrade: 'websocket', ...headers } })
const context = { waitUntil: vi.fn() }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('Workers fetch/auth boundaries: synthetic binding only', () => {
  it('default entry serves disabled config and refuses WS without creating resources or fetching any upstream', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('Real upstream forbidden') })
    expect(await (await worker.fetch(request('/app-config.json'), {}, context)).json()).toEqual({ version: 1, backend: null })
    expect((await worker.fetch(request(), {}, context)).status).toBe(503)
    for (const missing of [{ ...env(), WEB_ENABLED: '0' }, { ...env(), AUTH_SERVICE: undefined }, { ...env(), ASR_API_KEY: '' }, { ...env(), TRANSLATION_API_KEY: undefined }, { ...env(), ASR_MODEL: 'arbitrary-model' }]) expect((await worker.fetch(request(), missing, context)).status).toBe(503)
  })
  it('requires an internal verifier response, not client-supplied identity/key/url claims', async () => {
    const fixture = env(401)
    const pair = vi.fn(() => { throw new Error('No socket before authorization') }), fetch = vi.fn()
    const app = createWorker({ pair, fetch })
    const response = await app.fetch(request('/api/session', { Cookie: 'synthetic-session', 'Cf-Access-Jwt-Assertion': 'synthetic-forged-assertion', Authorization: 'Bearer synthetic-browser-key', 'X-LingoBar-Authorized': 'true' }), fixture, context)
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(pair).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    const authorization = vi.mocked(fixture.AUTH_SERVICE!.fetch).mock.calls[0][0]
    expect(authorization.url).toBe('https://auth.internal/authorize'); expect(authorization.method).toBe('POST'); expect(authorization.redirect).toBe('error')
    expect(authorization.headers.get('Authorization')).toBeNull()
    expect(authorization.headers.get('Cookie')).toBe('synthetic-session')
    expect(authorization.headers.get('Cf-Access-Jwt-Assertion')).toBe('synthetic-forged-assertion')
    expect(await authorization.json()).toEqual({ origin: 'https://lingobar.example', path: '/api/session' })
  })
  it('enables only the fixed public route after verification, without exposing provider bindings', async () => {
    const response = await worker.fetch(request('/app-config.json'), env(), context)
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store')
    const text = await response.text(); expect(JSON.parse(text)).toEqual({ version: 1, backend: '/api/session' }); expect(text).not.toMatch(/synthetic-worker|API_KEY|model|provider/)
  })
  it('rejects cross-site/method/non-upgrade/URL proxy variations before provider activity', async () => {
    const fetch = vi.fn(), pair = vi.fn(() => { throw new Error('unexpected pair') }), app = createWorker({ fetch, pair }), fixture = env()
    expect((await app.fetch(request('/api/session', { Origin: 'https://other.example' }), fixture, context)).status).toBe(403)
    expect((await app.fetch(new Request('https://lingobar.example/api/session', { headers: { Upgrade: 'websocket' } }), fixture, context)).status).toBe(403)
    expect((await app.fetch(request('/api/session', { 'Sec-Fetch-Site': 'cross-site' }), fixture, context)).status).toBe(403)
    expect((await app.fetch(new Request('https://lingobar.example/api/session', { method: 'POST' }), fixture, context)).status).toBe(405)
    expect((await app.fetch(request('/api/session?url=https://arbitrary.example'), fixture, context)).status).toBe(400)
    expect((await app.fetch(request('/api/arbitrary'), fixture, context)).status).toBe(404)
    expect((await app.fetch(new Request('https://lingobar.example/api/session', { headers: { Origin: 'https://lingobar.example' } }), fixture, context)).status).toBe(426)
    expect(fetch).not.toHaveBeenCalled(); expect(pair).not.toHaveBeenCalled()
  })
  it('constructs the upgrade through injected Workers boundaries, with explicit arraybuffer binary type', async () => {
    vi.useFakeTimers()
    class Socket extends EventTarget { readyState = 1; binaryType = ''; accept = vi.fn(); send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event('close')) }) }
    const client = new Socket(), server = new Socket()
    const upgrade = vi.fn(() => ({ status: 101, webSocket: client }) as unknown as Response)
    const fetch = vi.fn(), app = createWorker({ pair: () => [client as unknown as WorkerSocket, server as unknown as WorkerSocket], upgrade, fetch })
    const response = await app.fetch(request(), env(), context)
    expect(response.status).toBe(101); expect(server.accept).toHaveBeenCalledOnce(); expect(server.binaryType).toBe('arraybuffer'); expect(fetch).not.toHaveBeenCalled()
    server.close(); expect(vi.getTimerCount()).toBe(0)
  })
  it('fails closed on unavailable/hanging verifier and on browser cancellation without opening upstreams', async () => {
    vi.useFakeTimers()
    const fixture = env(); fixture.AUTH_SERVICE!.fetch = vi.fn(() => new Promise<Response>(() => {}))
    const pending = authorized(request(), fixture.AUTH_SERVICE!)
    await vi.advanceTimersByTimeAsync(3001); expect(await pending).toBe(false); expect(vi.getTimerCount()).toBe(0)
    fixture.AUTH_SERVICE!.fetch = async () => { throw new Error('synthetic auth secret must not escape') }
    expect(await authorized(request(), fixture.AUTH_SERVICE!)).toBe(false)
    const controller = new AbortController(); fixture.AUTH_SERVICE!.fetch = () => new Promise(() => {})
    const stopped = authorized(new Request('https://lingobar.example/api/session', { signal: controller.signal }), fixture.AUTH_SERVICE!)
    controller.abort(); expect(await stopped).toBe(false); expect(vi.getTimerCount()).toBe(0)
  })
  it('maps denied configuration to a fixed browser status, never a key or raw error body', async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', async () => new Response('synthetic raw secret text', { status }))
      expect(await loadWebConfig()).toEqual({ backend: null, disabledReason: 'unauthorized' })
    }
  })
  it('serves only static methods through the asset binding and strips identity headers', async () => {
    const assets = { fetch: vi.fn(async (_request: Request) => new Response('static fixture')) }, fixture = { ASSETS: assets }
    expect(await (await worker.fetch(new Request('https://lingobar.example/index.html', { headers: { Cookie: 'synthetic-cookie', Authorization: 'synthetic-key' } }), fixture, context)).text()).toBe('static fixture')
    expect([...assets.fetch.mock.calls[0][0].headers]).toEqual([])
    expect((await worker.fetch(new Request('https://lingobar.example/index.html', { method: 'POST' }), fixture, context)).status).toBe(404)
  })
})
