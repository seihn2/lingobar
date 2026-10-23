import { app } from 'electron'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Explicit, time-limited local diagnostics. Never include audio, text, keys or URLs.
let destination: string | null | undefined
let expiresAt = 0
export function trace(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  try {
    if (destination === undefined) {
      const folder = app.getPath('userData')
      const until = Number(readFileSync(join(folder, 'diagnostics-until'), 'utf8'))
      destination = until > Date.now() && until < Date.now() + 3_600_000 ? join(folder, 'diagnostics.jsonl') : null
      expiresAt = until
    }
    if (!destination || Date.now() >= expiresAt) return
    try { if (statSync(destination).size > 2_000_000) return } catch { /* First event. */ }
    appendFileSync(destination, JSON.stringify({ at: Date.now(), event, ...fields }) + '\n', { mode: 0o600 })
  } catch { destination = null }
}
