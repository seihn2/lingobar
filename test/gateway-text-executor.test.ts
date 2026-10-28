import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { executeTextStep, defaultInstallation } = require('../scripts/run-one-rmb-text-test.cjs')
const { textRequest } = require('../scripts/plan-one-rmb-test.cjs')
const NOW = Date.parse('2026-10-28T18:00:00Z')
const SECRET = 'synthetic-test-key-never-a-real-credential'

function installation() {
  const value = structuredClone(defaultInstallation)
  value.executionEnabled = true
  value.ledgerDirectory = resolve('synthetic/private/one-batch-ledger')
  value.credentialsFile = resolve('synthetic/private/credential.json')
  value.account.catalogTermsConfirmed = true
  value.price.confirmed = true
  value.otherBatchSpend = { known: true, reservedMicroCny: 0, evidenceId: 'synthetic-zero-spend' }
  return value
}
function answer(step = 'translation', patch: Record<string, unknown> = {}) {
  return { model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(step === 'ruby' ? { readings: [{ id: 'h0', reading: 'がっこう' }] } : { ja: 'こんにちは。' }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }, ...patch }
}
function fixture(step = 'translation') {
  const order: string[] = []
  const config = installation()
  const ledger = {
    reservedMicroCny: 0,
    reserve: vi.fn(() => { order.push('reserve'); ledger.reservedMicroCny += 20_000; return { reservedMicroCny: ledger.reservedMicroCny, limitMicroCny: 1_000_000 } }),
    recordOutcome: vi.fn(() => { order.push('outcome') }),
    close: vi.fn((_options?: { retainLock?: boolean }) => { order.push('close') })
  }
  const inspectProof = vi.fn((_step: string, request: { requestSha256: string }) => {
    order.push('proof')
    return { admitted: true, blockers: [] as string[], inputTokenUpperBound: step === 'ruby' ? 325 : 225, conditionalMaximumMicroCny: step === 'ruby' ? 1674 : 1474, requestSha256: request.requestSha256 }
  })
  const readInstallation = vi.fn(() => { order.push('installation'); return config })
  const createLedger = vi.fn(() => { order.push('ledger'); return ledger })
  const readCredential = vi.fn(() => { order.push('credential'); return SECRET })
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => { order.push('fetch'); return new Response(JSON.stringify(answer(step)), { status: 200, headers: { 'Content-Type': 'application/json' } }) })
  const deps = { inspectProof, readInstallation, createLedger, readCredential, fetchImpl, now: () => NOW, deadlineMs: 25_000 }
  return { order, config, ledger, inspectProof, readInstallation, createLedger, readCredential, fetchImpl, deps,
    run: () => executeTextStep(step, deps) }
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real provider fetch forbidden') }))
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Real provider sockets forbidden') } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('fixed one-shot executor admission, no real providers or credentials', () => {
  it('the shipped configuration refuses execution before credential or transport access', async () => {
    const f = fixture(); f.readInstallation.mockReturnValue(structuredClone(defaultInstallation))
    const result = await f.run()
    expect(result).toMatchObject({ status: 'blocked', executionAllowed: false, providerCalls: 0 })
    expect(f.createLedger).not.toHaveBeenCalled(); expect(f.readCredential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['asr', 'retry', '', 'translation ruby', 'constructor', '__proto__', null, {}, ['ruby']])('refuses non-allowlisted step %# before a provider call', async step => {
    const f = fixture(), result = await executeTextStep(step, f.deps)
    expect(result).toMatchObject({ status: 'blocked', providerCalls: 0 })
    expect(f.createLedger).not.toHaveBeenCalled(); expect(f.readCredential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([
    ['disabled', (v: any) => { v.executionEnabled = false }],
    ['currency', (v: any) => { v.account.currency = 'USD' }],
    ['catalog', (v: any) => { v.account.catalogTermsConfirmed = false }],
    ['price', (v: any) => { v.price.confirmed = false }],
    ['expiry', (v: any) => { v.price.validUntil = '2026-10-27T00:00:00.000Z' }],
    ['ledger path', (v: any) => { v.ledgerDirectory = null }],
    ['credential path', (v: any) => { v.credentialsFile = null }],
    ['unknown spend', (v: any) => { v.otherBatchSpend.known = false }],
    ['unreconciled spend', (v: any) => { v.otherBatchSpend.reservedMicroCny = 1000 }],
    ['unknown field', (v: any) => { v.endpoint = 'https://attacker.example' }]
  ] as const)('fails closed for %s without preflight/key reads', async (_name, patch) => {
    const f = fixture(); patch(f.config)
    expect(await f.run()).toMatchObject({ status: 'blocked', providerCalls: 0 })
    expect(f.createLedger).not.toHaveBeenCalled(); expect(f.readCredential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('missing proof rejects before ledger/credential/network access', async () => {
    const f = fixture(); f.inspectProof.mockReturnValue({ admitted: false, blockers: ['synthetic missing proof'], inputTokenUpperBound: 225, conditionalMaximumMicroCny: 1474, requestSha256: textRequest('translation').requestSha256 })
    expect(await f.run()).toMatchObject({ status: 'blocked', providerCalls: 0 })
    expect(f.createLedger).not.toHaveBeenCalled(); expect(f.readCredential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([
    { requestSha256: '0'.repeat(64) }, { inputTokenUpperBound: 4096 }, { inputTokenUpperBound: 224 },
    { conditionalMaximumMicroCny: 20_001 }, { conditionalMaximumMicroCny: 1473 }
  ])('rejects an inconsistent proof rather than accepting a caller-supplied token estimate %#', async patch => {
    const f = fixture()
    f.inspectProof.mockImplementation((_step, request) => ({ admitted: true, blockers: [], inputTokenUpperBound: 225, conditionalMaximumMicroCny: 1474, requestSha256: request.requestSha256, ...patch }))
    expect(await f.run()).toMatchObject({ status: 'blocked', providerCalls: 0 })
    expect(f.createLedger).not.toHaveBeenCalled(); expect(f.readCredential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['translation', 'ruby'])('durably reserves before exactly one fixed %s POST and never chains the next step', async step => {
    const f = fixture(step), result = await f.run()
    expect(result).toMatchObject({ status: 'succeeded', executionAllowed: true, providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.ledger.reserve).toHaveBeenCalledExactlyOnceWith(step)
    expect(f.order.indexOf('reserve')).toBeLessThan(f.order.indexOf('credential'))
    expect(f.order.indexOf('reserve')).toBeLessThan(f.order.indexOf('fetch'))
    expect(f.fetchImpl).toHaveBeenCalledOnce()
    expect(f.fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
    expect(f.fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify(textRequest(step).body) })
    expect(f.ledger.recordOutcome).toHaveBeenCalledOnce(); expect(f.ledger.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain(SECRET); expect(JSON.stringify(result)).not.toContain('こんにちは'); expect(JSON.stringify(result)).not.toContain('がっこう')
  })
  it('reservation failure makes zero credential/provider calls and closes the lock', async () => {
    const f = fixture(); f.ledger.reserve.mockImplementation(() => { throw new Error('synthetic persistence failure') })
    expect(await f.run()).toMatchObject({ status: 'blocked', category: 'persistence', providerCalls: 0 })
    expect(f.readCredential).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.ledger.close).toHaveBeenCalledOnce()
  })
  it('credential failure burns the reservation without a provider call or automatic refund', async () => {
    const f = fixture(); f.readCredential.mockImplementation(() => { throw new Error('SYNTHETIC-PRIVATE-PATH') })
    const result = await f.run()
    expect(result).toMatchObject({ status: 'service_error', providerCalls: 0, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.ledger.recordOutcome).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE-PATH')
  })
})

describe('one-shot failures retain the full reservation and never retry', () => {
  it.each([400, 401, 429, 500, 503, 302])('HTTP%s cannot retry, follow redirects or refund', async status => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => new Response('SYNTHETIC-PRIVATE-UPSTREAM', { status, headers: { Location: 'https://attacker.example' } }))
    const result = await f.run()
    expect(result).toMatchObject({ status: 'service_error', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.ledger.recordOutcome).toHaveBeenCalledOnce(); expect(f.ledger.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE-UPSTREAM'); expect(JSON.stringify(result)).not.toContain('attacker')
  })
  it('a rejected fetch does not retry or expose the raw exception', async () => {
    const f = fixture(); f.fetchImpl.mockRejectedValue(new Error('SYNTHETIC-PRIVATE-PROXY-ERROR'))
    const result = await f.run()
    expect(result).toMatchObject({ status: 'service_error', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE-PROXY-ERROR')
  })
  it('counts actual streamed bytes even with a misleading short Content-Length', async () => {
    const f = fixture(); let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(16_384)); controller.enqueue(new Uint8Array(16_385))
    }, cancel() { cancelled = true } })
    f.fetchImpl.mockImplementation(async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } }))
    expect(await f.run()).toMatchObject({ status: 'response_error', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(cancelled).toBe(true); expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.ledger.recordOutcome).toHaveBeenCalledOnce()
  })
  it.each([
    ['non JSON', 'not-json'],
    ['oversized actual body', ' '.repeat(32769)],
    ['truncated generation', JSON.stringify(answer('translation', { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"ja":"truncated"}' } }] }))],
    ['tool call', JSON.stringify(answer('translation', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ja":"a"}', tool_calls: [{ id: 'synthetic', type: 'function' }] } }] }))],
    ['wrong result shape', JSON.stringify(answer('translation', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"unknown":"value"}' } }] }))],
    ['unknown model', JSON.stringify(answer('translation', { model: 'unknown-price-model' }))]
  ])('%s is rejected without format repair or a second request', async (_name, response) => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => new Response(response, { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await f.run()
    expect(result).toMatchObject({ status: _name === 'unknown model' ? 'usage_anomaly' : 'response_error', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.ledger.recordOutcome).toHaveBeenCalledOnce()
  })
  it.each([
    ['missing', undefined], ['too many input tokens', { prompt_tokens: 226, completion_tokens: 30, total_tokens: 256 }],
    ['too many generated tokens', { prompt_tokens: 100, completion_tokens: 129, total_tokens: 229 }],
    ['inconsistent total', { prompt_tokens: 100, completion_tokens: 30, total_tokens: 131 }],
    ['fractional', { prompt_tokens: 100.5, completion_tokens: 30, total_tokens: 130.5 }]
  ])('usage %s is an anomaly that durably blocks future attempts', async (_name, usage) => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => new Response(JSON.stringify(answer('translation', { usage })), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await f.run()
    expect(result).toMatchObject({ status: 'usage_anomaly', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.ledger.recordOutcome).toHaveBeenCalledWith('translation', 'usage_anomaly', textRequest('translation').requestSha256, 'usage_anomaly', true)
    expect(f.fetchImpl).toHaveBeenCalledOnce()
  })
  it('outcome persistence failure never refunds or replays the successful provider response', async () => {
    const f = fixture(); f.ledger.recordOutcome.mockImplementation(() => { throw new Error('SYNTHETIC-PRIVATE-DISK-ERROR') })
    const result = await f.run()
    expect(result).toMatchObject({ status: 'persist_error', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.ledger.close).toHaveBeenCalledExactlyOnceWith({ retainLock: true }); expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE-DISK-ERROR')
  })
  it('abort before fetch keeps a durable reservation and zero provider requests', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort()
    const result = await executeTextStep('translation', { ...f.deps, signal: controller.signal })
    expect(result).toMatchObject({ status: 'cancelled', providerCalls: 0, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.ledger.reserve).toHaveBeenCalledOnce()
  })
  it('abort wins over a late successful fetch without a retry or result resurrection', async () => {
    const f = fixture(), controller = new AbortController()
    let resolve!: (value: Response) => void
    f.fetchImpl.mockImplementation(() => new Promise<Response>(done => { resolve = done }))
    const pending = executeTextStep('translation', { ...f.deps, signal: controller.signal })
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce())
    controller.abort(); const result = await pending
    resolve(new Response(JSON.stringify(answer()), { status: 200, headers: { 'Content-Type': 'application/json' } })); await Promise.resolve()
    expect(result).toMatchObject({ status: 'cancelled', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.ledger.recordOutcome).toHaveBeenCalledOnce()
  })
  it('deadline ends a stalled body stream without retry or refund', async () => {
    const f = fixture(); let cancelled = false
    f.fetchImpl.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await executeTextStep('translation', { ...f.deps, deadlineMs: 10 })
    expect(result).toMatchObject({ status: 'timeout', providerCalls: 1, reservedMicroCny: 20_000 })
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.ledger.recordOutcome).toHaveBeenCalledOnce(); expect(cancelled).toBe(true)
  })
})
