import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RelayError, type WorkerFetch } from '../worker/types'
import { quoteWebTextRequest } from './text-budget'
import { AUDIO_POLICY } from './audio-policy'

type Ledger = { version: 1; batch: string; reservedMicroCny: number; attempts: number }
/** Separate, explicitly initialized incremental audio batch. No dates/resets/refunds.
 * Each provider attempt reserves durably BEFORE dispatch, including retries and
 * requests whose outcome is unknown. Never reads/writes the old text ledger. */
export class AudioBudget {
  private ledger: Ledger
  private lock: number
  private failed = false
  private closed = false
  constructor(private directory: string) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('Private audio ledger required')
    this.lock = openSync(join(directory, 'audio.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      const path = join(directory, 'audio-budget.json'), stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1024) throw new Error()
      this.ledger = JSON.parse(readFileSync(path, 'utf8'))
      if (Object.keys(this.ledger).sort().join(',') !== 'attempts,batch,reservedMicroCny,version' || this.ledger.version !== 1 || this.ledger.batch !== AUDIO_POLICY.batch ||
        !Number.isSafeInteger(this.ledger.reservedMicroCny) || this.ledger.reservedMicroCny < 0 || this.ledger.reservedMicroCny > AUDIO_POLICY.limitMicroCny ||
        !Number.isSafeInteger(this.ledger.attempts) || this.ledger.attempts < 0) throw new Error()
    } catch { closeSync(this.lock); unlinkSync(join(directory, 'audio.lock')); throw new Error('Audio budget unavailable') }
  }
  get remainingMicroCny(): number { return AUDIO_POLICY.limitMicroCny - this.ledger.reservedMicroCny }
  reserve(amount: number): void {
    if (this.closed || this.failed) throw new RelayError('unavailable')
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new RelayError('protocol')
    if (amount > this.remainingMicroCny) throw new RelayError('quota')
    const next = { ...this.ledger, reservedMicroCny: this.ledger.reservedMicroCny + amount, attempts: this.ledger.attempts + 1 }
    let fd: number | undefined
    try {
      const temporary = join(this.directory, 'audio-budget.pending')
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, join(this.directory, 'audio-budget.json'))
      fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY); fsyncSync(fd); closeSync(fd); fd = undefined
      this.ledger = next
    } catch { this.failed = true; throw new RelayError('unavailable') }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  fetch(upstream: WorkerFetch): WorkerFetch {
    return async (input, init) => {
      if (!AUDIO_POLICY.verified || init?.signal?.aborted) throw new RelayError('unavailable')
      const asrUrl = AUDIO_POLICY.model === 'qwen3-asr-flash-realtime' ? 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=' + AUDIO_POLICY.model : 'https://dashscope.aliyuncs.com/api-ws/v1/inference'
      if (String(input) === asrUrl && new Headers(init?.headers).get('Upgrade') === 'websocket') {
        if (init?.method && init.method !== 'GET' || init?.body != null || init?.redirect !== 'error') throw new RelayError('protocol')
        this.reserve(AUDIO_POLICY.asrReservationMicroCny)
        return upstream(input, init)
      }
      const quote = quoteWebTextRequest(input, init)
      if (quote.reservationMicroCny > this.remainingMicroCny) return new Response('{"error":"quota"}', { status: 429 })
      this.reserve(quote.reservationMicroCny)
      if (init?.signal?.aborted) throw new RelayError('unavailable')
      return upstream(input, quote.request)
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; closeSync(this.lock); unlinkSync(join(this.directory, 'audio.lock'))
  }
}
