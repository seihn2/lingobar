import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { RelayError, type WorkerFetch } from '../worker/types'
import { quoteWebTextRequest } from './text-budget'

type Ledger = { version: 1; spentMicroCny: number; accounts: Record<string, number> }
const MAX = 100_000_000
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX
const accountId = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Independent shared-account money store: reservations are cumulative spent upper
 * bounds, not provider settlements. No refunds, daily resets, or account deletion.
 * Both limits are trusted server configuration, NEVER browser-supplied amounts. */
export class AccountBudget {
  private ledger: Ledger = { version: 1, spentMicroCny: 0, accounts: {} }
  private lock: number
  private closed = false
  private failed = false
  constructor(private directory: string, private siteLimitMicroCny = 0) {
    if (!isAbsolute(directory) || !amount(siteLimitMicroCny)) throw new Error('Invalid account budget configuration')
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.geteuid?.()) throw new Error('Private account budget directory required')
    this.lock = openSync(join(directory, 'accounts-budget.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    let fd: number | undefined
    try {
      const path = join(directory, 'accounts-budget.json')
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch (error) {
        // Initializing missing state can never grant money. With a positive cap,
        // missing state is ambiguous (possibly lost spending), so fail closed.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || siteLimitMicroCny !== 0) throw error
        this.persist(this.ledger)
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      }
      const file = fstatSync(fd)
      if (!file.isFile() || file.mode & 0o077 || file.uid !== process.geteuid?.() || file.size > 1_048_576) throw new Error()
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (!object(value) || Object.keys(value).sort().join(',') !== 'accounts,spentMicroCny,version' || value.version !== 1 || !amount(value.spentMicroCny) || !object(value.accounts)) throw new Error()
      let sum = 0
      for (const [id, spent] of Object.entries(value.accounts)) {
        if (!accountId(id) || !amount(spent)) throw new Error()
        sum += spent
        if (!amount(sum)) throw new Error()
      }
      if (sum !== value.spentMicroCny) throw new Error()
      this.ledger = value as Ledger
    } catch {
      closeSync(this.lock); unlinkSync(join(directory, 'accounts-budget.lock'))
      throw new Error('Account budget unavailable')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  private persist(next: Ledger): void {
    let fd: number | undefined
    try {
      const data = JSON.stringify(next) + '\n'
      if (Buffer.byteLength(data) > 1_048_576) throw new Error()
      const temporary = join(this.directory, 'accounts-budget.pending')
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, join(this.directory, 'accounts-budget.json'))
      fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      fsyncSync(fd); closeSync(fd); fd = undefined
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  remaining(id: string, accountLimitMicroCny = 0): number {
    if (this.closed || this.failed) throw new RelayError('unavailable')
    if (!accountId(id) || !amount(accountLimitMicroCny)) throw new RelayError('protocol')
    return Math.max(0, Math.min(this.siteLimitMicroCny - this.ledger.spentMicroCny,
      accountLimitMicroCny - (this.ledger.accounts[id] || 0)))
  }
  fetch(id: string, accountLimitMicroCny: number, upstream: WorkerFetch): WorkerFetch {
    return async (input, init) => {
      if (init?.signal?.aborted) throw new RelayError('unavailable')
      const quote = quoteWebTextRequest(input, init)
      if (quote.reservationMicroCny > this.remaining(id, accountLimitMicroCny)) return new Response('{"error":"quota"}', { status: 429 })
      const next: Ledger = { version: 1, spentMicroCny: this.ledger.spentMicroCny + quote.reservationMicroCny,
        accounts: { ...this.ledger.accounts, [id]: (this.ledger.accounts[id] || 0) + quote.reservationMicroCny } }
      // Synchronous read/check/write reservation prevents concurrent requests from
      // admitting against the same remaining balance before their first await.
      try { this.persist(next); this.ledger = next }
      catch { this.failed = true; throw new RelayError('unavailable') }
      if (init?.signal?.aborted) throw new RelayError('unavailable')
      return upstream('https://api.deepseek.com/chat/completions', quote.request)
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; closeSync(this.lock); unlinkSync(join(this.directory, 'accounts-budget.lock'))
  }
}
