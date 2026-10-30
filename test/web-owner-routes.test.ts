import { afterEach, expect, it, vi } from 'vitest'
import { webApiPath } from '../src/web/routes'
import { loadWebConfig } from '../src/web/config'
import { BrowserSession } from '../src/web/session'
import { authRequest } from '../src/web/auth-client'
afterEach(() => vi.unstubAllGlobals())
it('uses only the explicit owner namespace, not a similar public path', () => {
  for (const pathname of ['/', '/ownership', '/ownerish']) {
    vi.stubGlobal('location', { pathname }); expect(webApiPath('/api/translate')).toBe('/api/translate')
  }
  for (const pathname of ['/owner', '/owner/']) {
    vi.stubGlobal('location', { pathname }); expect(webApiPath('/api/translate')).toBe('/owner/api/translate')
  }
})
it('keeps owner capability and management requests under the protected namespace', async () => {
  vi.stubGlobal('location', { pathname: '/owner' })
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ version: 1, backend: null }))
  vi.stubGlobal('fetch', transport); await loadWebConfig()
  expect(transport.mock.calls[0][0]).toBe('/owner/app-config.json')
  const auth = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ kind: 'owner', role: 'admin', initialized: false, bootstrapAllowed: true }))
  await authRequest('https://lingobar.example', 'status', 'GET', undefined, new AbortController().signal, auth)
  expect(String(auth.mock.calls[0][0])).toBe('https://lingobar.example/owner/api/auth/status')
})

it('owner settings save both keys through protected paths without exporting keys into snapshots', async () => {
  vi.stubGlobal('location', { pathname: '/owner' })
  const credentialsFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ configured: true }))
  const session = new BrowserSession({ backend: null, origin: 'https://lingobar.example', credentialsBackend: '/api/settings/translation-key', asrCredentialsBackend: '/api/settings/asr-key', credentialsFetch })
  await session.configureTranslationKey('synthetic-owner-deepseek-key')
  await session.configureAsrKey('synthetic-owner-asr-key')
  expect(credentialsFetch.mock.calls.map(call => String(call[0]))).toEqual(['https://lingobar.example/owner/api/settings/translation-key', 'https://lingobar.example/owner/api/settings/asr-key'])
  expect(JSON.stringify(session.snapshot())).not.toContain('synthetic-owner')
  expect(session.textConfigured).toBe(true); session.dispose()
  vi.stubGlobal('location', { pathname: '/' })
  expect(webApiPath('/api/auth/guest')).toBe('/api/auth/guest')
})
