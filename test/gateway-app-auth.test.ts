import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppAuth, APP_SESSION_COOKIE } from '../src/gateway/app-auth'
const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.useRealTimers() })
const PASSWORD = 'Synthetic-password-0001'
const OTHER = 'Synthetic-password-0002'
const KEY = 'synthetic-provider-key-not-real'
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lingobar-auth-test-')); chmodSync(directory, 0o700)
  cleanup.push(() => { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }) })
  let now = 1_000_000
  const auth = new AppAuth(directory, () => now); cleanup.push(() => auth.close())
  return { auth, directory, advance: (ms: number) => { now += ms } }
}
const header = ({ cookie }: { cookie: string }) => cookie.split(';')[0]

describe.skipIf(process.platform === 'win32')('private account and isolated volatile session core; synthetic secrets only', () => {
  it('does not elect an administrator or persist anything just because a guest visits', () => {
    const { auth, directory } = fixture()
    expect(auth.initialized).toBe(false); expect(auth.listAccounts()).toEqual([]); expect(auth.resolve()).toBeNull()
    const session = auth.guest({ translationKey: KEY, acceptCharges: true })
    expect(auth.resolve(header(session))).toMatchObject({ kind: 'guest', role: 'user' })
    expect(auth.initialized).toBe(false); expect(existsSync(join(directory, 'accounts.json'))).toBe(false)
  })
  it('requires explicit bootstrap, hashes passwords privately and exposes only safe metadata', async () => {
    const { auth, directory } = fixture()
    await expect(auth.createAccount('testuser', PASSWORD)).rejects.toThrow()
    const admin = await auth.bootstrap('lingobaradmin', PASSWORD)
    expect(admin).toMatchObject({ username: 'lingobaradmin', role: 'admin', limitMicroCny: 0 })
    expect(auth.initialized).toBe(true)
    const source = readFileSync(join(directory, 'accounts.json'), 'utf8')
    expect(source).not.toContain(PASSWORD); expect(source).toContain('passwordHash')
    expect(statSync(join(directory, 'accounts.json')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(auth.listAccounts())).not.toMatch(/salt|passwordHash/)
    await expect(auth.bootstrap('someoneelse', PASSWORD)).rejects.toThrow()
  })
  it('serializes competing bootstrap requests instead of allowing two first administrators', async () => {
    const { auth } = fixture()
    const first = auth.bootstrap('firstadmin', PASSWORD)
    await expect(auth.bootstrap('secondadmin', PASSWORD)).rejects.toThrow()
    await first; expect(auth.listAccounts()).toHaveLength(1)
  })
  it('stores independently salted hashes even for equal passwords', async () => {
    const { auth, directory } = fixture()
    await auth.bootstrap('adminuser', PASSWORD); await auth.createAccount('seconduser', PASSWORD)
    const stored = JSON.parse(readFileSync(join(directory, 'accounts.json'), 'utf8')).accounts
    expect(stored[0].salt).not.toBe(stored[1].salt); expect(stored[0].passwordHash).not.toBe(stored[1].passwordHash)
  })
  it('authenticates case-insensitively with opaque secure cookies and rejects wrong/unknown credentials equally', async () => {
    const { auth } = fixture(); await auth.bootstrap('AdminUser', PASSWORD)
    const session = await auth.login('adminuser', PASSWORD)
    expect(session.cookie).toMatch(new RegExp(`^${APP_SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$`))
    expect(session.cookie).not.toContain(PASSWORD)
    expect(auth.resolve(header(session))).toMatchObject({ kind: 'account', username: 'AdminUser', role: 'admin', limitMicroCny: 0 })
    for (const username of ['AdminUser', 'missinguser']) await expect(auth.login(username, OTHER)).rejects.toThrow('Invalid account credentials')
    expect(auth.resolve(`${APP_SESSION_COOKIE}=${'x'.repeat(43)}`)).toBeNull()
    expect(auth.resolve(header(session) + '; ' + header(session))).toBeNull()
  })
  it('isolates guest keys in memory without exposing them in cookie or account file', async () => {
    const { auth, directory } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    const one = auth.guest({ translationKey: KEY, asrKey: KEY + '-asr', acceptCharges: true })
    const two = auth.guest({ translationKey: KEY + '-second', acceptCharges: true })
    const p1 = auth.resolve(header(one)), p2 = auth.resolve(header(two))
    expect(p1).toMatchObject({ kind: 'guest', translationKey: KEY, asrKey: KEY + '-asr' })
    expect(p2).toMatchObject({ kind: 'guest', translationKey: KEY + '-second', asrKey: '' })
    expect(p1?.id).not.toBe(p2?.id)
    expect(JSON.stringify(one)).not.toContain(KEY); expect(readFileSync(join(directory, 'accounts.json'), 'utf8')).not.toContain(KEY)
    if (p1?.kind === 'guest') p1.translationKey = 'mutated'
    expect(auth.resolve(header(one))).toMatchObject({ translationKey: KEY })
  })
  it('requires explicit own-charge consent and rejects malformed or injected guest keys', () => {
    const { auth } = fixture()
    for (const input of [{ translationKey: KEY }, { translationKey: KEY, acceptCharges: false }, { translationKey: 'short', acceptCharges: true },
      { translationKey: KEY + '\n', acceptCharges: true }, { translationKey: KEY, asrKey: 'short', acceptCharges: true },
      { translationKey: KEY, acceptCharges: true, endpoint: 'https://attacker.invalid' }]) expect(() => auth.guest(input as never)).toThrow()
  })
  it('expires guests at one hour and accounts at eight hours, and logout revokes immediately', async () => {
    const { auth, advance } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    const account = await auth.login('adminuser', PASSWORD), guest = auth.guest({ translationKey: KEY, acceptCharges: true })
    advance(3600_000); expect(auth.resolve(header(guest))).toBeNull(); expect(auth.resolve(header(account))).not.toBeNull()
    advance(7 * 3600_000); expect(auth.resolve(header(account))).toBeNull()
    const next = await auth.login('adminuser', PASSWORD)
    expect(auth.logout(header(next)).cookie).toContain('Max-Age=0'); expect(auth.resolve(header(next))).toBeNull()
  })
  it('revokes every existing account session on password change and keeps stable identity', async () => {
    const { auth } = fixture(); const account = await auth.bootstrap('adminuser', PASSWORD)
    const one = await auth.login('adminuser', PASSWORD), two = await auth.login('adminuser', PASSWORD)
    await auth.updatePassword('adminuser', OTHER)
    expect(auth.resolve(header(one))).toBeNull(); expect(auth.resolve(header(two))).toBeNull()
    await expect(auth.login('adminuser', PASSWORD)).rejects.toThrow()
    expect(auth.resolve(header(await auth.login('adminuser', OTHER)))?.id).toBe(account.id)
  })
  it('revokes sessions on removal and recreates a distinct id, never reusing a budget identity', async () => {
    const { auth } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    const user = await auth.createAccount('normaluser', PASSWORD)
    const session = await auth.login('normaluser', PASSWORD)
    auth.removeAccount('normaluser'); expect(auth.resolve(header(session))).toBeNull()
    expect((await auth.createAccount('normaluser', PASSWORD)).id).not.toBe(user.id)
    expect(() => auth.removeAccount('adminuser')).toThrow()
  })
  it('uses zero default account allowance and revokes sessions when trusted quota metadata changes', async () => {
    const { auth } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    await auth.createAccount('normaluser', PASSWORD)
    const old = await auth.login('normaluser', PASSWORD)
    auth.setAccountLimit('normaluser', 12345); expect(auth.resolve(header(old))).toBeNull()
    expect(auth.resolve(header(await auth.login('normaluser', PASSWORD)))).toMatchObject({ limitMicroCny: 12345 })
    for (const value of [-1, 100_000_001, 0.5, NaN]) expect(() => auth.setAccountLimit('normaluser', value)).toThrow()
  })
  it('rejects invalid usernames/passwords/duplicate case variants', async () => {
    const { auth } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    for (const [name, pass] of [['ab', PASSWORD], ['a/unsafe', PASSWORD], ['normaluser', 'short'], ['normaluser', 'x'.repeat(129)], ['normaluser', PASSWORD + '\n'], ['ADMINUSER', PASSWORD]]) await expect(auth.createAccount(name, pass)).rejects.toThrow()
  })
  it('persists accounts but never sessions through restart and excludes other writers', async () => {
    const { auth, directory } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    const session = await auth.login('adminuser', PASSWORD)
    expect(() => new AppAuth(directory)).toThrow()
    auth.close(); const restored = new AppAuth(directory); cleanup.push(() => restored.close())
    expect(restored.initialized).toBe(true); expect(restored.resolve(header(session))).toBeNull()
    expect(restored.resolve(header(await restored.login('adminuser', PASSWORD)))).toMatchObject({ role: 'admin' })
  })
  it('rejects corrupt or permissive persistent accounts without silently resetting', async () => {
    const { auth, directory } = fixture(); await auth.bootstrap('adminuser', PASSWORD); auth.close()
    const file = join(directory, 'accounts.json'), original = readFileSync(file, 'utf8')
    writeFileSync(file, '{broken'); expect(() => new AppAuth(directory)).toThrow(); expect(readFileSync(file, 'utf8')).toBe('{broken')
    writeFileSync(file, original); chmodSync(file, 0o644); expect(() => new AppAuth(directory)).toThrow()
    chmodSync(file, 0o600); const restored = new AppAuth(directory); cleanup.push(() => restored.close())
  })
  it('actively discards idle guest keys at expiry and clears every owned timer on logout/close', () => {
    vi.useFakeTimers()
    const { auth } = fixture()
    const first = auth.guest({ translationKey: KEY, acceptCharges: true })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(3600_000)
    expect(vi.getTimerCount()).toBe(0)
    // The map must already be empty BEFORE resolve/prune or any later request.
    expect((auth as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
    expect(auth.resolve(header(first))).toBeNull()
    const second = auth.guest({ translationKey: KEY, acceptCharges: true })
    expect(vi.getTimerCount()).toBe(1); auth.logout(header(second)); expect(vi.getTimerCount()).toBe(0)
    auth.guest({ translationKey: KEY, acceptCharges: true }); auth.guest({ translationKey: KEY, acceptCharges: true })
    expect(vi.getTimerCount()).toBe(2); auth.close(); expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps account and administrator login capacity when anonymous guest capacity is exhausted', async () => {
    const { auth } = fixture()
    await auth.bootstrap('adminuser', PASSWORD); await auth.createAccount('normaluser', PASSWORD)
    for (let i = 0; i < 128; i++) auth.guest({ translationKey: KEY, acceptCharges: true })
    expect(() => auth.guest({ translationKey: KEY, acceptCharges: true })).toThrow()
    expect(auth.resolve(header(await auth.login('normaluser', PASSWORD)))).toMatchObject({ kind: 'account', role: 'user' })
    expect(auth.resolve(header(await auth.login('adminuser', PASSWORD)))).toMatchObject({ kind: 'account', role: 'admin' })
  })
  it('does not issue an in-flight login after the service closes', async () => {
    const { auth } = fixture(); await auth.bootstrap('adminuser', PASSWORD)
    const login = auth.login('adminuser', PASSWORD); auth.close(); await expect(login).rejects.toThrow('Account service unavailable')
  })
})
