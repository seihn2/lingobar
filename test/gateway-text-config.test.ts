import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayConfig } from '../src/gateway/config'
const env = { WEB_ENABLED:'0', WEB_TEXT_ENABLED:'1', GATEWAY_PUBLIC_ORIGIN:'https://lingobar.example', ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE:'a'.repeat(64), ACCESS_ALLOWED_EMAIL:'synthetic@example.test', TRANSLATION_API_KEY:'synthetic-key-not-real', GATEWAY_TEXT_LEDGER_DIRECTORY:'/tmp/synthetic-existing-ledger' }
describe('text-only gateway enablement', () => {
  it('uses formal environment key and existing cumulative ledger without ASR or daily counters', () => {
    const c=gatewayConfig(env)!
    expect(c.audioEnabled).toBe(false); expect(c.asrKey).toBe(''); expect(c.translationKey).toBe(env.TRANSLATION_API_KEY)
    expect(c.text?.ledgerDirectory).toBe(env.GATEWAY_TEXT_LEDGER_DIRECTORY)
  })
  it('stays disabled by default and refuses mixed audio or missing text setup', () => {
    expect(gatewayConfig({})).toBe(null)
    for(const changed of [{WEB_ENABLED:'1'},{TRANSLATION_API_KEY:''},{GATEWAY_TEXT_LEDGER_DIRECTORY:''}]) expect(()=>gatewayConfig({...env,...changed})).toThrow()
  })
  it.skipIf(process.platform === 'win32')('reads the explicitly selected existing JSON once, without requiring another key value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lingobar-dummy-server-key-'))
    const filename = join(directory, 'deepseek.json')
    try {
      writeFileSync(filename, JSON.stringify({ apiKey:'synthetic-file-key-never-real' }), { mode:0o600 })
      const c = gatewayConfig({ ...env, TRANSLATION_API_KEY:'', TRANSLATION_API_KEY_FILE:filename })!
      expect(c.translationKey).toBe('synthetic-file-key-never-real')
      writeFileSync(filename, '{invalid')
      expect(()=>gatewayConfig({ ...env, TRANSLATION_API_KEY_FILE:filename })).toThrow('Invalid gateway configuration')
    } finally { rmSync(directory, { recursive:true, force:true }) }
  })

})
