import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountBudget } from '../src/gateway/account-budget'
import { quoteWebTextRequest } from '../src/gateway/text-budget'
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const directories: string[] = [], budgets: AccountBudget[] = []
function directory() { const dir = mkdtempSync(join(tmpdir(), 'lingobar-account-budget-')); chmodSync(dir, 0o700); directories.push(dir); return dir }
function open(dir: string, cap = 0) { const b = new AccountBudget(dir, cap); budgets.push(b); return b }
function ready(cap = 1_000_000) { const dir = directory(); open(dir).close(); return { dir, budget: open(dir, cap) } }
function disk(dir: string) { return JSON.parse(readFileSync(join(dir, 'accounts-budget.json'), 'utf8')) }
function request(patch: Record<string, unknown> = {}): RequestInit { return { method: 'POST', redirect: 'error', body: JSON.stringify({
  model: 'deepseek-flash', messages: [{ role: 'system', content: 'Translate only.' }, { role: 'user', content: 'Hello.' }],
  stream: false, thinking: { type: 'disabled' }, max_tokens: 8192, response_format: { type: 'json_object' }, ...patch
}) } }
const QUOTE = quoteWebTextRequest(ENDPOINT, request()).reservationMicroCny
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real fetch forbidden') })) })
afterEach(() => { for (const b of budgets.splice(0)) b.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks() })
// POSIX private gateway state is not a Windows desktop runtime.
describe.skipIf(process.platform === 'win32')('shared account cumulative money reservations, synthetic upstream only', () => {
  it('initializes only with zero site allowance and blocks default-zero site/account quotas', async () => {
    const dir = directory(), upstream = vi.fn(async () => new Response('{}'))
    expect(() => new AccountBudget(dir, 1)).toThrow()
    expect(existsSync(join(dir, 'accounts-budget.json'))).toBe(false)
    const budget = open(dir)
    expect((await budget.fetch(A, 1_000_000, upstream)(ENDPOINT, request())).status).toBe(429)
    budget.close()
    const enabled = open(dir, 1_000_000)
    expect(enabled.remaining(A)).toBe(0)
    expect((await enabled.fetch(A, 0, upstream)(ENDPOINT, request())).status).toBe(429)
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).spentMicroCny).toBe(0)
  })
  it('durably charges site and only the authenticated account before dispatch, leaving owner ledgers alone', async () => {
    const { dir, budget } = ready()
    writeFileSync(join(dir, 'test-budget.json'), 'old-text-spend')
    writeFileSync(join(dir, 'audio-budget.json'), 'owner-one-rmb-spend')
    const upstream = vi.fn(async () => { expect(disk(dir)).toEqual({ version: 1, spentMicroCny: QUOTE, accounts: { [A]: QUOTE } }); return new Response('{}') })
    await budget.fetch(A, QUOTE, upstream)(ENDPOINT, request())
    expect(budget.remaining(A, QUOTE)).toBe(0); expect(budget.remaining(B, QUOTE)).toBe(QUOTE)
    expect((await budget.fetch(A, QUOTE, upstream)(ENDPOINT, request())).status).toBe(429)
    expect(upstream).toHaveBeenCalledOnce()
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).toBe('old-text-spend')
    expect(readFileSync(join(dir, 'audio-budget.json'), 'utf8')).toBe('owner-one-rmb-spend')
  })
  it('parallel calls cannot overspend the site or account limit', async () => {
    const { dir, budget } = ready(QUOTE * 3), upstream = vi.fn(async () => { await Promise.resolve(); return new Response('{}') })
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => budget.fetch(index % 2 ? A : B, QUOTE * 2, upstream)(ENDPOINT, request())))
    expect(results.filter(r => r.status === 200)).toHaveLength(3)
    expect(upstream).toHaveBeenCalledTimes(3)
    expect(disk(dir).spentMicroCny).toBe(QUOTE * 3)
    expect(disk(dir).accounts[A]).toBeLessThanOrEqual(QUOTE * 2)
    expect(disk(dir).accounts[B]).toBeLessThanOrEqual(QUOTE * 2)
  })
  it('persists across restarts/date changes and new account UUID does not erase site spend', async () => {
    const { dir, budget } = ready(QUOTE), upstream = vi.fn(async () => new Response('{}'))
    await budget.fetch(A, QUOTE, upstream)(ENDPOINT, request()); budget.close()
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2040, 0, 1))
    const reopened = open(dir, QUOTE)
    expect((await reopened.fetch(B, QUOTE, upstream)(ENDPOINT, request())).status).toBe(429)
    expect(reopened.remaining(A, QUOTE)).toBe(0); expect(reopened.remaining(B, QUOTE)).toBe(0)
    expect(disk(dir).accounts[A]).toBe(QUOTE); expect(upstream).toHaveBeenCalledOnce()
    reopened.close(); expect(open(dir, 0).remaining(A, QUOTE)).toBe(0)
  })
  it('retains failure, cancellation and unknown-result reservations; retry reserves again', async () => {
    const { dir, budget } = ready(), controller = new AbortController()
    const upstream = vi.fn(async () => { controller.abort(); throw new Error('unknown outcome') })
    await expect(budget.fetch(A, 1_000_000, upstream)(ENDPOINT, { ...request(), signal: controller.signal })).rejects.toThrow('unknown')
    await expect(budget.fetch(A, 1_000_000, upstream)(ENDPOINT, request())).rejects.toThrow('unknown')
    expect(disk(dir).spentMicroCny).toBe(QUOTE * 2); expect(disk(dir).accounts[A]).toBe(QUOTE * 2)
    const failure = vi.fn(async () => new Response('', { status: 500 }))
    await budget.fetch(A, 1_000_000, failure)(ENDPOINT, request())
    expect(disk(dir).spentMicroCny).toBe(QUOTE * 3)
  })
  it('pre-aborted requests do not dispatch or reserve', async () => {
    const { dir, budget } = ready(), controller = new AbortController(), upstream = vi.fn(async () => new Response('{}'))
    controller.abort()
    await expect(budget.fetch(A, 1_000_000, upstream)(ENDPOINT, { ...request(), signal: controller.signal })).rejects.toThrow()
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).spentMicroCny).toBe(0)
  })
  it('excludes second writers; failed writes latch closed admission', async () => {
    const { dir, budget } = ready(), upstream = vi.fn(async () => new Response('{}'))
    expect(() => new AccountBudget(dir, 1_000_000)).toThrow()
    writeFileSync(join(dir, 'accounts-budget.pending'), 'unresolved transaction', { mode: 0o600 })
    await expect(budget.fetch(A, 1_000_000, upstream)(ENDPOINT, request())).rejects.toThrow('unavailable')
    rmSync(join(dir, 'accounts-budget.pending'))
    await expect(budget.fetch(A, 1_000_000, upstream)(ENDPOINT, request())).rejects.toThrow('unavailable')
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).spentMicroCny).toBe(0)
  })
  it.each(['not json', JSON.stringify({ version: 1, spentMicroCny: 0, accounts: { [A]: 1 } }), JSON.stringify({ version: 1, spentMicroCny: -1, accounts: {} }), JSON.stringify({ version: 1, spentMicroCny: 1, accounts: { bad: 1 } })])('does not reset corrupt state %#', value => {
    const dir = directory(); writeFileSync(join(dir, 'accounts-budget.json'), value, { mode: 0o600 })
    expect(() => new AccountBudget(dir, 0)).toThrow()
    expect(readFileSync(join(dir, 'accounts-budget.json'), 'utf8')).toBe(value)
    expect(existsSync(join(dir, 'accounts-budget.lock'))).toBe(false)
  })
  it.each([-1, 0.5, 100_000_001, NaN, Infinity])('rejects invalid cap %s without initializing money', cap => {
    const dir = directory(); expect(() => new AccountBudget(dir, cap)).toThrow()
    expect(existsSync(join(dir, 'accounts-budget.json'))).toBe(false)
    const budget = open(dir); expect(() => budget.remaining(A, cap)).toThrow()
  })
  it.each([
    ['https://evil.example/chat/completions', request()],
    ['https://dashscope.aliyuncs.com/api-ws/v1/inference', { headers: { Upgrade: 'websocket' } }],
    [ENDPOINT, request({ model: 'deepseek-v4-pro' })], [ENDPOINT, request({ max_tokens: 8193 })], [ENDPOINT, request({ stream: true })]
  ])('rejects unsupported endpoint/shape %# before dispatch or money reservation', async (url, init) => {
    const { dir, budget } = ready(), upstream = vi.fn(async () => new Response('{}'))
    await expect(budget.fetch(A, 1_000_000, upstream)(url as string, init as RequestInit)).rejects.toThrow()
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).spentMicroCny).toBe(0)
  })
})
