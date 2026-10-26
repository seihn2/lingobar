import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnnotationHandler } from '../src/worker/annotation'
import { TRANSLATION_ENDPOINT } from '../src/worker/completion'
import type { WorkerEnv } from '../src/worker/config'
import type { WorkerFetch } from '../src/worker/types'
import { ANNOTATION_TIMEOUT_MS, MAX_ANNOTATION_BYTES, type AnnotationRequest } from '../src/shared/annotation-protocol'

vi.mock('electron', () => { throw new Error('Text annotation must not load Electron') })
vi.mock('ws', () => { throw new Error('Text annotation must not load Node ws') })
const secret = 'SYNTHETIC-ANNOTATION-SERVER-KEY'
const sample: AnnotationRequest = { version: 1, type: 'annotation', requestId: 'request-1', sessionId: 'text-operation-1',
  captionId: 'browser-1:caption-1', sourceRevision: 3, language: 'ja', original: 'Synthetic learning sentence', japanese: '学校で学ぶ。' }
const readings = { readings: [{ id: 'h0', reading: 'がっこう' }, { id: 'h1', reading: 'まな' }] }
const reply = (value: unknown = readings) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }))
const network = vi.fn(() => { throw new Error('Real network forbidden in synthetic annotation tests') })
const settle = async () => { for (let count = 0; count < 60; count++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function environment() {
  const auth = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
  const env: WorkerEnv = { WEB_ENABLED: '1', TRANSLATION_API_KEY: secret, AUTH_SERVICE: { fetch: auth } }
  Object.defineProperties(env, {
    ASR_API_KEY: { get() { throw new Error('Annotation must not read the ASR key') } },
    ASR_MODEL: { get() { throw new Error('Annotation must not read the ASR model') } }
  })
  return { env, auth }
}
function request(body: string | ReadableStream<Uint8Array> = JSON.stringify(sample), options: { url?: string; method?: string; headers?: Record<string, string>; signal?: AbortSignal; origin?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options.origin === null ? {} : { Origin: options.origin || 'https://lingobar.example' }), ...options.headers }
  const method = options.method || 'POST'
  return new Request(options.url || 'https://lingobar.example/api/annotation', { method, headers, signal: options.signal,
    ...(!['GET', 'HEAD'].includes(method) ? { body, ...(typeof body === 'string' ? {} : { duplex: 'half' }) } : {}) } as RequestInit)
}
function stream(chunks: Uint8Array[], close = true) {
  const cancel = vi.fn()
  return { cancel, body: new ReadableStream<Uint8Array>({ start(controller) { for (const value of chunks) controller.enqueue(value); if (close) controller.close() }, cancel }) }
}
async function fixedError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ version: 1, error: code })
  expect(response.headers.get('Cache-Control')).toBe('no-store')
}
beforeEach(() => { vi.useFakeTimers(); network.mockClear(); vi.stubGlobal('fetch', network) })
afterEach(async () => { await settle(); expect(network).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('authorized text-only Worker annotation with synthetic boundaries', () => {
  it('uses only the translation binding, exact auth metadata and fixed annotation transport, without echoing source or keys', async () => {
    const { env, auth } = environment(), fetch = vi.fn<WorkerFetch>(async () => reply())
    const result = await createAnnotationHandler(fetch)(request(undefined, { headers: { Cookie: 'synthetic-cookie', Authorization: 'browser-key-must-not-forward', 'Cf-Access-Jwt-Assertion': 'untrusted-jwt-evidence' } }), env)
    expect(result.status).toBe(200)
    const text = await result.text(), value = JSON.parse(text)
    expect(value).toEqual({ version: 1, type: 'annotation', requestId: sample.requestId, sessionId: sample.sessionId, captionId: sample.captionId,
      sourceRevision: 3, language: 'ja', reading: 'がっこうでまなぶ。', jaSegments: [{ text: '学校', reading: 'がっこう' }, { text: 'で' }, { text: '学', reading: 'まな' }, { text: 'ぶ。' }] })
    expect(value.jaSegments.map((segment: { text: string }) => segment.text).join('')).toBe(sample.japanese)
    expect(text).not.toContain(sample.original); expect(text).not.toContain('original'); expect(text).not.toContain(secret)
    expect(result.headers.get('Cache-Control')).toBe('no-store'); expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const authorization = auth.mock.calls[0][0]
    expect(authorization.url).toBe('https://auth.internal/authorize'); expect(authorization.method).toBe('POST'); expect(authorization.redirect).toBe('error')
    expect(await authorization.json()).toEqual({ origin: 'https://lingobar.example', path: '/api/annotation' })
    expect(authorization.headers.get('Authorization')).toBeNull(); expect(authorization.headers.get('Cookie')).toBe('synthetic-cookie')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(TRANSLATION_ENDPOINT); expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${secret}` } })
    const body = JSON.parse(init!.body as string)
    expect(body.model).toBe('deepseek-flash'); expect(body.messages[0].content).toContain('Do not translate or rewrite text')
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ source_text: sample.original, japanese: sample.japanese })
  })

  it('returns valid kana-only annotation without any provider request', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>()
    const result = await createAnnotationHandler(fetch)(request(JSON.stringify({ ...sample, japanese: 'こんにちは！' })), env)
    expect(await result.json()).toMatchObject({ reading: 'こんにちは！', jaSegments: [{ text: 'こんにちは！' }] }); expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['default', 'disabled', 'missing-auth', 'missing-key', 'invalid-key'] as const)('denies %s configuration without authorization or provider activity', async mode => {
    const { env, auth } = environment(), fetch = vi.fn<WorkerFetch>()
    const selected: WorkerEnv = mode === 'default' ? {} : env
    if (mode === 'disabled') selected.WEB_ENABLED = '0'
    if (mode === 'missing-auth') selected.AUTH_SERVICE = undefined
    if (mode === 'missing-key') selected.TRANSLATION_API_KEY = ''
    if (mode === 'invalid-key') selected.TRANSLATION_API_KEY = 'synthetic\nkey'
    await fixedError(await createAnnotationHandler(fetch)(request(), selected), 503, 'unavailable')
    expect(auth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ method: 'GET' }, 405, 'protocol'], [{ url: 'http://lingobar.example/api/annotation' }, 400, 'protocol'],
    [{ url: 'https://lingobar.example/api/annotation?url=https://arbitrary.example' }, 400, 'protocol'],
    [{ url: 'https://lingobar.example/api/other' }, 404, 'protocol'], [{ origin: null }, 403, 'unauthorized'],
    [{ origin: 'https://arbitrary.example' }, 403, 'unauthorized'], [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403, 'unauthorized'],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415, 'protocol'], [{ headers: { Upgrade: 'websocket' } }, 400, 'protocol'],
    [{ headers: { 'Content-Length': String(MAX_ANNOTATION_BYTES + 1) } }, 413, 'protocol']
  ] as const)('rejects invalid HTTP boundary %j before contacting the verifier', async (options, status, code) => {
    const { env, auth } = environment(), fetch = vi.fn<WorkerFetch>()
    await fixedError(await createAnnotationHandler(fetch)(request(undefined, options), env), status, code)
    expect(auth).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })

  it.each([200, 401, 403, 500])('requires verifier204 even when identity claims are supplied (status=%s)', async status => {
    const { env, auth } = environment(), fetch = vi.fn<WorkerFetch>()
    auth.mockResolvedValueOnce(new Response('synthetic private authorization error', { status }))
    await fixedError(await createAnnotationHandler(fetch)(request(undefined, { headers: { 'X-LingoBar-Authorized': 'true' } }), env), 401, 'unauthorized')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds verifier exceptions and an unresponsive verifier without provider activity', async () => {
    const { env, auth } = environment(), fetch = vi.fn<WorkerFetch>(), handler = createAnnotationHandler(fetch)
    auth.mockRejectedValueOnce(new Error(`synthetic private ${secret}`))
    await fixedError(await handler(request(), env), 401, 'unauthorized')
    auth.mockImplementationOnce(() => new Promise(() => {}))
    const pending = handler(request(), env); await vi.advanceTimersByTimeAsync(3000)
    await fixedError(await pending, 401, 'unauthorized'); expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['{broken', JSON.stringify({ ...sample, apiKey: 'client-key', endpoint: 'https://arbitrary.example' }), JSON.stringify({ ...sample, sourceRevision: 0 })])('rejects invalid annotation controls without starting a completion (%s)', async body => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>()
    await fixedError(await createAnnotationHandler(fetch)(request(body), env), 400, 'protocol'); expect(fetch).not.toHaveBeenCalled()
  })

  it('counts actual UTF8 body bytes while streaming, cancels excess input and rejects malformed UTF8', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>(), handler = createAnnotationHandler(fetch)
    const oversized = stream([new TextEncoder().encode('あ'.repeat(21_846))], false)
    await fixedError(await handler(request(oversized.body), env), 413, 'protocol'); expect(oversized.cancel).toHaveBeenCalledOnce()
    await fixedError(await handler(request(stream([new Uint8Array([0xc3, 0x28])]).body), env), 400, 'protocol')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserves split UTF8 sequences in a legitimate streamed body', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>(async () => reply()), bytes = new TextEncoder().encode(JSON.stringify(sample))
    const split = bytes.indexOf(0xe5) + 1
    const result = await createAnnotationHandler(fetch)(request(stream([bytes.slice(0, split), bytes.slice(split)]).body), env)
    expect(result.status).toBe(200); expect(fetch).toHaveBeenCalledOnce()
  })

  it('permits at most two concurrent operations and returns capacity after settlement', async () => {
    const { env } = environment(), jobs = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const fetch = vi.fn<WorkerFetch>().mockImplementationOnce(() => jobs[0].promise).mockImplementationOnce(() => jobs[1].promise).mockImplementationOnce(() => jobs[2].promise)
    const handler = createAnnotationHandler(fetch), one = handler(request(), env), two = handler(request(), env); await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    await fixedError(await handler(request(), env), 429, 'busy'); expect(fetch).toHaveBeenCalledTimes(2)
    jobs[0].resolve(reply()); expect((await one).status).toBe(200)
    const three = handler(request(), env); await settle(); expect(fetch).toHaveBeenCalledTimes(3)
    jobs[1].resolve(reply()); jobs[2].resolve(reply()); expect((await two).status).toBe(200); expect((await three).status).toBe(200)
  })

  it('bounds the entire operation including an unfinished request body to30s', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>(), body = stream([], false), handler = createAnnotationHandler(fetch)
    const pending = handler(request(body.body), env); await settle(); await vi.advanceTimersByTimeAsync(ANNOTATION_TIMEOUT_MS)
    await fixedError(await pending, 504, 'timeout'); expect(body.cancel).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled()
    // Timeout released the slot and cannot start a completion later.
    expect((await handler(request(JSON.stringify({ ...sample, japanese: 'かな' })), env)).status).toBe(200)
  })

  it('cancels an unfinished body and an already-cancelled request without any provider calls', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>(), handler = createAnnotationHandler(fetch), controller = new AbortController(), body = stream([], false)
    const pending = handler(request(body.body, { signal: controller.signal }), env); await settle(); controller.abort()
    await fixedError(await pending, 499, 'unavailable'); expect(body.cancel).toHaveBeenCalledOnce()
    await fixedError(await handler(request(undefined, { signal: controller.signal }), env), 499, 'unavailable'); expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a pending provider call and ignores its late result without losing future capacity', async () => {
    const { env } = environment(), job = deferred<Response>(), fetch = vi.fn<WorkerFetch>(() => job.promise), handler = createAnnotationHandler(fetch), controller = new AbortController()
    const pending = handler(request(undefined, { signal: controller.signal }), env); await settle()
    const signal = fetch.mock.calls[0][1]!.signal!
    controller.abort(); await fixedError(await pending, 499, 'unavailable'); expect(signal.aborted).toBe(true)
    job.resolve(reply()); await settle()
    expect((await handler(request(JSON.stringify({ ...sample, japanese: 'かな' })), env)).status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive completion to25s and never returns its late success', async () => {
    const { env } = environment(), job = deferred<Response>(), fetch = vi.fn<WorkerFetch>(() => job.promise)
    const pending = createAnnotationHandler(fetch)(request(), env); await settle(); await vi.advanceTimersByTimeAsync(25_000)
    await fixedError(await pending, 502, 'upstream'); expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true)
    job.resolve(reply()); await settle(); expect(fetch).toHaveBeenCalledOnce()
  })

  it('allows one malformed annotation retry with unchanged Japanese and no translation request', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>().mockResolvedValueOnce(reply({ readings: [] })).mockResolvedValueOnce(reply())
    expect((await createAnnotationHandler(fetch)(request(), env)).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(2)
    for (const [, init] of fetch.mock.calls) {
      const body = JSON.parse(init!.body as string)
      expect(body.messages[0].content).toContain('Do not translate or rewrite text')
      expect(JSON.parse(body.messages[1].content)).toMatchObject({ source_text: sample.original, japanese: sample.japanese })
    }
  })

  it('stops after two malformed annotation replies and returns no raw provider error', async () => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>(async () => reply({ privateKey: secret, readings: [] }))
    await fixedError(await createAnnotationHandler(fetch)(request(), env), 502, 'upstream'); expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([[401, 401, 'unauthorized'], [403, 401, 'unauthorized'], [429, 429, 'quota'], [503, 502, 'upstream'], [302, 502, 'upstream']] as const)('maps provider status%s to a fixed error without leaking its body', async (upstream, status, code) => {
    const { env } = environment(), fetch = vi.fn<WorkerFetch>(async () => new Response(`synthetic private ${secret}`, { status: upstream, headers: { Location: 'https://arbitrary.example' } }))
    await fixedError(await createAnnotationHandler(fetch)(request(), env), status, code); expect(fetch).toHaveBeenCalledOnce()
  })

  it('validates the bounded response contract instead of returning oversized aggregate readings', async () => {
    const { env } = environment(), japanese = '学あ'.repeat(20)
    const fetch = vi.fn<WorkerFetch>(async () => reply({ readings: Array.from({ length: 20 }, (_, index) => ({ id: `h${index}`, reading: 'あ'.repeat(512) })) }))
    await fixedError(await createAnnotationHandler(fetch)(request(JSON.stringify({ ...sample, japanese })), env), 502, 'upstream')
    expect(fetch).toHaveBeenCalledOnce()
  })
})
