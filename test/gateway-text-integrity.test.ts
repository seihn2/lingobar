import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { executeTextStep, defaultInstallation } = require('../scripts/run-one-rmb-text-test.cjs')
const { initializeLedger, OneRmbTestLedger } = require('../scripts/plan-one-rmb-test.cjs')
const directories: string[] = []
const NOW = Date.parse('2026-10-28T18:30:00Z')

function installation(dir = resolve('synthetic/private/ledger')) {
  const value = structuredClone(defaultInstallation)
  value.executionEnabled = true
  value.ledgerDirectory = dir
  value.credentialsFile = resolve('synthetic/private/credential.json')
  value.account.catalogTermsConfirmed = true
  value.price.confirmed = true
  value.otherBatchSpend = { known: true, reservedMicroCny: 0, evidenceId: 'synthetic-reconciled-zero' }
  return value
}
function proof(step: string, request: { requestSha256: string }) {
  return { admitted: true, inputTokenUpperBound: step === 'ruby' ? 325 : 225,
    conditionalMaximumMicroCny: step === 'ruby' ? 1674 : 1474, requestSha256: request.requestSha256 }
}
function response() {
  return { model: 'unexpected-paid-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ja":"こんにちは。"}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real providers forbidden') }))
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Real sockets forbidden') } })
})
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('a response model that contradicts the admitted price permanently blocks the batch', () => {
  it('persists anomaly across a real ledger close/reopen and refuses the other step before credential or transport access', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingobar-text-integrity-')); directories.push(directory)
    initializeLedger(directory)
    const config = installation(directory)
    const readCredential = vi.fn(() => 'synthetic-private-key-never-real')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response()), { headers: { 'Content-Type': 'application/json' } }))
    const deps = { inspectProof: proof, readInstallation: () => config, createLedger: (dir: string) => new OneRmbTestLedger(dir),
      readCredential, fetchImpl, now: () => NOW, deadlineMs: 25_000 }
    const first = await executeTextStep('translation', deps)
    expect(first).toMatchObject({ status: 'usage_anomaly', providerCalls: 1, reservationRetained: true, reservedMicroCny: 20_000 })
    const disk = JSON.parse(readFileSync(join(directory, 'test-budget.json'), 'utf8'))
    expect(disk.reservedMicroCny).toBe(20_000)
    expect(disk.attempts).toHaveLength(1)
    expect(disk.attempts[0].outcome).toMatchObject({ status: 'usage_anomaly', anomaly: true })
    const reopened = new OneRmbTestLedger(directory)
    try { expect(() => reopened.reserve('ruby')).toThrow() } finally { reopened.close() }
    const second = await executeTextStep('ruby', deps)
    expect(second).toMatchObject({ status: 'blocked', providerCalls: 0 })
    expect(readCredential).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('early response failures close their network body before returning the one-shot result', () => {
  it.each([
    { name: 'HTTP429', status: 429, contentType: 'application/json', expected: 'service_error' },
    { name: 'non-JSON200', status: 200, contentType: 'text/html', expected: 'response_error' }
  ])('$name cancels a neverending response instead of clearing its only deadline and leaving it live', async item => {
    const cancelled = vi.fn(), signals: AbortSignal[] = []
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('synthetic response')) }, cancel: cancelled })
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal; signals.push(signal)
      // Model native fetch: aborting its signal cancels the associated response body.
      signal.addEventListener('abort', () => { void stream.cancel().catch(() => {}) }, { once: true })
      return new Response(stream, { status: item.status, headers: { 'Content-Type': item.contentType } })
    })
    const ledger = { reserve: vi.fn(), recordOutcome: vi.fn(), close: vi.fn(), reservedMicroCny: 0 }
    const result = await executeTextStep('translation', { inspectProof: proof, readInstallation: installation, createLedger: () => ledger,
      readCredential: () => 'synthetic-private-key-never-real', fetchImpl, now: () => NOW, deadlineMs: 25_000 })
    expect(result).toMatchObject({ status: item.expected, providerCalls: 1, reservationRetained: true })
    expect(signals[0].aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(ledger.recordOutcome).toHaveBeenCalledOnce()
    expect(ledger.close).toHaveBeenCalledOnce()
  })
})
