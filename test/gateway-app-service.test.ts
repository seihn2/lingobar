import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppService, APP_ASR_RESERVATION_MICRO_CNY, APP_SESSION_COMPLETIONS } from '../src/gateway/app-service'
import { AppAuth, type Principal } from '../src/gateway/app-auth'
import { AccountBudget } from '../src/gateway/account-budget'
import { quoteWebTextRequest, TEXT_MAX_RESERVATION_MICRO_CNY } from '../src/gateway/text-budget'
import { configuration, now } from './gateway-fixture'
import type { WorkerFetch } from '../src/worker/types'

const ASR = 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'
const TEXT = 'https://api.deepseek.com/chat/completions'
const ID = '11111111-1111-4111-8111-111111111111', COOKIE = 'synthetic-cookie'
const MINIMUM = APP_ASR_RESERVATION_MICRO_CNY + TEXT_MAX_RESERVATION_MICRO_CNY
const cleanups: Array<() => void> = []
const asrInit = (): RequestInit => ({ redirect: 'error', headers: { Upgrade: 'websocket', Authorization: 'Bearer synthetic-asr' } })
const textInit = (): RequestInit => ({ method: 'POST', redirect: 'error', body: JSON.stringify({ model: 'deepseek-flash',
  messages: [{ role: 'system', content: 'Translate.' }, { role: 'user', content: 'Synthetic text.' }],
  stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 128 }) })
const QUOTE = quoteWebTextRequest(TEXT, textInit()).reservationMicroCny
function fixture(siteCap = 1_000_000, userCap = siteCap, guest = false) {
  function directory() { const dir = mkdtempSync(join(tmpdir(), 'lingobar-app-service-')); chmodSync(dir, 0o700); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
  const authDir = directory(), budgetDir = directory(), initial = new AccountBudget(budgetDir, 0); initial.close()
  const budget = new AccountBudget(budgetDir, siteCap), auth = new AppAuth(authDir, () => now)
  cleanups.push(() => budget.close(), () => auth.close())
  const principal: Principal = guest ? { id: ID, kind: 'guest', role: 'user', translationKey: 'synthetic-guest-translation', asrKey: 'synthetic-guest-asr', expiresAt: now + 3600_000 }
    : { id: ID, kind: 'account', role: 'user', username: 'synthetic-user', limitMicroCny: userCap, expiresAt: now + 3600_000 }
  // Only identity resolution is synthetic; real private ledgers and money checks run.
  const resolve = vi.spyOn(auth, 'resolve').mockImplementation(cookie => cookie === COOKIE ? principal : null)
  const upstream = vi.fn<WorkerFetch>(async () => new Response('{}'))
  const service = new AppService(configuration(''), auth, budget, upstream, () => now)
  const disk = () => JSON.parse(readFileSync(join(budgetDir, 'accounts-budget.json'), 'utf8'))
  return { service, principal, budget, upstream, disk, resolve, budgetDir }
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real provider forbidden') })))
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe.skipIf(process.platform !== 'linux')('application session transport: formula allowances, synthetic upstream only', () => {
  it('requires 19800 ASR plus 81920 first-translation headroom in both caps', () => {
    expect(APP_ASR_RESERVATION_MICRO_CNY).toBe(19_800)
    expect(TEXT_MAX_RESERVATION_MICRO_CNY).toBe(81_920)
    const insufficientSite = fixture(MINIMUM - 1, MINIMUM)
    expect(insufficientSite.service.audioStatus(insufficientSite.principal)).toBe('quota')
    const insufficientUser = fixture(MINIMUM, MINIMUM - 1)
    expect(insufficientUser.service.audioStatus(insufficientUser.principal)).toBe('quota')
    const exact = fixture(MINIMUM)
    expect(exact.service.audioStatus(exact.principal)).toBe('ready')
  })
  it('reserves audio before its one upstream connection and bills each later completion separately', async () => {
    const f = fixture(), transport = f.service.sessionTransport(f.principal, COOKIE)
    f.upstream.mockImplementationOnce(async () => { expect(f.disk()).toEqual({ version: 1, spentMicroCny: 19_800, accounts: { [ID]: 19_800 } }); return new Response('{}') })
    await transport(ASR, asrInit())
    await transport(TEXT, textInit())
    expect(f.disk().spentMicroCny).toBe(19_800 + QUOTE)
    expect(f.disk().accounts[ID]).toBe(19_800 + QUOTE)
    await expect(transport(ASR, asrInit())).rejects.toThrow('unavailable')
    expect(f.upstream).toHaveBeenCalledTimes(2)
  })
  it('rejects completion before ASR, and limits actual attempts including retries to 40', async () => {
    const f = fixture(), transport = f.service.sessionTransport(f.principal, COOKIE)
    await expect(transport(TEXT, textInit())).rejects.toThrow('quota')
    expect(f.upstream).not.toHaveBeenCalled()
    await transport(ASR, asrInit())
    f.upstream.mockImplementation(async () => { throw new Error('synthetic retryable failure') })
    for (let i = 0; i < APP_SESSION_COMPLETIONS; i++) await expect(transport(TEXT, textInit())).rejects.toThrow('retryable')
    await expect(transport(TEXT, textInit())).rejects.toThrow('quota')
    expect(f.upstream).toHaveBeenCalledTimes(41)
    expect(f.disk().spentMicroCny).toBe(19_800 + QUOTE * 40)
  })
  it('rejects ASR through non-session transport without a reservation', async () => {
    const f = fixture()
    await expect(f.service.transport(f.principal, COOKIE)(ASR, asrInit())).rejects.toThrow('unavailable')
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.disk().spentMicroCny).toBe(0)
  })
  it.each([{ body: 'unexpected' }, { method: 'POST' }, { headers: {} }])('rejects malformed ASR handshake %# without spending', async patch => {
    const f = fixture()
    await expect(f.service.sessionTransport(f.principal, COOKIE)(ASR, { ...asrInit(), ...patch })).rejects.toThrow()
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.disk().spentMicroCny).toBe(0)
  })
  it('retains unknown/aborted connection allowance, prohibits retry in that session, and survives restart', async () => {
    const f = fixture(), controller = new AbortController(), transport = f.service.sessionTransport(f.principal, COOKIE)
    f.upstream.mockImplementation(async () => { controller.abort(); throw new Error('unknown provider outcome') })
    await expect(transport(ASR, { ...asrInit(), signal: controller.signal })).rejects.toThrow('unknown')
    await expect(transport(ASR, asrInit())).rejects.toThrow('unavailable')
    expect(f.upstream).toHaveBeenCalledOnce(); expect(f.disk().spentMicroCny).toBe(19_800)
    f.budget.close()
    const reopened = new AccountBudget(f.budgetDir, 1_000_000); cleanups.push(() => reopened.close())
    expect(reopened.remaining(ID, 1_000_000)).toBe(980_200)
  })
  it('does not reserve pre-aborted or revoked requests', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort()
    await expect(f.service.sessionTransport(f.principal, COOKIE)(ASR, { ...asrInit(), signal: controller.signal })).rejects.toThrow('unauthorized')
    f.resolve.mockReturnValue(null)
    await expect(f.service.sessionTransport(f.principal, COOKIE)(ASR, asrInit())).rejects.toThrow('unauthorized')
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.disk().spentMicroCny).toBe(0)
  })
  it('guest own-key ASR and 40 completions bypass shared money but not attempt limits', async () => {
    const f = fixture(0, 0, true), transport = f.service.sessionTransport(f.principal, COOKIE)
    expect(f.service.audioStatus(f.principal)).toBe('ready')
    expect(f.service.keys(f.principal)).toMatchObject({ translationKey: 'synthetic-guest-translation', asrKey: 'synthetic-guest-asr' })
    await transport(ASR, asrInit())
    for (let i = 0; i < 40; i++) await transport(TEXT, textInit())
    await expect(transport(TEXT, textInit())).rejects.toThrow('quota')
    expect(f.disk()).toEqual({ version: 1, spentMicroCny: 0, accounts: {} })
    expect(f.upstream).toHaveBeenCalledTimes(41)
  })
  it.each([[0, 1_000_000], [1_000_000, 0]])('zero site/account cap %s/%s blocks paid audio and text', async (site, individual) => {
    const f = fixture(site, individual)
    await expect(f.service.sessionTransport(f.principal, COOKIE)(ASR, asrInit())).rejects.toThrow('unavailable')
    expect((await f.service.transport(f.principal, COOKIE)(TEXT, textInit())).status).toBe(429)
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.disk().spentMicroCny).toBe(0)
  })
})
