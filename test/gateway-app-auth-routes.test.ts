import { chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppAuth } from '../src/gateway/app-auth'
import { createAppAuthHandler } from '../src/gateway/app-auth-routes'
const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
const password = 'Synthetic-password-1234', key = 'synthetic-api-key-not-real'
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-auth-routes-')); chmodSync(dir, 0o700)
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const auth = new AppAuth(dir); cleanup.push(() => auth.close())
  let now = 0
  const handler = createAppAuthHandler(auth, { now: () => now })
  const call = (action: string, method = 'GET', input?: unknown, owner = false, cookie?: string, headers: Record<string, string> = {}) => handler(new Request('https://lingobar.example/api/auth/' + action, {
    method, headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  }), owner)
  return { auth, dir, handler, call, advance: () => { now += 60_000 } }
}
const token = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]

describe.skipIf(process.platform === 'win32')('application auth HTTP boundary, generated test passwords only', () => {
  it('only a verified existing Access owner may initialize an administrator', async () => {
    const { call, auth } = fixture()
    expect(await (await call('status')).json()).toEqual({ kind: 'anonymous', initialized: false, bootstrapAllowed: false })
    expect((await call('bootstrap', 'POST', { username: 'lingobaradmin', password })).status).toBe(403)
    expect(auth.initialized).toBe(false)
    expect(await (await call('status', 'GET', undefined, true)).json()).toEqual({ kind: 'owner', role: 'admin', initialized: false, bootstrapAllowed: true })
    expect((await call('bootstrap', 'POST', { username: 'lingobaradmin', password }, true)).status).toBe(200)
    expect(auth.listAccounts()[0]).toMatchObject({ username: 'lingobaradmin', role: 'admin', limitMicroCny: 0 })
    expect((await call('bootstrap', 'POST', { username: 'attacker', password }, true)).status).toBe(403)
  })
  it('protects account administration and returns no hashes, salts, ids or passwords', async () => {
    const { auth, call } = fixture(); await auth.bootstrap('adminuser', password); await auth.createAccount('normaluser', password)
    const normal = token(await call('login', 'POST', { username: 'normaluser', password }))
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) expect((await call('accounts', method, method === 'GET' ? undefined : { username: 'newuser', password }, false, normal)).status).toBe(403)
    const admin = token(await call('login', 'POST', { username: 'adminuser', password }))
    expect((await call('accounts', 'POST', { username: 'newuser', password, limitMicroCny: 0 }, false, admin)).status).toBe(200)
    expect((await call('accounts', 'POST', { username: 'fundeduser', password, limitMicroCny: 1 }, false, admin)).status).toBe(200)
    expect((await call('accounts', 'POST', { username: 'overlimit', password, limitMicroCny: 100_000_001 }, false, admin)).status).toBe(400)
    expect((await call('accounts', 'PATCH', { username: 'fundeduser', limitMicroCny: 200 }, false, admin)).status).toBe(200)
    expect(auth.listAccounts().find(a => a.username === 'fundeduser')?.limitMicroCny).toBe(200)
    expect((await call('accounts', 'POST', { username: 'newadmin', password, role: 'admin' }, false, admin)).status).toBe(400)
    const listed = await call('accounts', 'GET', undefined, false, admin), text = await listed.text()
    expect(text).not.toMatch(/salt|passwordHash|"id"|Synthetic/)
    expect(JSON.parse(text).accounts).toContainEqual({ username: 'newuser', role: 'user', limitMicroCny: 0 })
    expect((await call('accounts', 'DELETE', { username: 'adminuser' }, true)).status).toBe(403)
    expect((await call('accounts', 'DELETE', { username: 'newuser' }, false, admin)).status).toBe(200)
  })
  it('creates a cookie-only guest session with charge consent and no persistent or returned provider keys', async () => {
    const { auth, call, dir } = fixture(); await auth.bootstrap('adminuser', password)
    expect((await call('guest', 'POST', { translationKey: key })).status).toBe(400)
    const result = await call('guest', 'POST', { translationKey: key, asrKey: key + '-asr', acceptCharges: true })
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ ok: true })
    expect(result.headers.get('set-cookie')).not.toContain(key)
    const guest = token(result)
    expect(await (await call('status', 'GET', undefined, false, guest)).json()).toEqual({ kind: 'guest', role: 'user', initialized: true, bootstrapAllowed: false })
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).not.toContain(key)
    expect((await call('bootstrap', 'POST', { username: 'eviladmin', password }, false, guest)).status).toBe(403)
    expect((await call('accounts', 'GET', undefined, false, guest)).status).toBe(403)
  })
  it('revokes logout and guest replacement tokens, never trusting an unverified owner field', async () => {
    const { auth, call } = fixture()
    const first = token(await call('guest', 'POST', { translationKey: key, acceptCharges: true }))
    const second = token(await call('guest', 'POST', { translationKey: key + '-2', acceptCharges: true }, false, first))
    expect(auth.resolve(first)).toBeNull(); expect(auth.resolve(second)).not.toBeNull()
    const result = await call('logout', 'POST', {}, false, second)
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0'); expect(auth.resolve(second)).toBeNull()
    expect((await call('bootstrap', 'POST', { username: 'adminuser', password, ownerVerified: true })).status).toBe(403)
  })
  it('rechecks administrator authorization after a slow body upload and refuses revoked sessions', async () => {
    const { auth, handler } = fixture(); await auth.bootstrap('adminuser', password)
    const session = (await auth.login('adminuser', password)).cookie.split(';')[0]
    let upload!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { upload = controller } })
    const pending = handler(new Request('https://lingobar.example/api/auth/accounts', {
      method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: stream, duplex: 'half'
    } as RequestInit), false)
    auth.logout(session)
    upload.enqueue(new TextEncoder().encode(JSON.stringify({ username: 'shouldnotexist', password }))); upload.close()
    expect((await pending).status).toBe(403)
    expect(auth.listAccounts()).toHaveLength(1)
  })
  it.each(['bootstrap', 'accounts'])('rechecks Access owner expiry after slow %s body upload', async action => {
    const { auth, handler } = fixture()
    if (action === 'accounts') await auth.bootstrap('existingadmin', password)
    let validOwner = true, upload!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { upload = controller } })
    const pending = handler(new Request('https://lingobar.example/api/auth/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half'
    } as RequestInit), () => validOwner)
    validOwner = false
    upload.enqueue(new TextEncoder().encode(JSON.stringify({ username: 'mustnotexist', password }))); upload.close()
    expect((await pending).status).toBe(403)
    expect(auth.listAccounts()).toHaveLength(action === 'accounts' ? 1 : 0)
  })
  it('enforces ten login attempts per minute globally before additional password hashing', async () => {
    const { call, advance } = fixture()
    for (let i = 0; i < 10; i++) expect((await call('login', 'POST', { username: 'missinguser', password })).status).toBe(401)
    const blocked = await call('login', 'POST', { username: 'anotheruser', password })
    expect(blocked.status).toBe(429); expect(await blocked.text()).not.toContain(password)
    advance(); expect((await call('login', 'POST', { username: 'missinguser', password })).status).toBe(401)
  })
  it('bounds anonymous guest creation without consuming login attempts', async () => {
    const { auth, call, advance } = fixture(); await auth.bootstrap('adminuser', password)
    for (let i = 0; i < 10; i++) expect((await call('guest', 'POST', { translationKey: key, acceptCharges: true })).status).toBe(200)
    expect((await call('guest', 'POST', { translationKey: key, acceptCharges: true })).status).toBe(429)
    expect((await call('login', 'POST', { username: 'adminuser', password })).status).toBe(200)
    advance(); expect((await call('guest', 'POST', { translationKey: key, acceptCharges: true })).status).toBe(200)
  })
  it('rejects methods, query aliases, wrong content type, extra fields and oversized bodies', async () => {
    const { call, handler } = fixture()
    expect((await call('status', 'POST', {})).status).toBe(405)
    expect((await call('status?other=1')).status).toBe(404)
    expect((await call('unknown')).status).toBe(404)
    expect((await call('login', 'POST', { username: 'adminuser', password }, false, undefined, { 'Content-Type': 'text/plain' })).status).toBe(400)
    expect((await call('login', 'POST', { username: 'adminuser', password, role: 'admin' })).status).toBe(400)
    expect((await call('login', 'POST', { username: 'adminuser', password: 'x'.repeat(8192) })).status).toBe(400)
    expect((await handler(new Request('https://lingobar.example/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }), false)).status).toBe(400)
  })
})

describe.skipIf(process.platform === 'win32')('owner-only normalized password route', () => {
  const replacement = 'Synthetic-replacement-834!'
  const body = { username: 'targetadmin', password: replacement, confirmation: replacement }
  it('rejects anonymous, ordinary and application-admin cookies while accepting verified owner', async () => {
    const f = fixture(); await f.auth.bootstrap('targetadmin', password); await f.auth.createAccount('normaluser', password)
    const admin = token(await f.call('login', 'POST', { username: 'targetadmin', password }))
    const user = token(await f.call('login', 'POST', { username: 'normaluser', password }))
    for (const cookie of [undefined, admin, user]) expect((await f.call('password', 'POST', body, false, cookie)).status).toBe(403)
    expect((await f.call('password', 'GET', undefined, true)).status).toBe(405)
    expect((await f.call('password', 'POST', body, true)).status).toBe(200)
    expect(f.auth.resolve(admin)).toBeNull(); expect(f.auth.resolve(user)).not.toBeNull()
  })
  it('rejects malformed/weak replacements without changing stored data', async () => {
    const f = fixture(); await f.auth.bootstrap('targetadmin', password)
    const before = readFileSync(join(f.dir, 'accounts.json'), 'utf8')
    const bad = [ { ...body, extra: true }, { ...body, confirmation: 'not-equal' }, { username: body.username, password: replacement },
      ...['x'.repeat(129), '12345678901\nX', 'targetadmin', 'password1234', 'aaaaaaaaaaaa', 'short'].map(value => ({ username: body.username, password: value, confirmation: value })),
      { username: 'longsyntheticusername', password: 'longsyntheticusername', confirmation: 'longsyntheticusername' } ]
    for (const input of bad) expect((await f.call('password', 'POST', input, true)).status).toBe(400)
    expect(readFileSync(join(f.dir, 'accounts.json'), 'utf8')).toBe(before)
  })
  it.each(['expiry', 'abort'])('does not persist when owner authorization is lost during body upload: %s', async reason => {
    const f = fixture(); await f.auth.bootstrap('targetadmin', password)
    const before = readFileSync(join(f.dir, 'accounts.json'), 'utf8'), abort = new AbortController()
    let owner = true, stream!: ReadableStreamDefaultController<Uint8Array>
    const request = new Request('https://lingobar.example/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
      body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), duplex: 'half' } as RequestInit)
    const result = f.handler(request, () => owner)
    await Promise.resolve()
    if (reason === 'expiry') owner = false; else abort.abort()
    stream.enqueue(new TextEncoder().encode(JSON.stringify(body))); stream.close()
    expect([400, 403, 503]).toContain((await result).status)
    expect(readFileSync(join(f.dir, 'accounts.json'), 'utf8')).toBe(before)
  })
  it.each(['expiry', 'abort'])('does not persist if authorization is lost inside scrypt: %s', async reason => {
    const f = fixture(); await f.auth.bootstrap('targetadmin', password)
    const before = readFileSync(join(f.dir, 'accounts.json'), 'utf8'), abort = new AbortController()
    let checks = 0
    const result = await f.handler(new Request('https://lingobar.example/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal }), () => {
      checks++
      // First route check, post-body check, store pre-derive check, then pre-persist.
      if (checks === 4 && reason === 'abort') abort.abort()
      return !(checks >= 4 && reason === 'expiry')
    })
    expect(result.status).toBe(503); expect(checks).toBe(4)
    expect(readFileSync(join(f.dir, 'accounts.json'), 'utf8')).toBe(before)
  })
})
