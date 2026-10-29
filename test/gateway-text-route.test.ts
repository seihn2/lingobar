import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGateway } from '../src/gateway/server'
import { configuration, jwks, now, token } from './gateway-fixture'
import type { WorkerFetch } from '../src/worker/types'
import { quoteWebTextRequest } from '../src/gateway/text-budget'

const require = createRequire(import.meta.url)
const { initializeLedger, OneRmbTestLedger } = require('../scripts/plan-one-rmb-test.cjs')
const cleanups: Array<() => Promise<void> | void> = []
const forbidden = vi.fn(() => { throw new Error('Real services forbidden') })
beforeEach(() => { forbidden.mockClear(); vi.stubGlobal('fetch', forbidden) })
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
  expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals()
})
const input = { version: 1, requestId: 'synthetic-text-request', original: 'Synthetic school sentence.', targetLanguages: ['ja', 'zh'], showFurigana: false }
const reply = (content: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] })
const translated = { language: '英语', translations: { ja: '学校', zh: '学校' } }
const spent = (upstream: ReturnType<typeof vi.fn<WorkerFetch>>) => upstream.mock.calls.reduce((total, [url, init]) => total + quoteWebTextRequest(url, init).reservationMicroCny, 0)
async function fixture(upstream: WorkerFetch, preReserve = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-text-route-')); chmodSync(dir, 0o700)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  initializeLedger(dir)
  if (preReserve) { const before = new OneRmbTestLedger(dir); before.reserve('translation'); before.close() }
  const config = { ...configuration(''), asrKey: '', audioEnabled: false, text: { ledgerDirectory: dir } }
  const gateway = createGateway(config, { upstream, publicFetch: jwks, now: () => now })
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => gateway.close())
  const port = (gateway.server.address() as { port: number }).port
  const http = (path = '/api/translate', body: unknown = input, headers: Record<string, string> = {}, method = 'POST') => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { Host: 'lingobar.example', Origin: config.origin,
      'Cf-Access-Jwt-Assertion': token(), 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode!, text }))
    }); req.on('error', reject); req.end(method === 'GET' || body === undefined ? undefined : JSON.stringify(body))
  })
  const ledger = () => JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8'))
  return { dir, port, config, gateway, http, ledger }
}

describe.skipIf(process.platform !== 'linux')('formal text route with loopback HTTP and synthetic providers', () => {
  it('advertises text separately, translates without ASR and shares the existing monetary ledger', async () => {
    const upstream = vi.fn<WorkerFetch>(async (url, options) => {
      expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
      const headers = new Headers(options?.headers)
      expect(headers.get('Authorization')).toBe('Bearer synthetic-translation')
      expect(headers.get('Cf-Access-Jwt-Assertion')).toBeNull()
      expect(JSON.parse(options!.body as string)).toMatchObject({ model: 'deepseek-flash', max_tokens: 8192, thinking: { type: 'disabled' }, tool_choice: 'none' })
      return reply(translated)
    })
    const f = await fixture(upstream)
    const config = await f.http('/app-config.json', undefined, {}, 'GET')
    expect(JSON.parse(config.text)).toEqual({ version: 1, backend: null, textBackend: '/api/translate' })
    const result = await f.http()
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text)).toMatchObject({ version: 1, requestId: input.requestId, caption: {
      source: 'text', original: input.original, translatedOriginal: input.original, targetLanguages: ['ja', 'zh'],
      translations: translated.translations, status: 'ready', saved: false } })
    expect(result.text).not.toContain('synthetic-translation'); expect(upstream).toHaveBeenCalledOnce()
    expect(f.ledger().reservedMicroCny).toBe(spent(upstream))
    expect(existsSync(join(f.dir, 'budget.json'))).toBe(false)
    expect((await f.http('/api/session', undefined, {}, 'GET')).status).toBe(503)
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/api/session`, { headers: { Host: 'lingobar.example', Origin: f.config.origin, 'Cf-Access-Jwt-Assertion': token() } })
    ws.on('error', () => {})
    const status = await new Promise<number>(resolve => ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.destroy(); ws.terminate() }))
    expect(status).toBe(503); expect(upstream).toHaveBeenCalledOnce()
  })

  it('keeps Access/Origin/body rejection before any provider call or monetary reservation', async () => {
    const upstream = vi.fn<WorkerFetch>(async () => reply(translated)), f = await fixture(upstream)
    for (const headers of [{ Host: 'forged.example' }, { Origin: '' }, { Origin: 'https://forged.example' }, { 'Cf-Access-Jwt-Assertion': 'forged' }] as Array<Record<string, string>>) {
      expect([401, 403]).toContain((await f.http('/api/translate', input, headers)).status)
    }
    for (const body of [{ ...input, extra: true }, { ...input, original: 'x'.repeat(2001) }, { ...input, targetLanguages: [] }]) expect((await f.http('/api/translate', body)).status).toBe(400)
    expect((await f.http('/api/translate', input, { 'Content-Type': 'text/plain' })).status).toBe(400)
    expect(upstream).not.toHaveBeenCalled(); expect(f.ledger().reservedMicroCny).toBe(0)
  })

  it('retains earlier test expenditure and stops the next request before dispatch at the shared1RMB limit', async () => {
    const upstream = vi.fn<WorkerFetch>(async () => reply(translated)), f = await fixture(upstream, true)
    expect((await f.http()).status).toBe(200)
    const amount = spent(upstream), calls = Math.floor((1_000_000 - 20_000) / amount)
    for (let n = 1; n < calls; n++) expect((await f.http()).status).toBe(200)
    expect((await f.http()).status).toBe(429)
    expect(upstream).toHaveBeenCalledTimes(calls)
    expect(f.ledger().reservedMicroCny).toBe(20_000 + spent(upstream))
    expect(f.ledger().attempts[0]).toEqual({ step: 'translation', reservedMicroCny: 20_000 })
  })

  it('adds Japanese ruby with a separate reservation and retains translation when ruby fails', async () => {
    const upstream = vi.fn<WorkerFetch>(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      return JSON.parse(body.messages[1].content).slots ? reply({ readings: [{ id: 'h0', reading: 'がっこう' }] }) : reply(translated)
    }), f = await fixture(upstream)
    const result = await f.http('/api/translate', { ...input, showFurigana: true })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).caption).toMatchObject({ furiganaStatus: 'ready', reading: 'がっこう', jaSegments: [{ text: '学校', reading: 'がっこう' }] })
    expect(upstream).toHaveBeenCalledTimes(2); expect(f.ledger().reservedMicroCny).toBe(spent(upstream))
    upstream.mockImplementation(async (_url, options) => JSON.parse(JSON.parse(options!.body as string).messages[1].content).slots ? new Response(null, { status: 401 }) : reply(translated))
    const partial = await f.http('/api/translate', { ...input, showFurigana: true })
    expect(partial.status).toBe(200); expect(JSON.parse(partial.text).caption).toMatchObject({ furiganaStatus: 'error', translations: translated.translations })
    expect(upstream).toHaveBeenCalledTimes(4); expect(f.ledger().reservedMicroCny).toBe(spent(upstream))
  })

  it('does not retry provider failure or expose its response body', async () => {
    const upstream = vi.fn<WorkerFetch>(async () => new Response('PRIVATE-DUMMY-PROVIDER-BODY', { status: 429 })), f = await fixture(upstream)
    const result = await f.http()
    expect(result.status).toBe(429); expect(result.text).toBe('{"error":"quota"}')
    expect(upstream).toHaveBeenCalledOnce(); expect(f.ledger().reservedMicroCny).toBe(spent(upstream))
  })

  it('cancels disconnected work, rejects overlap, and never refunds the dispatched reservation', async () => {
    let rejectRequest!: (value: Error) => void
    const upstream = vi.fn<WorkerFetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      rejectRequest = reject; options!.signal!.addEventListener('abort', () => reject(new Error('dummy cancellation')), { once: true })
    })), f = await fixture(upstream)
    const req = httpRequest({ host: '127.0.0.1', port: f.port, path: '/api/translate', method: 'POST', headers: {
      Host: 'lingobar.example', Origin: f.config.origin, 'Cf-Access-Jwt-Assertion': token(), 'Content-Type': 'application/json'
    } })
    req.on('error', () => {}); req.end(JSON.stringify(input))
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
    expect((await f.http()).status).toBe(429)
    req.destroy()
    await vi.waitFor(() => expect(upstream.mock.calls[0][1]!.signal!.aborted).toBe(true))
    rejectRequest(new Error('late dummy cancellation'))
    expect(f.ledger().reservedMicroCny).toBe(spent(upstream))
  })
})
