import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { gatewayConfig } from '../src/gateway/config'
import { createGateway } from '../src/gateway/server'
import { configuration } from './gateway-fixture'
const require = createRequire(import.meta.url)
const { initializeLedger, OneRmbTestLedger } = require('../scripts/plan-one-rmb-test.cjs')
describe.skipIf(process.platform !== 'linux')('audio startup cleanup and same-file credential protection', () => {
  it('rejects credential targets with ancestor symlink aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'lingobar-path-'))
    try {
      mkdirSync(join(root, 'real'), { mode: 0o700 }); mkdirSync(join(root, 'real/keys'), { mode: 0o700 })
      symlinkSync(join(root, 'real'), join(root, 'alias'))
      const c = configuration('')
      expect(() => gatewayConfig({ WEB_TEXT_ENABLED: '1', GATEWAY_PUBLIC_ORIGIN: c.origin, ACCESS_ISSUER: c.issuer,
        ACCESS_AUDIENCE: c.audience, ACCESS_ALLOWED_EMAIL: c.email, GATEWAY_TEXT_LEDGER_DIRECTORY: root,
        ASR_API_KEY_FILE: join(root, 'alias/keys/key.json'), TRANSLATION_API_KEY_FILE: join(root, 'real/keys/key.json') })).toThrow('Invalid gateway configuration')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('releases acquired daily/audio locks after failed initialization and can restart after correction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lingobar-startup-'))
    let gateway: ReturnType<typeof createGateway> | undefined
    try {
      const daily = join(root, 'daily'), audio = join(root, 'audio'), text = join(root, 'text')
      mkdirSync(audio, { mode: 0o700 }); mkdirSync(text, { mode: 0o700 }); initializeLedger(text)
      const config = { ...configuration(daily), audioLedgerDirectory: audio, text: { ledgerDirectory: text } }
      expect(() => createGateway(config)).toThrow('Audio budget unavailable')
      expect(existsSync(join(daily, 'gateway.lock'))).toBe(false)
      writeFileSync(join(audio, 'audio-budget.json'), JSON.stringify({ version: 1, batch: 'lingobar-audio-test-2026-10-30', reservedMicroCny: 0, attempts: 0 }), { mode: 0o600 })
      const other = new OneRmbTestLedger(text)
      try {
        expect(() => createGateway(config)).toThrow()
        expect(existsSync(join(daily, 'gateway.lock'))).toBe(false)
        expect(existsSync(join(audio, 'audio.lock'))).toBe(false)
        // The failed startup must not release the other owner's text ledger lock.
        expect(() => new OneRmbTestLedger(text)).toThrow()
      } finally { other.close() }
      gateway = createGateway(config)
      await gateway.close(); gateway = undefined
    } finally { await gateway?.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
