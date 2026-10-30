import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioBudget } from '../src/gateway/audio-budget'
import { AUDIO_POLICY } from '../src/gateway/audio-policy'
import { quoteWebTextRequest } from '../src/gateway/text-budget'

// SYNTHETIC admission only: not evidence of provider billing or permission for real calls.
vi.mock('../src/gateway/audio-policy', async importOriginal => {
  const original = await importOriginal<typeof import('../src/gateway/audio-policy')>()
  return { AUDIO_POLICY: { ...original.AUDIO_POLICY, verified: true } }
})
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const ASR = 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'
const directories: string[] = [], budgets: AudioBudget[] = []
function directory(initialize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-audio-budget-'))
  chmodSync(dir, 0o700); directories.push(dir)
  if (initialize) writeFileSync(join(dir, 'audio-budget.json'), JSON.stringify({ version: 1, batch: AUDIO_POLICY.batch, reservedMicroCny: 0, attempts: 0 }), { mode: 0o600 })
  return dir
}
function open(dir: string) { const budget = new AudioBudget(dir); budgets.push(budget); return budget }
function disk(dir: string) { return JSON.parse(readFileSync(join(dir, 'audio-budget.json'), 'utf8')) }
function request(patch: Record<string, unknown> = {}): RequestInit {
  return { method: 'POST', redirect: 'error', body: JSON.stringify({ model: 'deepseek-flash',
    messages: [{ role: 'system', content: 'Translate only.' }, { role: 'user', content: 'Hello.' }],
    stream: false, thinking: { type: 'disabled' }, max_tokens: 8192, response_format: { type: 'json_object' }, ...patch }) }
}
const asrRequest = (): RequestInit => ({ redirect: 'error', headers: { Upgrade: 'websocket', Authorization: 'Bearer synthetic-only' } })
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real fetch forbidden') }))
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Real WebSocket forbidden') } })
})
afterEach(() => {
  for (const budget of budgets.splice(0)) budget.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

// POSIX private gateway state is not a Windows desktop runtime.
describe.skipIf(process.platform === 'win32')('synthetic incremental audio batch reservations (not real billing verification)', () => {
  it('keeps production policy unverified despite the synthetic test override', async () => {
    const actual = await vi.importActual<typeof import('../src/gateway/audio-policy')>('../src/gateway/audio-policy')
    expect(actual.AUDIO_POLICY.verified).toBe(false)
  })
  it('requires an initialized ledger and excludes concurrent writers', () => {
    const missing = directory(false)
    expect(() => new AudioBudget(missing)).toThrow()
    expect(existsSync(join(missing, 'audio-budget.json'))).toBe(false)
    expect(existsSync(join(missing, 'audio.lock'))).toBe(false)
    const dir = directory(), first = open(dir)
    expect(() => new AudioBudget(dir)).toThrow()
    first.reserve(3300); first.close()
    expect(open(dir).remainingMicroCny).toBe(996700)
  })
  it.each(['not JSON', JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, batch: AUDIO_POLICY.batch, reservedMicroCny: 1_000_001, attempts: 1 }), JSON.stringify({ version: 1, batch: 'other-batch', reservedMicroCny: 0, attempts: 0 })])('fails closed on corrupt ledger %# without resetting it', value => {
    const dir = directory(); writeFileSync(join(dir, 'audio-budget.json'), value)
    expect(() => new AudioBudget(dir)).toThrow()
    expect(readFileSync(join(dir, 'audio-budget.json'), 'utf8')).toBe(value)
    expect(existsSync(join(dir, 'audio.lock'))).toBe(false)
  })
  it('reserves both ASR and corresponding translation durably before dispatch, without touching old text spend', async () => {
    const dir = directory(), oldText = '{"reservedMicroCny":765432,"historical":"untouched"}'
    writeFileSync(join(dir, 'test-budget.json'), oldText)
    const budget = open(dir), quote = quoteWebTextRequest(ENDPOINT, request()).reservationMicroCny
    let expected = AUDIO_POLICY.asrReservationMicroCny
    const upstream = vi.fn(async () => { expect(disk(dir).reservedMicroCny).toBe(expected); return new Response('{}') })
    await budget.fetch(upstream)(ASR, asrRequest())
    expected += quote
    await budget.fetch(upstream)(ENDPOINT, request())
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(disk(dir).attempts).toBe(2)
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).toBe(oldText)
    expect(readFileSync(join(dir, 'audio-budget.json'), 'utf8')).not.toMatch(/Hello|synthetic-only/)
    budget.close(); expect(open(dir).remainingMicroCny).toBe(1_000_000 - expected)
  })
  it('enforces one cumulative million micro-CNY across restart and time, including failed attempts', async () => {
    const dir = directory(), budget = open(dir), upstream = vi.fn(async () => new Response('', { status: 500 }))
    const quote = quoteWebTextRequest(ENDPOINT, request()).reservationMicroCny
    budget.reserve(1_000_000 - quote)
    expect((await budget.fetch(upstream)(ENDPOINT, request())).status).toBe(500)
    expect(disk(dir).reservedMicroCny).toBe(1_000_000)
    expect((await budget.fetch(upstream)(ENDPOINT, request())).status).toBe(429)
    await expect(budget.fetch(upstream)(ASR, asrRequest())).rejects.toThrow('quota')
    budget.close(); vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2040, 0, 1))
    const reopened = open(dir)
    expect(reopened.remainingMicroCny).toBe(0)
    expect((await reopened.fetch(upstream)(ENDPOINT, request())).status).toBe(429)
    expect(upstream).toHaveBeenCalledOnce()
  })
  it('does not refund transport failures, mid-flight cancellation or unknown results; retry costs again', async () => {
    const dir = directory(), budget = open(dir), controller = new AbortController()
    const upstream = vi.fn(async () => { controller.abort(); throw new Error('unknown remote outcome') })
    await expect(budget.fetch(upstream)(ASR, { ...asrRequest(), signal: controller.signal })).rejects.toThrow('unknown')
    expect(disk(dir).reservedMicroCny).toBe(AUDIO_POLICY.asrReservationMicroCny)
    await expect(budget.fetch(upstream)(ASR, asrRequest())).rejects.toThrow('unknown')
    expect(disk(dir).reservedMicroCny).toBe(AUDIO_POLICY.asrReservationMicroCny * 2)
    expect(disk(dir).attempts).toBe(2)
  })
  it('does not dispatch or charge requests cancelled before admission', async () => {
    const dir = directory(), budget = open(dir), controller = new AbortController(), upstream = vi.fn(async () => new Response('{}'))
    controller.abort()
    await expect(budget.fetch(upstream)(ASR, { ...asrRequest(), signal: controller.signal })).rejects.toThrow()
    await expect(budget.fetch(upstream)(ENDPOINT, { ...request(), signal: controller.signal })).rejects.toThrow()
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).reservedMicroCny).toBe(0)
  })
  it('does not dispatch after a reservation write fails, and latches the failure', async () => {
    const dir = directory(), budget = open(dir), upstream = vi.fn(async () => new Response('{}'))
    writeFileSync(join(dir, 'audio-budget.pending'), 'preexisting unresolved write', { mode: 0o600 })
    await expect(budget.fetch(upstream)(ASR, asrRequest())).rejects.toThrow('unavailable')
    rmSync(join(dir, 'audio-budget.pending'))
    await expect(budget.fetch(upstream)(ASR, asrRequest())).rejects.toThrow('unavailable')
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).reservedMicroCny).toBe(0)
  })
  it.each([
    ['https://evil.example/api-ws/v1/realtime', asrRequest()],
    [ASR + '&extra=1', asrRequest()], [ASR, { method: 'POST', ...asrRequest() }],
    [ASR, { ...asrRequest(), body: 'not audio' }], [ASR, {}],
    [ASR, { ...asrRequest(), redirect: 'follow' }], [ASR, { ...asrRequest(), redirect: undefined }],
    [ENDPOINT, request({ model: 'deepseek-v4-pro' })], [ENDPOINT, request({ stream: true })],
    [ENDPOINT, request({ max_tokens: 8193 })], [ENDPOINT, request({ tools: [] })]
  ])('rejects unsupported endpoint/request %# before reserve or dispatch', async (url, init) => {
    const dir = directory(), budget = open(dir), upstream = vi.fn(async () => new Response('{}'))
    await expect(budget.fetch(upstream)(url as string, init as RequestInit)).rejects.toThrow()
    expect(upstream).not.toHaveBeenCalled(); expect(disk(dir).reservedMicroCny).toBe(0)
  })
})
