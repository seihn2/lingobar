import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayConfig } from '../src/gateway/config'
import { createGateway } from '../src/gateway/server'
import { AUDIO_POLICY } from '../src/gateway/audio-policy'
import { configuration, jwks, now, token } from './gateway-fixture'
import type { WorkerFetch } from '../src/worker/types'
const require = createRequire(import.meta.url)
const { initializeLedger, OneRmbTestLedger } = require('../scripts/plan-one-rmb-test.cjs')
const cleanup: Array<() => void | Promise<void>> = []
const forbidden = vi.fn(() => { throw new Error('Real network forbidden') })
beforeEach(() => { forbidden.mockClear(); vi.stubGlobal('fetch', forbidden) })
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
const PATH = '/api/settings/asr-key', DUMMY = 'synthetic-asr-input-not-a-real-key'
const TEXT = { version: 1, requestId: 'mixed-audio-text', original: 'Synthetic sentence.', targetLanguages: ['zh'], showFurigana: false }
function env(root: string) {
  const c = configuration('')
  return { WEB_ENABLED: '1', WEB_TEXT_ENABLED: '1', GATEWAY_PUBLIC_ORIGIN: c.origin, ACCESS_ISSUER: c.issuer,
    ACCESS_AUDIENCE: c.audience, ACCESS_ALLOWED_EMAIL: c.email, GATEWAY_STATE_DIRECTORY: join(root, 'daily'),
    GATEWAY_DAILY_SESSIONS: '2', GATEWAY_DAILY_COMPLETION_REQUESTS: '100', GATEWAY_TEXT_LEDGER_DIRECTORY: join(root, 'text'),
    GATEWAY_AUDIO_LEDGER_DIRECTORY: join(root, 'audio'), ASR_API_KEY_FILE: join(root, 'asr.json'), TRANSLATION_API_KEY: 'synthetic-deepseek-not-real' }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lingobar-audio-setup-')); chmodSync(root, 0o700)
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const e = env(root)
  mkdirSync(e.GATEWAY_TEXT_LEDGER_DIRECTORY, { mode: 0o700 }); initializeLedger(e.GATEWAY_TEXT_LEDGER_DIRECTORY)
  const old = new OneRmbTestLedger(e.GATEWAY_TEXT_LEDGER_DIRECTORY); old.reserveWebText(1000); old.close()
  mkdirSync(e.GATEWAY_AUDIO_LEDGER_DIRECTORY, { mode: 0o700 })
  const audioFile = join(e.GATEWAY_AUDIO_LEDGER_DIRECTORY, 'audio-budget.json')
  writeFileSync(audioFile, JSON.stringify({ version: 1, batch: 'lingobar-audio-test-2026-10-30', reservedMicroCny: 0, attempts: 0 }), { mode: 0o600 })
  const config = gatewayConfig(e)!
  const upstream = vi.fn<WorkerFetch>(async (url, init) => {
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + e.TRANSLATION_API_KEY)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ language: '英语', translations: { zh: '合成译文' } }) } }] })
  })
  const gateway = createGateway(config, { upstream, publicFetch: jwks, now: () => now })
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => gateway.close())
  const port = (gateway.server.address() as { port: number }).port
  const http = (method: string, path = PATH, body?: unknown, overrides: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: 'lingobar.example',
      ...(method === 'GET' ? {} : { Origin: config.origin }), 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token(), ...overrides } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode!, text }))
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const ledger = () => JSON.parse(readFileSync(join(e.GATEWAY_TEXT_LEDGER_DIRECTORY, 'test-budget.json'), 'utf8'))
  const audio = () => JSON.parse(readFileSync(audioFile, 'utf8'))
  return { root, e, config, http, upstream, ledger, audio }
}

describe.skipIf(process.platform !== 'linux')('mixed web setup remains fail-closed for unproved ASR billing', () => {
  it('accepts complete mixed configuration but requires a separate explicit audio ledger', () => {
    expect(AUDIO_POLICY.verified).toBe(false)
    const e = env('/tmp/synthetic-test-only')
    const c = gatewayConfig(e)!
    expect(c).toMatchObject({ audioRequested: true, audioLedgerDirectory: e.GATEWAY_AUDIO_LEDGER_DIRECTORY, asrKey: '', asrCredentialsFile: e.ASR_API_KEY_FILE })
    expect(c.text?.ledgerDirectory).toBe(e.GATEWAY_TEXT_LEDGER_DIRECTORY)
    for (const path of ['', 'relative', e.GATEWAY_TEXT_LEDGER_DIRECTORY, e.GATEWAY_STATE_DIRECTORY]) {
      expect(() => gatewayConfig({ ...e, GATEWAY_AUDIO_LEDGER_DIRECTORY: path })).toThrow()
    }
  })
  it('saves private ASR credentials without echo/calls; readiness stays blocked after save', async () => {
    const f = await fixture()
    expect(await f.http('GET')).toEqual({ status: 200, text: '{"configured":false}' })
    expect(JSON.parse((await f.http('GET', '/app-config.json')).text)).toMatchObject({ backend: null, textBackend: '/api/translate', audioStatus: 'missing-key', asrCredentialsBackend: PATH })
    expect(await f.http('POST', PATH, { apiKey: DUMMY })).toEqual({ status: 200, text: '{"configured":true}' })
    expect(statSync(f.e.ASR_API_KEY_FILE).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(f.e.ASR_API_KEY_FILE, 'utf8'))).toEqual({ apiKey: DUMMY })
    const publicConfig = await f.http('GET', '/app-config.json')
    expect(publicConfig.text).not.toContain(DUMMY)
    expect(JSON.parse(publicConfig.text)).toMatchObject({ backend: null, textBackend: '/api/translate', audioStatus: 'budget-unverified' })
    expect((await f.http('GET', '/api/session')).status).toBe(503)
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.ledger().reservedMicroCny).toBe(1000)
    expect(f.audio()).toMatchObject({ reservedMicroCny: 0, attempts: 0 })
  })
  it('rejects unauthorized/forged/wrong-origin ASR saves without changing key or either ledger', async () => {
    const f = await fixture()
    for (const headers of [{ 'Cf-Access-Jwt-Assertion': '' }, { 'Cf-Access-Jwt-Assertion': 'forged' },
      { 'Cf-Access-Jwt-Assertion': token({ email: 'someone-else@example.test' }) }, { Origin: '' },
      { Origin: 'https://attacker.example' }, { Host: 'attacker.example' }] as Record<string, string>[]) {
      const r = await f.http('POST', PATH, { apiKey: DUMMY }, headers)
      expect([401, 403]).toContain(r.status); expect(r.text).not.toContain(DUMMY)
    }
    expect(existsSync(f.e.ASR_API_KEY_FILE)).toBe(false); expect(f.config.asrKey).toBe('')
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.ledger().reservedMicroCny).toBe(1000)
    expect(f.audio()).toMatchObject({ reservedMicroCny: 0, attempts: 0 })
  })
  it('keeps original text balance and translates through its old ledger, never the new audio allowance', async () => {
    const f = await fixture(), before = f.ledger()
    expect((await f.http('POST', PATH, { apiKey: DUMMY })).status).toBe(200)
    const translated = await f.http('POST', '/api/translate', TEXT)
    expect(translated.status).toBe(200)
    expect(JSON.parse(translated.text).caption.translations).toEqual({ zh: '合成译文' })
    expect(f.upstream).toHaveBeenCalledOnce(); expect(f.ledger().reservedMicroCny).toBeGreaterThan(before.reservedMicroCny)
    expect(f.audio()).toMatchObject({ reservedMicroCny: 0, attempts: 0 })
    expect(translated.text).not.toContain(DUMMY)
  })
})
