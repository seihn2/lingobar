import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { AccountBudget } from '../src/gateway/account-budget'
import { quoteWebTextRequest } from '../src/gateway/text-budget'
import { createGateway } from '../src/gateway/server'
import { configuration, jwks, now, token } from './gateway-fixture'
import type { WorkerFetch, WorkerSocket } from '../src/worker/types'
const require = createRequire(import.meta.url)
const { initializeLedger, OneRmbTestLedger } = require('../scripts/plan-one-rmb-test.cjs')
const cleanups: Array<() => void | Promise<void>> = []
const forbidden = vi.fn(() => { throw new Error('Real upstream forbidden') })
beforeEach(() => { forbidden.mockClear(); vi.stubGlobal('fetch', forbidden) })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
const input = { version: 1, requestId: 'synthetic-public-text', original: 'Synthetic school sentence.', targetLanguages: ['ja', 'zh'], showFurigana: false }
const account = { username: 'syntheticadmin', password: 'Synthetic-password-123!' }
const keyA = 'synthetic-guest-key-A-12345', keyB = 'synthetic-guest-key-B-12345'
const reply = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ language: '英语', translations: { ja: '学校', zh: '学校' } }) } }] })
type Result = { status: number; text: string; headers: IncomingHttpHeaders }
const cookie = (r: Result) => r.headers['set-cookie']?.[0].split(';')[0] || ''
async function fixture(siteLimitMicroCny = 0) {
  let currentTime = now
  const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'lingobar-public-auth-')); chmodSync(dir, 0o700); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
  const ownerDir = directory(), appDir = directory(), budgetDir = directory()
  initializeLedger(ownerDir); const old = new OneRmbTestLedger(ownerDir); old.reserve('translation'); old.close()
  writeFileSync(join(ownerDir, 'audio-budget.json'), 'untouched-owner-audio-marker', { mode: 0o600 })
  const upstream = vi.fn<WorkerFetch>(async () => reply())
  const initial = new AccountBudget(budgetDir, 0); initial.close()
  const config = { ...configuration(''), audioEnabled: false, text: { ledgerDirectory: ownerDir },
    credentialsFile: join(ownerDir, 'translation-key.json'), asrCredentialsFile: join(ownerDir, 'asr-key.json'),
    app: { directory: appDir, budgetDirectory: budgetDir, siteLimitMicroCny, sharedAudioFreeStopVerified: false } }
  const gateway = createGateway(config, { upstream, publicFetch: jwks, now: () => currentTime })
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => gateway.close())
  const port = (gateway.server.address() as { port: number }).port
  const http = (path: string, body?: unknown, extra: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST', raw = false) => new Promise<Result>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: { Host: 'lingobar.example', Origin: config.origin, 'Content-Type': 'application/json', ...extra } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode!, text, headers: res.headers }))
    }); req.on('error', reject); req.end(body === undefined ? undefined : raw ? body as string : JSON.stringify(body))
  })
  const owner = { 'Cf-Access-Jwt-Assertion': token() }
  const guest = async (key = keyA) => {
    const result = await http('/api/auth/guest', { translationKey: key, acceptCharges: true })
    expect(result.status).toBe(200); expect(cookie(result)).not.toBe(''); return { Cookie: cookie(result) }
  }
  return { http, owner, guest, upstream, ownerDir, appDir, budgetDir,
    advance: (ms: number) => { currentTime += ms },
    ws: (session: Record<string, string>) => { const socket = new WebSocket(`ws://127.0.0.1:${port}/api/session`, { headers: { Host: 'lingobar.example', Origin: config.origin, ...session } }); socket.on('error', () => {}); return socket } }
}

describe.skipIf(process.platform !== 'linux')('public application authentication: loopback HTTP, synthetic providers only', () => {
  it('advertises only public auth to anonymous visitors, never owner keys or setup routes', async () => {
    const f = await fixture(), result = await f.http('/app-config.json')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text)).toEqual({ version: 1, backend: null, textBackend: null, authBackend: '/api/auth' })
    expect(result.text).not.toMatch(/synthetic-translation|synthetic-asr|credentialsBackend/)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(JSON.parse((await f.http('/api/auth/status')).text)).toMatchObject({ kind: 'anonymous', initialized: false, bootstrapAllowed: false })
    expect((await f.http('/api/translate', input)).status).toBe(401)
    expect(f.upstream).not.toHaveBeenCalled()
  })
  it('requires cryptographically verified owner bootstrap and creates a secure login cookie', async () => {
    const f = await fixture()
    expect((await f.http('/api/auth/bootstrap', account)).status).toBe(403)
    expect((await f.http('/api/auth/bootstrap', account, { 'Cf-Access-Jwt-Assertion': 'forged' })).status).toBe(403)
    expect((await f.http('/api/auth/bootstrap', account, f.owner)).status).toBe(200)
    const login = await f.http('/api/auth/login', account)
    expect(login.status).toBe(200)
    expect(login.headers['set-cookie']?.[0]).toMatch(/__Host-lingobar-session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/)
    expect(login.text).not.toMatch(/password|synthetic-translation|synthetic-asr/)
    expect((await f.http('/api/auth/bootstrap', account, { Cookie: cookie(login) })).status).toBe(403)
    const contents = readFileSync(join(f.appDir, 'accounts.json'), 'utf8')
    expect(contents).not.toContain(account.password)
    expect(JSON.parse(contents).accounts[0].role).toBe('admin')
    expect(f.upstream).not.toHaveBeenCalled()
  })
  it('isolates two BYOK sessions and leaves every owner/shared ledger unchanged', async () => {
    const f = await fixture(), a = await f.guest(keyA), b = await f.guest(keyB)
    const beforeText = readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8')
    const beforeShared = readFileSync(join(f.budgetDir, 'accounts-budget.json'), 'utf8')
    const config = JSON.parse((await f.http('/app-config.json', undefined, a)).text)
    expect(config).toMatchObject({ textBackend: '/api/translate', authBackend: '/api/auth', backend: null })
    expect(config).not.toHaveProperty('credentialsBackend'); expect(config).not.toHaveProperty('asrCredentialsBackend')
    expect((await f.http('/api/translate', input, a)).status).toBe(200)
    expect((await f.http('/api/translate', input, b)).status).toBe(200)
    expect(f.upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization'))).toEqual(['Bearer ' + keyA, 'Bearer ' + keyB])
    for (const [url, init] of f.upstream.mock.calls) {
      expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
      expect(new Headers(init?.headers).has('Cookie')).toBe(false)
      expect(new Headers(init?.headers).has('Cf-Access-Jwt-Assertion')).toBe(false)
    }
    expect(readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8')).toBe(beforeText)
    expect(readFileSync(join(f.budgetDir, 'accounts-budget.json'), 'utf8')).toBe(beforeShared)
    expect(readFileSync(join(f.ownerDir, 'audio-budget.json'), 'utf8')).toBe('untouched-owner-audio-marker')
    for (const filename of readdirSync(f.appDir)) expect(readFileSync(join(f.appDir, filename), 'utf8')).not.toMatch(/synthetic-guest-key/)
  })
  it('revokes logout cookie before any subsequent paid request', async () => {
    const f = await fixture(), guest = await f.guest()
    const logout = await f.http('/api/auth/logout', {}, guest)
    expect(logout.status).toBe(200); expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    expect((await f.http('/api/translate', input, guest)).status).toBe(401)
    expect(JSON.parse((await f.http('/api/auth/status', undefined, guest)).text).kind).toBe('anonymous')
    expect(f.upstream).not.toHaveBeenCalled()
  })
  it('keeps ordinary accounts out of credentials/admin and denies shared calls at zero site allowance', async () => {
    const f = await fixture()
    expect((await f.http('/api/auth/bootstrap', account, f.owner)).status).toBe(200)
    const user = { username: 'syntheticuser', password: 'Synthetic-user-password-123!' }
    expect((await f.http('/api/auth/accounts', { ...user, limitMicroCny: 1_000_000 }, f.owner)).status).toBe(200)
    const login = await f.http('/api/auth/login', user), session = { Cookie: cookie(login) }
    expect(login.status).toBe(200)
    expect((await f.http('/api/auth/accounts', undefined, session)).status).toBe(403)
    expect((await f.http('/api/auth/accounts', { username: 'thirduser', password: account.password }, session)).status).toBe(403)
    for (const path of ['/api/settings/translation-key', '/api/settings/asr-key']) {
      expect((await f.http(path, undefined, session)).status).toBe(403)
      expect((await f.http(path, { apiKey: keyA }, session)).status).toBe(403)
    }
    expect((await f.http('/api/translate', input, session)).status).toBe(429)
    expect(f.upstream).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(f.budgetDir, 'accounts-budget.json'), 'utf8')).spentMicroCny).toBe(0)
  })
  it('rejects missing/cross-site origin and malformed auth/text bodies before provider dispatch', async () => {
    const f = await fixture()
    const guestInput = { translationKey: keyA, acceptCharges: true }
    for (const Origin of ['', 'https://evil.example']) expect((await f.http('/api/auth/guest', guestInput, { Origin })).status).toBe(403)
    for (const body of [{ translationKey: keyA }, { ...guestInput, acceptCharges: false }, { ...guestInput, role: 'admin' }]) expect((await f.http('/api/auth/guest', body)).status).toBe(400)
    expect((await f.http('/api/auth/guest', '{broken', {}, 'POST', true)).status).toBe(400)
    expect((await f.http('/api/auth/guest', guestInput, { 'Content-Type': 'text/plain' })).status).toBe(400)
    const session = await f.guest()
    expect((await f.http('/api/translate', { ...input, extra: true }, session)).status).toBe(400)
    expect((await f.http('/api/translate', input, { ...session, Origin: '' })).status).toBe(403)
    expect(f.upstream).not.toHaveBeenCalled()
  })
  it('retains the existing Access-owner text path and cumulative historical spend', async () => {
    const f = await fixture(), before = JSON.parse(readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8'))
    const config = JSON.parse((await f.http('/app-config.json', undefined, f.owner)).text)
    expect(config.textBackend).toBe('/api/translate'); expect(config.credentialsBackend).toBe('/api/settings/translation-key')
    expect((await f.http('/api/translate', input, f.owner)).status).toBe(200)
    expect(new Headers(f.upstream.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-translation')
    const after = JSON.parse(readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8'))
    expect(after.reservedMicroCny).toBeGreaterThan(before.reservedMicroCny)
    expect(after.attempts[0]).toEqual(before.attempts[0])
    expect(JSON.parse(readFileSync(join(f.budgetDir, 'accounts-budget.json'), 'utf8')).spentMicroCny).toBe(0)
  })
})


class SyntheticAsr extends EventTarget implements WorkerSocket {
  readyState = 1
  binaryType = 'arraybuffer'
  audioFrames = 0
  accept() {}
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data !== 'string') throw new Error('Realtime protocol expects JSON')
    const value = JSON.parse(data)
    if (value.type === 'session.update') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.updated' }) })))
    if (value.type === 'input_audio_buffer.append') this.audioFrames++
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
const start = { version: 1, type: 'start', sessionId: 'synthetic-public-audio', settings: { targetLanguages: ['zh'], showOriginal: true, showFurigana: false } }
async function startGuestAudio(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.http('/api/auth/guest', { translationKey: keyA, asrKey: 'synthetic-guest-asr-123456', acceptCharges: true })
  expect(result.status).toBe(200)
  const session = { Cookie: cookie(result) }, peer = new SyntheticAsr()
  f.upstream.mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-guest-asr-123456')
    expect(new Headers(init?.headers).has('Cookie')).toBe(false)
    return { status: 101, webSocket: peer } as unknown as Response
  })
  const config = JSON.parse((await f.http('/app-config.json', undefined, session)).text)
  expect(config.backend).toBe('/api/session')
  const ws = f.ws(session), messages: Array<{ type: string; code?: string }> = []
  ws.on('message', data => messages.push(JSON.parse(data.toString())))
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  expect(f.upstream).not.toHaveBeenCalled()
  ws.send(JSON.stringify(start))
  await vi.waitFor(() => expect(messages.some(m => m.type === 'ready')).toBe(true))
  return { session, peer, ws, messages }
}
describe.skipIf(process.platform !== 'linux')('public websocket and enabled shared text integration', () => {
  it.each(['logout', 'expiry'])('guest ASR works with owner audio disabled and stops on %s', async reason => {
    const f = await fixture(), beforeText = readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8')
    const audio = await startGuestAudio(f)
    audio.ws.send(Buffer.alloc(3200))
    await vi.waitFor(() => expect(audio.peer.audioFrames).toBe(1))
    if (reason === 'logout') expect((await f.http('/api/auth/logout', {}, audio.session)).status).toBe(200)
    else f.advance(3600_001)
    await vi.waitFor(() => expect(audio.ws.readyState).toBe(WebSocket.CLOSED), { timeout: 2500 })
    expect(audio.peer.readyState).toBe(3)
    expect(f.upstream).toHaveBeenCalledOnce()
    expect(readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8')).toBe(beforeText)
    expect(readFileSync(join(f.ownerDir, 'audio-budget.json'), 'utf8')).toBe('untouched-owner-audio-marker')
    expect(JSON.parse(readFileSync(join(f.budgetDir, 'accounts-budget.json'), 'utf8')).spentMicroCny).toBe(0)
  })
  it('caps guest forwarded PCM at 60 seconds even if client accelerates the stream', async () => {
    const f = await fixture(), audio = await startGuestAudio(f)
    for (let frame = 1; frame <= 30; frame++) {
      f.advance(2000); audio.ws.send(Buffer.alloc(64000))
      await vi.waitFor(() => expect(audio.peer.audioFrames).toBe(frame))
    }
    f.advance(2000); audio.ws.send(Buffer.alloc(64000))
    await vi.waitFor(() => expect(audio.ws.readyState).toBe(WebSocket.CLOSED))
    expect(audio.peer.audioFrames).toBe(30)
    expect(audio.messages.at(-1)).toMatchObject({ type: 'error', code: 'quota' })
    expect(f.upstream).toHaveBeenCalledOnce()
  })
  it('charges configured shared accounts against only their independent site/account ledger', async () => {
    const f = await fixture(1_000_000), beforeText = readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8')
    expect((await f.http('/api/auth/bootstrap', account, f.owner)).status).toBe(200)
    const user = { username: 'fundeduser', password: 'Synthetic-funded-password-123!' }
    expect((await f.http('/api/auth/accounts', user, f.owner)).status).toBe(200)
    expect((await f.http('/api/auth/accounts', { username: user.username, limitMicroCny: 100_000 }, f.owner, 'PATCH')).status).toBe(200)
    const login = await f.http('/api/auth/login', user), session = { Cookie: cookie(login) }
    expect(login.status).toBe(200)
    expect(JSON.parse((await f.http('/app-config.json', undefined, session)).text).textBackend).toBe('/api/translate')
    expect((await f.http('/api/translate', input, session)).status).toBe(200)
    expect(new Headers(f.upstream.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic-translation')
    const quote = quoteWebTextRequest(...f.upstream.mock.calls[0]).reservationMicroCny
    const ledger = JSON.parse(readFileSync(join(f.budgetDir, 'accounts-budget.json'), 'utf8'))
    expect(ledger.spentMicroCny).toBe(quote); expect(Object.values(ledger.accounts)).toEqual([quote])
    expect((await f.http('/api/translate', input, session)).status).toBe(429)
    expect(f.upstream).toHaveBeenCalledOnce()
    expect(readFileSync(join(f.ownerDir, 'test-budget.json'), 'utf8')).toBe(beforeText)
    expect((await f.http('/api/auth/accounts', { username: user.username, limitMicroCny: 0 }, f.owner, 'PATCH')).status).toBe(200)
    expect((await f.http('/api/translate', input, session)).status).toBe(401)
  })
})
