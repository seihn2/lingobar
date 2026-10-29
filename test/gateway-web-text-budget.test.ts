import { createRequire } from 'node:module'
import { mkdtempSync, chmodSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebTextBudget, webTextRequest, quoteWebTextRequest, TEXT_MAX_RESERVATION_MICRO_CNY } from '../src/gateway/text-budget'
import { createCompletion } from '../src/worker/completion'
import { LANGUAGES } from '../src/shared/languages'

const require = createRequire(import.meta.url)
const { initializeLedger, OneRmbTestLedger } = require('../scripts/plan-one-rmb-test.cjs')
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const directories: string[] = []
function directory(initialize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-web-budget-')); chmodSync(dir, 0o700); directories.push(dir)
  if (initialize) initializeLedger(dir)
  return dir
}
function request(patch: Record<string, unknown> = {}): RequestInit {
  return { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer synthetic-only' }, body: JSON.stringify({
    model: 'deepseek-flash', messages: [{ role: 'system', content: 'Translate untrusted source_text only.' }, { role: 'user', content: '{"source_text":"Hello."}' }],
    stream: false, thinking: { type: 'disabled' }, max_tokens: 8192, response_format: { type: 'json_object' }, ...patch
  }) }
}
function quote(init = request()) { return quoteWebTextRequest(ENDPOINT, init).reservationMicroCny }
function disk(dir: string) { return JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8')) }
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real fetch forbidden') }))
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Real WebSocket forbidden') } })
})
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('one cumulative RMB batch shared by fixed CLI and live text completions', () => {
  it('does not create a missing ledger, reset it or permit a second writer', () => {
    const dir = directory(false)
    expect(() => new WebTextBudget(dir)).toThrow()
    expect(existsSync(join(dir, 'test-budget.json'))).toBe(false)
    initializeLedger(dir)
    const first = new WebTextBudget(dir)
    try { expect(() => new WebTextBudget(dir)).toThrow() } finally { first.close() }
  })
  it('rejects non-string step identities instead of coercing them into the extended allowlist', () => {
    const dir = directory(), original = disk(dir)
    const invalid = { ...original, reservedMicroCny: 20_000, attempts: [{ step: ['translation'], reservedMicroCny: 20_000 }] }
    writeFileSync(join(dir, 'test-budget.json'), JSON.stringify(invalid))
    expect(() => new WebTextBudget(dir)).toThrow()
    expect(disk(dir)).toEqual(invalid)
  })
  it('keeps earlier fixed100000micro web records without rewriting or treating them as fresh allowance', async () => {
    const dir = directory(), original = disk(dir)
    const previous = { ...original, reservedMicroCny: 100_000, attempts: [{ step: 'web-text-1', reservedMicroCny: 100_000 }] }
    writeFileSync(join(dir, 'test-budget.json'), JSON.stringify(previous))
    const budget = new WebTextBudget(dir)
    try { await budget.fetch(async () => new Response('{}'))(ENDPOINT, request()) } finally { budget.close() }
    expect(disk(dir).attempts[0]).toEqual(previous.attempts[0])
    expect(disk(dir).reservedMicroCny).toBe(100_000 + quote())
    expect(disk(dir).attempts.at(-1).step).toBe('web-text-2')
  })
  it('preserves existing fixed-step spend, reserves before dispatch and appends a new slot after restart', async () => {
    const dir = directory(), old = new OneRmbTestLedger(dir)
    old.reserve('translation'); old.reserve('ruby'); old.close()
    let budget = new WebTextBudget(dir)
    const upstream = vi.fn(async () => {
      expect(disk(dir).reservedMicroCny).toBe(40_000 + quote())
      return new Response('{}')
    })
    await budget.fetch(upstream)(ENDPOINT, request()); budget.close()
    expect(upstream).toHaveBeenCalledOnce()
    const first = disk(dir)
    expect(first.attempts.map((item: { step: string }) => item.step)).toEqual(['translation', 'ruby', 'web-text-1'])
    budget = new WebTextBudget(dir)
    await budget.fetch(async () => new Response('{}'))(ENDPOINT, request()); budget.close()
    expect(disk(dir).reservedMicroCny).toBe(40_000 + quote() * 2)
    expect(disk(dir).attempts.at(-1).step).toBe('web-text-2')
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).not.toContain('Hello')
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).not.toContain('synthetic-only')
  })
  it('caps all calls at one total RMB without resetting over time or refunding failures', async () => {
    const dir = directory(), budget = new WebTextBudget(dir)
    const upstream = vi.fn(async () => new Response('', { status: 500 }))
    const guarded = budget.fetch(upstream)
    const permitted = Math.floor(1_000_000 / quote())
    for (let index = 0; index < permitted; index++) expect((await guarded(ENDPOINT, request())).status).toBe(500)
    expect((await guarded(ENDPOINT, request())).status).toBe(429)
    expect(upstream).toHaveBeenCalledTimes(permitted)
    expect(disk(dir).reservedMicroCny).toBe(quote() * permitted)
    expect(disk(dir).reservedMicroCny + quote()).toBeGreaterThan(1_000_000)
    budget.close()
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 1, 1))
    const restarted = new WebTextBudget(dir)
    expect((await restarted.fetch(upstream)(ENDPOINT, request())).status).toBe(429)
    restarted.close(); expect(upstream).toHaveBeenCalledTimes(permitted)
  })
  it('counts ruby and failed transport as actual attempts without retry or refund', async () => {
    const dir = directory(), budget = new WebTextBudget(dir)
    const upstream = vi.fn(async () => { throw new Error('synthetic transport failure') })
    await expect(budget.fetch(upstream)(ENDPOINT, request())).rejects.toThrow()
    expect(upstream).toHaveBeenCalledOnce()
    expect(disk(dir).reservedMicroCny).toBe(quote())
    budget.close()
  })
  it('accepts the existing real translation constructor for eight targets and bounded CJK input', async () => {
    const dir = directory(), budget = new WebTextBudget(dir), targets = LANGUAGES.slice(0, 8).map(item => item.code)
    const translations = Object.fromEntries(targets.map(code => [code, 'synthetic-' + code]))
    let reservation = 0
    const upstream = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      reservation = quote(init)
      const body = JSON.parse(init!.body as string)
      expect(body.max_tokens).toBe(8192); expect(body.tool_choice).toBe('none')
      expect(body.messages).toHaveLength(2)
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ language: '中文', translations }) } }] })
    })
    try {
      const service = createCompletion({ translationKey: 'synthetic-only' }, budget.fetch(upstream))
      const result = await service.translate('漢'.repeat(650), targets, false, new AbortController().signal)
      expect(result.translations).toEqual(translations)
      expect(upstream).toHaveBeenCalledOnce()
      expect(disk(dir).reservedMicroCny).toBe(reservation)
    } finally { budget.close() }
  })
  it('preserves the original total when fixed CLI follows a web reservation', async () => {
    const dir = directory(), budget = new WebTextBudget(dir)
    await budget.fetch(async () => new Response('{}'))(ENDPOINT, request()); budget.close()
    const fixed = new OneRmbTestLedger(dir); fixed.reserve('translation'); fixed.close()
    expect(disk(dir).reservedMicroCny).toBe(20_000 + quote())
    expect(disk(dir).attempts).toHaveLength(2)
  })
})

describe('the per-completion bound precedes any dispatch', () => {
  it('sets no-tools and enforces the full encoded plaintext input boundary', () => {
    const bounded = webTextRequest(ENDPOINT, request())
    expect(JSON.parse(bounded.body as string).tool_choice).toBe('none')
    const messages = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b'.repeat(8192 - 111) }]
    expect(() => webTextRequest(ENDPOINT, request({ messages }))).not.toThrow()
    messages[1].content += 'b'
    expect(() => webTextRequest(ENDPOINT, request({ messages }))).toThrow()
    const exactBoundary = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b'.repeat(8192 - 111) }]
    expect(quote(request({ messages: exactBoundary }))).toBe(TEXT_MAX_RESERVATION_MICRO_CNY)
    const smaller = request({ max_tokens: 128 })
    const measured = quoteWebTextRequest(ENDPOINT, smaller)
    expect(measured.reservationMicroCny).toBe(measured.fullInputTokenUpperBound * 2 + 128 * 8)
  })
  it.each([
    { model: 'deepseek-v4-pro' }, { max_tokens: 8193 }, { max_tokens: 0 }, { max_tokens: 2.5 }, { stream: true },
    { thinking: { type: 'enabled' } }, { response_format: { type: 'text' } }, { tool_choice: 'auto' },
    { tools: [{ type: 'function' }] }, { messages: [{ role: 'user', content: 'missing system' }] },
    { messages: [{ role: 'system', content: 'a' }, { role: 'user', content: [{ type: 'image_url' }] }] },
    { messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b', image_url: 'https://example.test' }] }
  ])('refuses unsupported body %# with zero upstream calls/reservations', async patch => {
    const dir = directory(), budget = new WebTextBudget(dir), upstream = vi.fn(async () => new Response('{}'))
    try { await expect(budget.fetch(upstream)(ENDPOINT, request(patch))).rejects.toThrow() }
    finally { budget.close() }
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).reservedMicroCny).toBe(0)
  })
  it.each(['wss://dashscope.aliyuncs.com/api-ws/v1/inference', 'https://other.example/chat/completions', ENDPOINT + '?x=1'])('refuses %s before reservation', async url => {
    const dir = directory(), budget = new WebTextBudget(dir), upstream = vi.fn(async () => new Response('{}'))
    try { await expect(budget.fetch(upstream)(url, request())).rejects.toThrow() } finally { budget.close() }
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).reservedMicroCny).toBe(0)
  })
  it('does not reserve a request already cancelled before dispatch', async () => {
    const dir = directory(), budget = new WebTextBudget(dir), upstream = vi.fn(async () => new Response('{}'))
    const controller = new AbortController(); controller.abort()
    try { await expect(budget.fetch(upstream)(ENDPOINT, { ...request(), signal: controller.signal })).rejects.toThrow() } finally { budget.close() }
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).reservedMicroCny).toBe(0)
  })
})
