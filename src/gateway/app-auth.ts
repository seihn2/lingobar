import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { validTranslationKey } from './credentials'

export const APP_SESSION_COOKIE = '__Host-lingobar-session'
export type AppRole = 'admin' | 'user'
export type Principal = {
  id: string; kind: 'account'; role: AppRole; username: string; limitMicroCny: number; expiresAt: number
} | {
  /** Internal server-only value: never serialize a guest principal in an HTTP response. */
  id: string; kind: 'guest'; role: 'user'; translationKey: string; asrKey: string; expiresAt: number
}
interface Account { id: string; username: string; role: AppRole; salt: string; passwordHash: string; limitMicroCny: number }
interface State { version: 1; initialized: boolean; accounts: Account[] }
export type SafeAccount = Pick<Account, 'id' | 'username' | 'role' | 'limitMicroCny'>
function unavailable(): never { throw new Error('Account service unavailable') }
function denied(): never { throw new Error('Invalid account credentials') }
const usernameValid = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/u.test(v)
const passwordValid = (v: unknown): v is string => typeof v === 'string' && v.length >= 12 && v.length <= 128 && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v)
const limitValid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 100_000_000
const hex = (v: unknown, length: number): v is string => typeof v === 'string' && new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(v)
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result))
})
const cookie = (token: string, seconds: number) => `${APP_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`
const safe = ({ id, username, role, limitMicroCny }: Account): SafeAccount => ({ id, username, role, limitMicroCny })

/** Disabled unless instantiated by the gateway's explicit configuration. Owner verification
 * and role checks belong to the route boundary; bootstrap MUST only follow verified Access
 * owner authorization. No public first-user election, default password or provider key file. */
export class AppAuth {
  private state: State = { version: 1, initialized: false, accounts: [] }
  private sessions = new Map<string, Principal>()
  private sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lock: number
  private closed = false
  private failed = false
  private mutating = false
  private logins = 0
  private dummySalt = randomBytes(32).toString('hex')
  constructor(private directory: string, private now = Date.now) {
    if (!isAbsolute(directory)) unavailable()
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.geteuid?.()) unavailable()
    this.lock = openSync(join(directory, 'accounts.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    let fd: number | undefined
    try {
      try { fd = openSync(join(directory, 'accounts.json'), constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      const file = fstatSync(fd)
      if (!file.isFile() || file.mode & 0o077 || file.uid !== process.geteuid?.() || file.size > 128 * 1024) unavailable()
      const state: State = JSON.parse(readFileSync(fd, 'utf8'))
      if (!state || Object.keys(state).sort().join(',') !== 'accounts,initialized,version' || state.version !== 1 || state.initialized !== true || !Array.isArray(state.accounts) || state.accounts.length > 100 || !state.accounts.some(a => a.role === 'admin')) unavailable()
      const names = new Set<string>(), ids = new Set<string>()
      for (const a of state.accounts) {
        if (!a || Object.keys(a).sort().join(',') !== 'id,limitMicroCny,passwordHash,role,salt,username' ||
          typeof a.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(a.id) || !usernameValid(a.username) || !['admin', 'user'].includes(a.role) ||
          !hex(a.salt, 64) || !hex(a.passwordHash, 128) || !limitValid(a.limitMicroCny) || names.has(a.username.toLowerCase()) || ids.has(a.id)) unavailable()
        names.add(a.username.toLowerCase()); ids.add(a.id)
      }
      this.state = state
    } catch { closeSync(this.lock); unlinkSync(join(directory, 'accounts.lock')); unavailable() }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  private ready(): void { if (this.closed || this.failed) unavailable() }
  private persist(next: State): void {
    this.ready()
    const temporary = join(this.directory, `.accounts-${randomUUID()}.tmp`)
    let fd: number | undefined, created = false
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); created = true
      writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, join(this.directory, 'accounts.json')); created = false
      fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fsyncSync(fd); closeSync(fd); fd = undefined
      this.state = next
    } catch { this.failed = true; this.clearSessions(); unavailable() }
    finally { if (fd !== undefined) closeSync(fd); if (created) { try { unlinkSync(temporary) } catch {} } }
  }
  get initialized(): boolean { this.ready(); return this.state.initialized }
  listAccounts(): SafeAccount[] { this.ready(); return this.state.accounts.map(safe) }
  async bootstrap(username: string, password: string): Promise<SafeAccount> {
    return this.add(username, password, 'admin', 0, true)
  }
  async createAccount(username: string, password: string, role: AppRole = 'user', limitMicroCny = 0): Promise<SafeAccount> {
    return this.add(username, password, role, limitMicroCny, false)
  }
  private async add(username: string, password: string, role: AppRole, limitMicroCny: number, bootstrap: boolean): Promise<SafeAccount> {
    this.ready()
    if (this.mutating || !usernameValid(username) || !passwordValid(password) || !['admin', 'user'].includes(role) || !limitValid(limitMicroCny) ||
      (bootstrap ? this.state.initialized || this.state.accounts.length > 0 : !this.state.initialized) || this.state.accounts.length >= 100 ||
      this.state.accounts.some(a => a.username.toLowerCase() === username.toLowerCase())) unavailable()
    this.mutating = true
    try {
      const salt = randomBytes(32).toString('hex'), passwordHash = (await derive(password, salt)).toString('hex')
      this.ready()
      const account = { id: randomUUID(), username, role, salt, passwordHash, limitMicroCny }
      this.persist({ version: 1, initialized: true, accounts: [...this.state.accounts, account] })
      return safe(account)
    } finally { this.mutating = false }
  }
  private account(username: string): Account | undefined { return this.state.accounts.find(a => a.username.toLowerCase() === username.toLowerCase()) }
  private deleteSession(key: string): void {
    clearTimeout(this.sessionTimers.get(key)); this.sessionTimers.delete(key); this.sessions.delete(key)
  }
  private clearSessions(): void { for (const key of this.sessions.keys()) this.deleteSession(key) }
  private revoke(id: string): void { for (const [key, p] of this.sessions) if (p.id === id) this.deleteSession(key) }
  removeAccount(username: string): void {
    this.ready(); if (this.mutating || !usernameValid(username)) unavailable()
    const account = this.account(username)
    if (!account || account.role === 'admin' && this.state.accounts.filter(a => a.role === 'admin').length === 1) unavailable()
    this.persist({ ...this.state, accounts: this.state.accounts.filter(a => a.id !== account.id) }); this.revoke(account.id)
  }
  async updatePassword(username: string, password: string): Promise<void> {
    this.ready(); if (this.mutating || !usernameValid(username) || !passwordValid(password)) unavailable()
    const account = this.account(username); if (!account) unavailable()
    this.mutating = true
    try {
      const salt = randomBytes(32).toString('hex'), passwordHash = (await derive(password, salt)).toString('hex')
      this.ready()
      this.persist({ ...this.state, accounts: this.state.accounts.map(a => a.id === account.id ? { ...a, salt, passwordHash } : a) })
      this.revoke(account.id)
    } finally { this.mutating = false }
  }
  setAccountLimit(username: string, limitMicroCny: number): void {
    this.ready(); if (this.mutating || !usernameValid(username) || !limitValid(limitMicroCny)) unavailable()
    const account = this.account(username); if (!account) unavailable()
    this.persist({ ...this.state, accounts: this.state.accounts.map(a => a.id === account.id ? { ...a, limitMicroCny } : a) })
    this.revoke(account.id)
  }
  private prune(): void { for (const [key, p] of this.sessions) if (p.expiresAt <= this.now()) this.deleteSession(key) }
  private issue(principal: Principal, seconds: number): { cookie: string } {
    this.ready(); this.prune(); if (this.sessions.size >= 256) unavailable()
    const token = randomBytes(32).toString('base64url')
    const key = hash(token)
    this.sessions.set(key, principal)
    // Expire server-held BYOK key material even when the browser never sends another request.
    const timer = setTimeout(() => this.deleteSession(key), Math.max(0, principal.expiresAt - this.now()))
    timer.unref?.(); this.sessionTimers.set(key, timer)
    return { cookie: cookie(token, seconds) }
  }
  async login(username: string, password: string): Promise<{ cookie: string }> {
    this.ready(); if (this.logins >= 2) unavailable()
    this.logins++
    try {
      const account = usernameValid(username) ? this.account(username) : undefined
      const valid = passwordValid(password)
      const actual = await derive(valid ? password : 'invalid-password-placeholder', account?.salt || this.dummySalt)
      this.ready()
      if (!valid || !account || !timingSafeEqual(actual, Buffer.from(account.passwordHash, 'hex')) || this.account(account.username) !== account) denied()
      return this.issue({ ...safe(account), kind: 'account', expiresAt: this.now() + 8 * 3600_000 }, 8 * 3600)
    } finally { this.logins-- }
  }
  guest(input: { translationKey: string; asrKey?: string; acceptCharges: true }): { cookie: string } {
    this.ready()
    if (!input || Object.keys(input).some(k => !['translationKey', 'asrKey', 'acceptCharges'].includes(k)) || input.acceptCharges !== true ||
      !validTranslationKey(input.translationKey) || input.asrKey !== undefined && input.asrKey !== '' && !validTranslationKey(input.asrKey)) unavailable()
    return this.issue({ id: randomUUID(), kind: 'guest', role: 'user', translationKey: input.translationKey, asrKey: input.asrKey || '', expiresAt: this.now() + 3600_000 }, 3600)
  }
  private sessionKey(header?: string): string | null {
    if (typeof header !== 'string' || header.length > 8192) return null
    const matches = header.split(';').map(v => v.trim()).filter(v => v.startsWith(APP_SESSION_COOKIE + '='))
    if (matches.length !== 1) return null
    const token = matches[0].slice(APP_SESSION_COOKIE.length + 1)
    return /^[a-zA-Z0-9_-]{43}$/u.test(token) ? hash(token) : null
  }
  resolve(cookieHeader?: string): Principal | null {
    this.ready(); this.prune()
    const key = this.sessionKey(cookieHeader), p = key ? this.sessions.get(key) : undefined
    if (!p) return null
    if (p.kind === 'account' && !this.state.accounts.some(a => a.id === p.id)) { this.deleteSession(key!); return null }
    return { ...p }
  }
  logout(cookieHeader?: string): { cookie: string } {
    this.ready(); const key = this.sessionKey(cookieHeader); if (key) this.deleteSession(key)
    return { cookie: cookie('', 0) }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; this.clearSessions(); closeSync(this.lock); unlinkSync(join(this.directory, 'accounts.lock'))
  }
}
