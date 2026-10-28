import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RelayError } from '../worker/types'
import type { GatewayConfig } from './config'

type Ledger = { version: 1; day: string; sessions: number; completions: number }
/** Single process, private persistent reservations. Early stop/failure never refunds a possible provider charge. */
export class DailyBudget {
  private ledger: Ledger
  private lock: number
  private failed = false
  private closed = false
  constructor(private config: Pick<GatewayConfig, 'stateDirectory' | 'dailySessions' | 'dailyCompletionRequests'>, private now = Date.now) {
    const dir = config.stateDirectory
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Private gateway state directory required')
    this.lock = openSync(join(dir, 'gateway.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      const path = join(dir, 'budget.json')
      if (existsSync(path)) {
        const s = lstatSync(path)
        if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) || s.size > 1024) throw new Error()
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Ledger
        if (parsed.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.day) ||
          ![parsed.sessions, parsed.completions].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error()
        this.ledger = parsed
      } else {
        this.ledger = { version: 1, day: this.day(), sessions: 0, completions: 0 }
        this.persist(this.ledger)
      }
    } catch { closeSync(this.lock); unlinkSync(join(dir, 'gateway.lock')); throw new Error('Gateway budget unavailable') }
  }
  private day(): string { return new Date(this.now()).toISOString().slice(0, 10) }
  private persist(next: Ledger): void {
    const dir = this.config.stateDirectory, temporary = join(dir, 'budget.pending')
    let fd: number | undefined
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, join(dir, 'budget.json'))
      const directory = openSync(dir, constants.O_RDONLY)
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } catch { this.failed = true; throw new RelayError('unavailable') }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  reserve(kind: 'session' | 'annotation'): void {
    if (this.closed || this.failed) throw new RelayError('unavailable')
    const day = this.day()
    if (day < this.ledger.day) { this.failed = true; throw new RelayError('unavailable') }
    const prior = day === this.ledger.day ? this.ledger : { version: 1 as const, day, sessions: 0, completions: 0 }
    // A session reserves its full five-minute lifetime and forty completion attempts, before any upstream opens.
    const next = { ...prior, sessions: prior.sessions + Number(kind === 'session'), completions: prior.completions + (kind === 'session' ? 40 : 2) }
    if (next.sessions > this.config.dailySessions || next.completions > this.config.dailyCompletionRequests) throw new RelayError('quota')
    this.persist(next); this.ledger = next
  }
  close(): void {
    if (this.closed) return
    this.closed = true; closeSync(this.lock); unlinkSync(join(this.config.stateDirectory, 'gateway.lock'))
  }
}
