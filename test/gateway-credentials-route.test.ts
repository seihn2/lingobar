import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGateway } from '../src/gateway/server'
import { saveTranslationKey } from '../src/gateway/credentials'
import { configuration, jwks, now, token } from './gateway-fixture'
import type { WorkerFetch } from '../src/worker/types'

const require = createRequire(import.meta.url)
const { initializeLedger } = require('../scripts/plan-one-rmb-test.cjs')
const cleanups: Array<() => Promise<void> | void> = []
const forbidden = vi.fn(() => { throw new Error('Real network forbidden') })
beforeEach(() => { forbidden.mockClear(); vi.stubGlobal('fetch', forbidden) })
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
const PATH = '/api/settings/translation-key'
const DUMMY = 'dummy-owner-input-not-a-real-key'
const TEXT = { version: 1, requestId: 'owner-configured-text', original: 'Synthetic source.', targetLanguages: ['zh'], showFurigana: false }
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-owner-key-')); chmodSync(dir, 0o700)
  cleanups.push(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }) })
  initializeLedger(dir)
  const file = join(dir, 'deepseek.json')
  const config = { ...configuration(''), asrKey: '', translationKey: '', audioEnabled: false, text: { ledgerDirectory: dir }, credentialsFile: file }
  const upstream = vi.fn<WorkerFetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${config.translationKey}`)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ language: '英语', translations: { zh: '合成译文' } }) } }] })
  })
  const gateway = createGateway(config, { upstream, publicFetch: jwks, now: () => now })
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => gateway.close())
  const port = (gateway.server.address() as { port: number }).port
  const http = (method: string, path = PATH, body?: unknown, overrides: Record<string, string> = {}) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: {
      Host: 'lingobar.example', ...(method === 'GET' ? {} : { Origin: config.origin }),
      'Cf-Access-Jwt-Assertion': token(), 'Content-Type': 'application/json', ...overrides
    } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part }); res.on('end', () => resolve({ status: res.statusCode!, text }))
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const reserved = () => JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8')).reservedMicroCny
  return { dir, file, config, upstream, http, reserved }
}

describe.skipIf(process.platform !== 'linux')('owner HTTPS credential configuration behind existing Access verification', () => {
  it('allows empty-key boot, exposes only readiness and refuses charged operations before configuration', async () => {
    const f = await fixture()
    expect(await f.http('GET')).toEqual({ status: 200, text: '{"configured":false}' })
    expect(JSON.parse((await f.http('GET', '/app-config.json')).text)).toEqual({ version: 1, backend: null, textBackend: null, credentialsBackend: PATH })
    expect((await f.http('POST', '/api/translate', TEXT)).status).toBe(503)
    expect((await f.http('POST', '/api/annotation', {})).status).toBe(503)
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.reserved()).toBe(0); expect(existsSync(f.file)).toBe(false)
  })

  it('requires the owner assertion and exact host/origin before accepting any key', async () => {
    const f = await fixture()
    for (const headers of [{ 'Cf-Access-Jwt-Assertion': '' }, { 'Cf-Access-Jwt-Assertion': 'forged' },
      { 'Cf-Access-Jwt-Assertion': token({ email: 'someone-else@example.test' }) }, { Host: 'forged.example' },
      { Origin: 'https://forged.example' }, { Origin: '' }] as Array<Record<string, string>>) {
      const result = await f.http('POST', PATH, { apiKey: DUMMY }, headers)
      expect([401, 403]).toContain(result.status); expect(result.text).not.toContain(DUMMY)
    }
    expect((await f.http('GET', PATH, undefined, { Origin: 'https://forged.example' })).status).toBe(403)
    expect(existsSync(f.file)).toBe(false); expect(f.config.translationKey).toBe(''); expect(f.reserved()).toBe(0)
  })

  it('saves a private file and immediately uses the new key without echoing it or restarting', async () => {
    const f = await fixture()
    expect(await f.http('POST', PATH, { apiKey: DUMMY })).toEqual({ status: 200, text: '{"configured":true}' })
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ apiKey: DUMMY })
    expect(statSync(f.file).mode & 0o777).toBe(0o600)
    expect(await f.http('GET')).toEqual({ status: 200, text: '{"configured":true}' })
    expect(JSON.parse((await f.http('GET', '/app-config.json')).text).textBackend).toBe('/api/translate')
    const translated = await f.http('POST', '/api/translate', TEXT)
    expect(translated.status).toBe(200); expect(JSON.parse(translated.text).caption.translations).toEqual({ zh: '合成译文' })
    expect(translated.text).not.toContain(DUMMY); expect(f.upstream).toHaveBeenCalledOnce()
    const replacement = DUMMY + '-replacement'
    expect((await f.http('POST', PATH, { apiKey: replacement })).status).toBe(200)
    expect(f.config.translationKey).toBe(replacement); expect(JSON.parse(readFileSync(f.file, 'utf8')).apiKey).toBe(replacement)
    expect(readdirSync(f.dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects bad bodies and failed publication while retaining the active key and zero configuration charges', async () => {
    const f = await fixture()
    expect((await f.http('POST', PATH, { apiKey: DUMMY })).status).toBe(200)
    for (const value of [{ apiKey: 'short' }, { apiKey: DUMMY + '\n' }, { apiKey: DUMMY, filename: '/tmp/untrusted' }, { apiKey: 'x'.repeat(8192) }]) {
      const result = await f.http('POST', PATH, value)
      expect(result.status).toBe(400); expect(result.text).not.toContain(DUMMY)
    }
    chmodSync(f.dir, 0o500)
    const result = await f.http('POST', PATH, { apiKey: DUMMY + '-new' })
    chmodSync(f.dir, 0o700)
    expect(result.status).toBe(503); expect(result.text).toBe('{"error":"unavailable"}')
    expect(f.config.translationKey).toBe(DUMMY); expect(JSON.parse(readFileSync(f.file, 'utf8')).apiKey).toBe(DUMMY)
    expect(f.upstream).not.toHaveBeenCalled(); expect(f.reserved()).toBe(0)
  })

  it('does not save through a nonprivate directory or accept non-key-shaped input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingobar-invalid-key-dir-'))
    try {
      chmodSync(dir, 0o755)
      expect(() => saveTranslationKey(join(dir, 'key.json'), DUMMY)).toThrow('Translation credential unavailable')
      chmodSync(dir, 0o700)
      expect(() => saveTranslationKey(join(dir, 'key.json'), 'short')).toThrow('Translation credential unavailable')
      expect(readdirSync(dir)).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
