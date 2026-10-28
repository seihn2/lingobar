import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { plan, quote, textRequest, initializeLedger, OneRmbTestLedger } = createRequire(import.meta.url)('../scripts/plan-one-rmb-test.cjs')
const roots: string[] = [], opened: Array<{ close(): void }> = []
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'lingobar-synthetic-one-rmb-')); roots.push(dir); return dir }
const ledger = (dir: string) => { const value = new OneRmbTestLedger(dir); opened.push(value); return value }
afterEach(() => { vi.useRealTimers(); for (const value of opened.splice(0)) value.close(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('one-RMB test cost calculations are offline conditional bounds, never account balance/usage', () => {
  it('pins the reported actual models, keeps ASR/total bounds unknown and blocks all execution', () => {
    const result = plan()
    expect(result.executionAllowed).toBe(false); expect(result.limitMicroCny).toBe(1_000_000)
    expect(result.actualCallsThisPreparation).toBe(0); expect(result.actualCostThisPreparationMicroCny).toBe(0)
    expect(result.conditionalMaximumMicroCny).toBeNull(); expect(result.totalReservationMicroCny).toBeNull()
    expect(result.conditionalTextMaximumMicroCny).toBe(3148); expect(result.plannedTextReservationMicroCny).toBe(40_000)
    expect(result.profile.asr).toMatchObject({ host: 'dashscope.aliyuncs.com', model: 'qwen-audio-3.1-asr-flash-streaming', keyReportedPresent: true })
    expect(result.profile.translation).toMatchObject({ host: 'api.deepseek.com', model: 'deepseek-flash', keyReportedPresent: true })
    expect(result.steps[0]).toMatchObject({ maximumOutputTokens: null, conditionalMaximumMicroCny: null, reservationMicroCny: null })
    expect(result.steps.map((v: { attempts: number }) => v.attempts)).toEqual([1, 1, 1])
    expect(result.blockers.join(' ')).toMatch(/not exact BPE/)
    expect(result.profile.accountCurrencyVerified).toBe(true)
    expect(result.steps.slice(1).map((step: { fullPromptTokenUpperBound: number }) => step.fullPromptTokenUpperBound)).toEqual([225, 325])
  })
  it.each(['qwen-audio-3.0-asr-flash-streaming', 'qwen-audio-3.1-asr-flash-streaming'])('never substitutes a seconds price for the selected3.1, including a complete %s request descriptor', model => {
    expect(() => quote({ provider: 'dashscope', endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      model, currency: 'CNY', region: 'cn-beijing', format: 'pcm16-mono-16000', pcmBytes: 160_000 })).toThrow('no provider call permitted')
  })
  it.each(['translation', 'ruby'])('constructs a fixed synthetic %s request with128 output tokens, no thinking/tools or retry; construction cannot fetch', step => {
    const network = vi.fn(() => { throw new Error('Real provider forbidden') }); vi.stubGlobal('fetch', network)
    try {
      const request = textRequest(step)
      expect(request).toMatchObject({ endpoint: 'https://api.deepseek.com/chat/completions', method: 'POST', attempts: 1,
        fullPromptBoundProved: false, executionAllowed: false, body: { model: 'deepseek-flash', stream: false,
          max_tokens: 128, thinking: { type: 'disabled' }, tool_choice: 'none' } })
      expect(request.body.messages.map((v: { role: string }) => v.role)).toEqual(['system', 'user'])
      expect(request.serializedBytes).toBe(Buffer.byteLength(JSON.stringify(request.body)))
      expect(request.requestSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(request.body).not.toHaveProperty('tools'); expect(request.body).not.toHaveProperty('apiKey')
      expect(network).not.toHaveBeenCalled(); expect(() => textRequest('asr')).toThrow()
    } finally { vi.unstubAllGlobals() }
  })
  it.each([
    { provider: 'arbitrary', model: 'free' }, { provider: 'dashscope', model: 'qwen-audio-3.1-asr-flash-streaming' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'deepseek', model: 'deepseek-flash', currency: 'USD' }
  ])('rejects unknown prices, models, token-unbounded ASR or a different settlement currency %#', input => {
    expect(() => quote(input)).toThrow('no provider call permitted')
  })
  it('does not use arbitrary endpoints, character estimates or thinking/tool calls to manufacture a small text bound', () => {
    const input = { provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', currency: 'CNY', thinking: 'disabled', tools: false, fullPromptTokens: 4096, maxTokens: 128 }
    expect(quote(input).maximumMicroCny).toBe(9216)
    for (const patch of [{ endpoint: 'https://attacker.example' }, { fullPromptTokens: undefined }, { fullPromptTokens: 4097 }, { maxTokens: 8192 }, { thinking: 'enabled' }, { tools: true }]) expect(() => quote({ ...input, ...patch })).toThrow()
  })
})
describe.skipIf(process.platform !== 'linux')('single persistent test allowance, not a daily Web budget', () => {
  it('requires explicit initialization and never silently creates or replaces a missing/existing ledger', () => {
    const dir = directory(); expect(() => ledger(dir)).toThrow(); initializeLedger(dir)
    expect(() => initializeLedger(dir)).toThrow(); expect(ledger(dir)).toBeDefined()
  })
  it('retains all attempts over midnight, year change, close/reopen and failures with no retry/refund operation', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T23:59:59Z'))
    const dir = directory(); initializeLedger(dir); const first = ledger(dir)
    expect(() => first.reserve('asr')).toThrow(); first.reserve('translation'); first.close(); vi.setSystemTime(new Date('2027-01-01T12:00:00Z'))
    const second = ledger(dir); expect(() => second.reserve('translation')).toThrow(); expect(() => second.reserve('asr')).toThrow()
    second.reserve('ruby'); expect(() => second.reserve('ruby')).toThrow()
    expect(JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8'))).toMatchObject({ currency: 'CNY', limitMicroCny: 1_000_000, reservedMicroCny: 40_000 })
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).not.toMatch(/day|date|apiKey|caption|audio/)
  })
  it('locks out parallel writers and refuses unknown extra attempts, corrupt sums or a changed allowance', () => {
    const dir = directory(); initializeLedger(dir); const first = ledger(dir)
    expect(() => ledger(dir)).toThrow(); expect(() => first.reserve('retry-until-success')).toThrow(); first.close()
    const p = join(dir, 'test-budget.json'), original = JSON.parse(readFileSync(p, 'utf8'))
    writeFileSync(p, JSON.stringify({ ...original, reservedMicroCny: 999 })); expect(() => ledger(dir)).toThrow()
    writeFileSync(p, JSON.stringify({ ...original, limitMicroCny: 10_000_000 })); expect(() => ledger(dir)).toThrow()
  })
  it('refuses a legacy3.0 ASR reservation without erasing its recorded amount or resetting the total', () => {
    const dir = directory(); initializeLedger(dir)
    const filename = join(dir, 'test-budget.json'), original = JSON.parse(readFileSync(filename, 'utf8'))
    const previous = JSON.stringify({ ...original, reservedMicroCny: 10_000, attempts: [{ step: 'asr', reservedMicroCny: 10_000 }] })
    writeFileSync(filename, previous)
    expect(() => ledger(dir)).toThrow('no provider call permitted')
    expect(readFileSync(filename, 'utf8')).toBe(previous)
  })
  it('fails closed on a persistence failure without allowing later reservations or a silent reset', () => {
    const dir = directory(); initializeLedger(dir); const value = ledger(dir)
    writeFileSync(join(dir, 'test-budget.pending'), 'synthetic interrupted write', { mode: 0o600 })
    expect(() => value.reserve('translation')).toThrow(); expect(() => value.reserve('ruby')).toThrow()
    expect(JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8')).reservedMicroCny).toBe(0)
  })
  it('keeps an already-renamed reservation after an uncertain fsync failure; reopening cannot repeat it', () => {
    const dir = directory(); initializeLedger(dir); const value = ledger(dir)
    const fs = createRequire(import.meta.url)('node:fs'), original = fs.fsyncSync
    let calls = 0
    const failing = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: unknown) => { if (++calls === 2) throw new Error('synthetic uncertain directory sync'); return original(fd) })
    try { expect(() => value.reserve('translation')).toThrow() } finally { failing.mockRestore() }
    value.close()
    const next = ledger(dir); expect(() => next.reserve('translation')).toThrow()
    expect(JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8')).reservedMicroCny).toBe(20_000)
  })
})
