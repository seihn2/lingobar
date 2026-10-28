import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGateway } from '../src/gateway/server'
import { nodeTransport } from '../src/gateway/transport'
import { configuration, jwks, now, token } from './gateway-fixture'
import type { WorkerFetch } from '../src/worker/types'
import type { Caption } from '../src/shared/types'

const cleanups: Array<() => Promise<void> | void> = []
const forbidden = vi.fn(() => { throw new Error('Real service network forbidden') })
beforeEach(() => { forbidden.mockClear(); vi.stubGlobal('fetch', forbidden) })
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
const start = { version: 1, type: 'start', sessionId: 'synthetic-browser-run', settings: { targetLanguages: ['zh', 'ja'], showOriginal: true, showFurigana: true } }
const annotation = { version: 1, type: 'annotation', requestId: 'synthetic-ruby', sessionId: 'synthetic-browser-run', captionId: 'synthetic-caption', sourceRevision: 3, language: 'ja', original: 'synthetic text', japanese: '学校' }
const reply = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
async function fixture(options: { disabled?: boolean; upstream?: WorkerFetch; daily?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-synthetic-gateway-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const config = { ...configuration(dir), ...(options.daily ? { dailySessions: options.daily } : {}) }
  const upstream = options.upstream || vi.fn<WorkerFetch>(async () => { throw new Error('Unrequested provider') })
  const gateway = createGateway(options.disabled ? null : config, { now: () => now, publicFetch: jwks, upstream })
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => gateway.close())
  const address = gateway.server.address() as { port: number }
  const http = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: address.port, path, method: options.method || 'GET', headers: { Host: 'lingobar.example', Origin: config.origin,
      'Cf-Access-Jwt-Assertion': token(), ...options.headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode!, text, headers: res.headers }))
    }); req.on('error', reject); req.end(options.body)
  })
  const ws = (headers: Record<string, string> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/session`, { headers: { Host: 'lingobar.example', Origin: config.origin, 'Cf-Access-Jwt-Assertion': token(), ...headers }, perMessageDeflate: false })
    socket.on('error', () => {})
    return socket
  }
  return { gateway, http, ws, dir, upstream }
}
function opened(ws: WebSocket): Promise<void> { return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) }) }
function messages(ws: WebSocket) { const values: Array<{ type: string; caption?: Caption; code?: string; sessionId?: string }> = []; ws.on('message', data => values.push(JSON.parse(data.toString()))); return values }
const closed = (ws: WebSocket) => ws.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(resolve => ws.once('close', () => resolve()))
async function rejected(ws: WebSocket): Promise<number> { return new Promise(resolve => ws.once('unexpected-response', (_req, res) => { const status = res.statusCode!; res.destroy(); ws.terminate(); resolve(status) })) }

describe.skipIf(process.platform !== 'linux')('actual Linux loopback HTTP/ws, generated Access tokens, synthetic providers only', () => {
  it('default disabled config/health refuses every real-function route, without opening upstreams', async () => {
    const f = await fixture({ disabled: true })
    expect(JSON.parse((await f.http('/app-config.json')).text)).toEqual({ version: 1, backend: null })
    expect((await f.http('/healthz')).status).toBe(503)
    expect((await f.http('/api/session')).status).toBe(503)
    expect(await rejected(f.ws())).toBe(503); expect(f.upstream).not.toHaveBeenCalled()
  })
  it('requires pinned Host, exact Origin, methods/routes and a verified assertion; public config contains no credentials', async () => {
    const f = await fixture()
    for (const headers of [{ Host: 'forged.example' }, { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }] as Array<Record<string, string>>) expect((await f.http('/app-config.json', { headers })).status).toBe(403)
    expect((await f.http('/app-config.json', { headers: { 'Cf-Access-Jwt-Assertion': 'forged' } })).status).toBe(401)
    expect((await f.http('/app-config.json', { method: 'POST' })).status).toBe(405)
    expect((await f.http('/api/session?url=https://attacker.example')).status).toBe(404)
    expect((await f.http('/api/session')).status).toBe(426)
    const response = await f.http('/app-config.json')
    expect(response.status).toBe(200); expect(JSON.parse(response.text)).toEqual({ version: 1, backend: '/api/session' })
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.text).not.toMatch(/synthetic|key|email|model/)
    expect(await rejected(f.ws({ Origin: '' }))).toBe(403)
    expect(await rejected(f.ws({ 'Cf-Access-Jwt-Assertion': token({ exp: now / 1000 }) }))).toBe(401)
    expect(f.upstream).not.toHaveBeenCalled()
  })
  it('bounds incoming control requests even when no paid work starts', async () => {
    const f = await fixture()
    for (let i = 0; i < 60; i++) expect((await f.http('/app-config.json')).status).toBe(200)
    expect((await f.http('/app-config.json')).status).toBe(429); expect(f.upstream).not.toHaveBeenCalled()
  })
  it('never opens ASR on connect/stop; bounds concurrent sessions; releases the slot after disconnect', async () => {
    const f = await fixture(), one = f.ws(); await opened(one)
    expect(await rejected(f.ws())).toBe(429); expect(f.upstream).not.toHaveBeenCalled()
    one.send(JSON.stringify({ version: 1, type: 'stop', sessionId: 'wrong-session' })); await closed(one)
    const two = f.ws(); await opened(two); two.close(); await closed(two)
    expect(f.upstream).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(f.dir, 'budget.json'), 'utf8')).sessions).toBe(0)
  })
  it('hard-stops a daily reservation before opening the next ASR and reports quota over the existing versioned protocol', async () => {
    const upstream = vi.fn<WorkerFetch>(async () => ({ status: 503 }) as Response), f = await fixture({ upstream, daily: 1 })
    const one = f.ws(), first = messages(one); await opened(one); one.send(JSON.stringify(start)); await closed(one)
    expect(first.at(-1)?.code).toBe('upstream'); expect(upstream).toHaveBeenCalledOnce()
    const two = f.ws(), second = messages(two); await opened(two); two.send(JSON.stringify({ ...start, sessionId: 'synthetic-next' })); await closed(two)
    expect(second.at(-1)).toMatchObject({ type: 'error', sessionId: 'synthetic-next', code: 'quota' }); expect(upstream).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(join(f.dir, 'budget.json'), 'utf8'))).toMatchObject({ sessions: 1, completions: 40 })
  })
  it('uses annotation-only POST while paused, forwards only fixed provider auth, and retains identity/revision/ruby', async () => {
    const upstream = vi.fn<WorkerFetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('Cookie')).toBeNull(); expect(new Headers(init?.headers).get('Cf-Access-Jwt-Assertion')).toBeNull()
      return reply({ readings: [{ id: 'h0', reading: 'がっこう' }] })
    }), f = await fixture({ upstream })
    const response = await f.http('/api/annotation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotation) })
    const { original: _source, japanese: _japanese, ...identity } = annotation
    expect(response.status).toBe(200); expect(JSON.parse(response.text)).toEqual({ ...identity,
      reading: 'がっこう', jaSegments: [{ text: '学校', reading: 'がっこう' }] })
    expect(response.text).not.toContain('synthetic-translation'); expect(upstream).toHaveBeenCalledOnce()
    expect(upstream.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect(JSON.parse(readFileSync(join(f.dir, 'budget.json'), 'utf8'))).toMatchObject({ sessions: 0, completions: 2 })
  })
  it.each([401, 429, 503])('does not leak provider bodies for annotation status %s or retry ASR', async status => {
    const upstream = vi.fn<WorkerFetch>(async () => new Response('synthetic-private-provider-message', { status })), f = await fixture({ upstream })
    const response = await f.http('/api/annotation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotation) })
    expect(response.status).toBe(status === 503 ? 502 : status); expect(response.text).not.toContain('synthetic-private-provider-message')
    expect(upstream).toHaveBeenCalledOnce()
  })
  it('rejects bad annotation origin/body and never opens an ASR socket', async () => {
    const f = await fixture()
    expect((await f.http('/api/annotation', { method: 'POST', headers: { Origin: '' }, body: JSON.stringify(annotation) })).status).toBe(403)
    expect((await f.http('/api/annotation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status).toBe(400)
    expect(f.upstream).not.toHaveBeenCalled()
  })
  it('aborts owned annotation transport when the real HTTP client disconnects, without persisting text', async () => {
    let signal: AbortSignal | undefined
    const upstream = vi.fn<WorkerFetch>(async (_url, init) => {
      signal = init?.signal || undefined
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('synthetic cancelled request')), { once: true }))
    }), f = await fixture({ upstream })
    const address = f.gateway.server.address() as { port: number }
    const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/annotation', method: 'POST', headers: {
      Host: 'lingobar.example', Origin: 'https://lingobar.example', 'Cf-Access-Jwt-Assertion': token(), 'Content-Type': 'application/json'
    } }); req.on('error', () => {}); req.end(JSON.stringify(annotation))
    await vi.waitFor(() => expect(signal).toBeDefined()); req.destroy()
    await vi.waitFor(() => expect(signal!.aborted).toBe(true)); expect(upstream).toHaveBeenCalledOnce()
    expect(readFileSync(join(f.dir, 'budget.json'), 'utf8')).not.toMatch(/synthetic|学校/)
  })
  it('shutdown closes a starting ASR and active browser without opening replacements', async () => {
    let signal: AbortSignal | undefined
    const upstream = vi.fn<WorkerFetch>(async (_url, init) => { signal = init?.signal || undefined; return new Promise<Response>(() => {}) })
    const f = await fixture({ upstream }), browser = f.ws(); await opened(browser); browser.send(JSON.stringify(start))
    await vi.waitFor(() => expect(signal).toBeDefined()); await f.gateway.close(); await closed(browser)
    expect(signal!.aborted).toBe(true); expect(upstream).toHaveBeenCalledOnce()
  })
  it('a short-lived signed token closes a starting audio session and cancels its upstream at expiry', async () => {
    let signal: AbortSignal | undefined
    const upstream = vi.fn<WorkerFetch>(async (_url, init) => { signal = init?.signal || undefined; return new Promise<Response>(() => {}) })
    const f = await fixture({ upstream }), browser = f.ws({ 'Cf-Access-Jwt-Assertion': token({ exp: now / 1000 + 1 }) })
    await opened(browser); browser.send(JSON.stringify(start))
    await vi.waitFor(() => expect(signal).toBeDefined()); await closed(browser)
    expect(signal!.aborted).toBe(true); expect(upstream).toHaveBeenCalledOnce()
  })
  it('runs real local WS transport through partial translation, final/ruby, late partial rejection, stop and no resurrection', async () => {
    const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>(resolve => provider.once('listening', resolve))
    cleanups.push(() => { for (const peer of provider.clients) peer.terminate(); return new Promise<void>(resolve => provider.close(() => resolve())) })
    let remote: WebSocket | undefined, task = ''
    provider.on('connection', ws => {
      remote = ws
      ws.on('message', (data, binary) => {
        if (binary) ws.send(JSON.stringify({ header: { task_id: task, event: 'result-generated' }, payload: { output: { sentence: { sentence_id: 1, text: 'synthetic partial', sentence_end: false } } } }))
        else { task = JSON.parse(data.toString()).header.task_id; ws.send(JSON.stringify({ header: { task_id: task, event: 'task-started' } })) }
      })
    })
    const http = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
      const body = JSON.parse(String(init?.body)), prompt = JSON.parse(body.messages[1].content)
      return 'japanese' in prompt ? reply({ readings: [{ id: 'h0', reading: 'がっこう' }] })
        : reply({ language: '英语', translations: { zh: '合成译文', ja: '学校' } })
    })
    const connect = vi.fn((url: string, options: WebSocket.ClientOptions) => {
      expect(url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference'); expect(options.followRedirects).toBe(false)
      expect(options.headers).toEqual({ Authorization: 'Bearer synthetic-asr' })
      return new WebSocket(`ws://127.0.0.1:${(provider.address() as { port: number }).port}`, options)
    })
    const f = await fixture({ upstream: nodeTransport(http, connect) }), browser = f.ws(), received = messages(browser)
    await opened(browser); expect(connect).not.toHaveBeenCalled()
    browser.send(JSON.stringify(start)); await vi.waitFor(() => expect(received.some(v => v.type === 'ready')).toBe(true))
    browser.send(Buffer.alloc(320))
    await vi.waitFor(() => expect(received.some(v => v.caption?.original === 'synthetic partial' && v.caption.status === 'ready' && v.caption.live)).toBe(true), { timeout: 3000 })
    remote!.send(JSON.stringify({ header: { task_id: task, event: 'result-generated' }, payload: { output: { sentence: { sentence_id: 1, text: 'synthetic final', sentence_end: true } } } }))
    await vi.waitFor(() => expect(received.some(v => v.caption?.original === 'synthetic final' && !v.caption.live && v.caption.furiganaStatus === 'ready')).toBe(true))
    await vi.waitFor(() => expect(received.at(-1)?.caption).toMatchObject({ original: 'synthetic final', status: 'ready', translationPending: false }))
    const last = received.filter(v => v.caption).at(-1)!.caption!
    expect(last.original).toBe('synthetic final'); expect(last.translations).toEqual({ zh: '合成译文', ja: '学校' }); expect(last.jaSegments).toEqual([{ text: '学校', reading: 'がっこう' }])
    const count = received.length
    remote!.send(JSON.stringify({ header: { task_id: task, event: 'result-generated' }, payload: { output: { sentence: { sentence_id: 1, text: 'late stale partial', sentence_end: false } } } }))
    browser.send(JSON.stringify({ version: 1, type: 'stop', sessionId: start.sessionId })); await closed(browser)
    expect(received.slice(count).every(v => v.caption?.original === 'synthetic final' && !v.caption.live), JSON.stringify(received.slice(count))).toBe(true)
    await vi.waitFor(() => expect(remote!.readyState).toBe(WebSocket.CLOSED))
    expect(connect).toHaveBeenCalledOnce(); expect(JSON.stringify(received)).not.toMatch(/synthetic-asr|synthetic-translation|Cf-Access/)
  })
})
