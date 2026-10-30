import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessVerifier } from '../src/gateway/access'
import { gatewayConfig } from '../src/gateway/config'
import { configuration, jwks, now, publicJwk, token } from './gateway-fixture'

afterEach(() => vi.useRealTimers())
describe('VM gateway Access verification with generated synthetic signatures', () => {
  it('pins issuer/JWKS, verifies RS256 and caches bounded public keys, returning no email or raw JWT', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(jwks), verifier = new AccessVerifier(configuration(''), fetch, () => now)
    expect(await verifier.validate(token())).toEqual({ exp: now / 1000 + 3600, sub: 'synthetic-subject' })
    expect(await verifier.validate(token())).not.toBeNull(); expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]).toMatchObject([configuration('').issuer + '/cdn-cgi/access/certs', { redirect: 'error' }])
  })
  it.each([
    [{ iss: 'https://attacker.example' }, {}], [{ aud: ['wrong'] }, {}], [{ aud: 'a'.repeat(64) }, {}],
    [{ email: 'other@example.test' }, {}], [{ email: undefined }, {}], [{ sub: '' }, {}],
    [{ exp: now / 1000 }, {}], [{ iat: now / 1000 + 1 }, {}], [{ nbf: now / 1000 + 1 }, {}],
    [{ exp: 'future' }, {}], [{ exp: 1.5 }, {}], [{}, { alg: 'none' }], [{}, { alg: 'HS256' }], [{}, { crit: ['arbitrary'] }]
  ])('denies bad claims/header %# without any provider or JWKS request', async (claims, header) => {
    const fetch = vi.fn<typeof globalThis.fetch>(jwks), verifier = new AccessVerifier(configuration(''), fetch, () => now)
    expect(await verifier.validate(token(claims, header))).toBeNull(); expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects absent, oversized, malformed, tampered and unknown-key assertions; never follows jku/x5u', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(jwks), verifier = new AccessVerifier(configuration(''), fetch, () => now)
    for (const value of [undefined, '', 'a'.repeat(8193), 'a.b.c', token().slice(0, -30) + 'tampered', token({}, { kid: 'missing', jku: 'https://attacker.example' })]) expect(await verifier.validate(value)).toBeNull()
    expect(fetch.mock.calls.every(call => String(call[0]) === configuration('').issuer + '/cdn-cgi/access/certs')).toBe(true)
  })
  it('coalesces JWKS loads and fails closed across key rotation until the rate-limited refresh succeeds', async () => {
    let time = now, keys = [publicJwk]
    const fetch = vi.fn(async () => Response.json({ keys })), verifier = new AccessVerifier(configuration(''), fetch, () => time)
    expect((await Promise.all([verifier.validate(token()), verifier.validate(token())])).every(Boolean)).toBe(true); expect(fetch).toHaveBeenCalledOnce()
    keys = [{ ...publicJwk, kid: 'rotated' }]
    expect(await verifier.validate(token({}, { kid: 'rotated' }))).toBeNull()
    time += 31_000
    expect(await verifier.validate(token({}, { kid: 'rotated' }))).not.toBeNull(); expect(fetch).toHaveBeenCalledTimes(2)
  })
  it.each([() => new Response('secret-shaped-error', { status: 503 }), () => Response.json({ keys: [] }),
    () => Response.json({ keys: [{ ...publicJwk, kty: 'oct' }] }), () => new Response('x'.repeat(65_537))])('fails closed on malformed, oversized or failed JWKS %#', async response => {
    expect(await new AccessVerifier(configuration(''), async () => response(), () => now).validate(token())).toBeNull()
  })
  it('bounds a transport that ignores abort and does not accept a stale cached key after expiry', async () => {
    vi.useFakeTimers(); let time = now
    const fetch = vi.fn(jwks), verifier = new AccessVerifier(configuration(''), fetch, () => time)
    expect(await verifier.validate(token())).not.toBeNull(); time += 301_000
    fetch.mockImplementation(() => new Promise(() => {}))
    const pending = verifier.validate(token()); await vi.advanceTimersByTimeAsync(3001)
    expect(await pending).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  })
})
describe('disabled-by-default gateway configuration', () => {
  const env = { WEB_ENABLED: '1', GATEWAY_PUBLIC_ORIGIN: 'https://lingobar.example', ACCESS_ISSUER: configuration('').issuer,
    ACCESS_AUDIENCE: configuration('').audience, ACCESS_ALLOWED_EMAIL: configuration('').email, GATEWAY_STATE_DIRECTORY: '/tmp/synthetic-state', GATEWAY_AUDIO_LEDGER_DIRECTORY: '/tmp/synthetic-audio-ledger',
    GATEWAY_DAILY_SESSIONS: '1', GATEWAY_DAILY_COMPLETION_REQUESTS: '42', ASR_API_KEY: 'synthetic-asr', TRANSLATION_API_KEY: 'synthetic-translation' }
  it('ignores all credentials while disabled and requires explicit nonzero caps when enabled', () => {
    expect(gatewayConfig({})).toBeNull(); expect(gatewayConfig({ WEB_ENABLED: '0', ASR_API_KEY: 'not-used' })).toBeNull()
    expect(gatewayConfig(env)).toMatchObject({ dailySessions: 1, dailyCompletionRequests: 42 })
  })
  it.each(['GATEWAY_PUBLIC_ORIGIN', 'ACCESS_ISSUER', 'ACCESS_AUDIENCE', 'ACCESS_ALLOWED_EMAIL', 'GATEWAY_STATE_DIRECTORY', 'GATEWAY_DAILY_SESSIONS', 'GATEWAY_DAILY_COMPLETION_REQUESTS', 'GATEWAY_AUDIO_LEDGER_DIRECTORY', 'TRANSLATION_API_KEY'])('rejects missing %s with a fixed redacted error', name => {
    expect(() => gatewayConfig({ ...env, [name]: '' })).toThrow('Invalid gateway configuration')
  })
  it.each([['GATEWAY_PUBLIC_ORIGIN', 'http://lingobar.example'], ['GATEWAY_PUBLIC_ORIGIN', 'https://lingobar.example/api'],
    ['ACCESS_ISSUER', 'https://attacker.example'], ['GATEWAY_DAILY_SESSIONS', '0'], ['GATEWAY_DAILY_COMPLETION_REQUESTS', '-1'],
    ['ASR_MODEL', 'unselected-model'], ['ASR_API_KEY', 'synthetic\nheader-injection']])('rejects unsafe configuration %s %#', (name, value) => {
    expect(() => gatewayConfig({ ...env, [name]: value })).toThrow('Invalid gateway configuration')
  })
})
