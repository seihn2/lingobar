import { isAbsolute, resolve } from 'node:path'
import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs'
import type { RelayConfig } from '../worker/types'

export interface GatewayConfig extends RelayConfig {
  origin: string
  issuer: string
  audience: string
  email: string
  stateDirectory: string
  dailySessions: number
  dailyCompletionRequests: number
  audioEnabled?: boolean
  text?: { ledgerDirectory: string }
  credentialsFile?: string
  asrCredentialsFile?: string
  audioRequested?: boolean
  audioLedgerDirectory?: string
}
const invalid = (): never => { throw new Error('Invalid gateway configuration') }
const credential = (v: string | undefined): string => {
  if (!v?.trim() || v.length > 4096 || /[\u0000-\u001f\u007f]/u.test(v)) invalid()
  return v!.trim()
}
/** Optional existing JSON credential file; never exported to browser/config responses. */
function serverCredential(env: Record<string, string | undefined>, kind: 'TRANSLATION' | 'ASR'): string {
  const filename = env[`${kind}_API_KEY_FILE`]
  if (!filename) return kind === 'ASR' && !env.ASR_API_KEY ? '' : credential(env[`${kind}_API_KEY`])
  if (!isAbsolute(filename)) invalid()
  const ownerSetup = env.WEB_TEXT_ENABLED === '1' || kind === 'ASR'
  let descriptor: number | undefined
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(descriptor)
    if (!file.isFile() || file.size > 8192 || (file.mode & 0o077)) invalid()
    let value: unknown
    try { value = JSON.parse(readFileSync(descriptor, 'utf8')) }
    catch { if (ownerSetup) return ''; return invalid() }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'apiKey' ||
        typeof (value as { apiKey?: unknown }).apiKey !== 'string' || !(value as { apiKey: string }).apiKey.trim()) {
      if (ownerSetup) return ''
      return invalid()
    }
    return credential((value as { apiKey: string }).apiKey)
  } catch (error) {
    if (ownerSetup && (error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    return invalid()
  } finally { if (descriptor !== undefined) closeSync(descriptor) }
}
const integer = (v: string | undefined, max: number): number => {
  if (!v || !/^[1-9]\d*$/u.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max) invalid()
  return Number(v)
}
/** Environment selects the explicit server credential source; no desktop/keychain lookup. */
export function gatewayConfig(env: Record<string, string | undefined>): GatewayConfig | null {
  const audio = env.WEB_ENABLED === '1', text = env.WEB_TEXT_ENABLED === '1'
  if (!audio && !text) return null
  // Mixed operation is supported; monetary admission is separate from daily counts.
  let origin: URL
  try { origin = new URL(env.GATEWAY_PUBLIC_ORIGIN || '') } catch { return invalid() }
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/' || origin.username || origin.password) invalid()
  const issuer = env.ACCESS_ISSUER || ''
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u.test(issuer)) invalid()
  const audience = env.ACCESS_AUDIENCE || '', email = env.ACCESS_ALLOWED_EMAIL || ''
  if (!/^[a-f0-9]{64}$/u.test(audience) || !/^[^\s@,;]{1,128}@[^\s@,;]{1,128}$/u.test(email)) invalid()
  const stateDirectory = env.GATEWAY_STATE_DIRECTORY || ''
  if (audio && !isAbsolute(stateDirectory)) invalid()
  const ledgerDirectory = env.GATEWAY_TEXT_LEDGER_DIRECTORY || ''
  if (text && !isAbsolute(ledgerDirectory)) invalid()
  const audioLedgerDirectory = env.GATEWAY_AUDIO_LEDGER_DIRECTORY || ''
  if (audio && (!isAbsolute(audioLedgerDirectory) || audioLedgerDirectory === ledgerDirectory || audioLedgerDirectory === stateDirectory)) invalid()
  if (env.ASR_API_KEY_FILE && env.TRANSLATION_API_KEY_FILE && resolve(env.ASR_API_KEY_FILE) === resolve(env.TRANSLATION_API_KEY_FILE)) invalid()
  const model = env.ASR_MODEL || 'qwen3-asr-flash-realtime'
  if (!['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'qwen3-asr-flash-realtime'].includes(model)) invalid()
  return { origin: origin.origin, issuer, audience, email: email.toLowerCase(), stateDirectory,
    dailySessions: audio ? integer(env.GATEWAY_DAILY_SESSIONS, 288) : 0,
    dailyCompletionRequests: audio ? integer(env.GATEWAY_DAILY_COMPLETION_REQUESTS, 10_000) : 0,
    asrKey: audio || env.ASR_API_KEY_FILE ? serverCredential(env, 'ASR') : '', translationKey: serverCredential(env, 'TRANSLATION'), model: model as RelayConfig['model'],
    audioEnabled: audio, audioRequested: audio, ...(audio ? { audioLedgerDirectory } : {}), ...(text ? { text: { ledgerDirectory } } : {}),
    ...(env.ASR_API_KEY_FILE ? { asrCredentialsFile: env.ASR_API_KEY_FILE } : {}),
    ...(text && env.TRANSLATION_API_KEY_FILE ? { credentialsFile: env.TRANSLATION_API_KEY_FILE } : {}) }
}
