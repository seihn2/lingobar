import { isAbsolute } from 'node:path'
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
}
const invalid = (): never => { throw new Error('Invalid gateway configuration') }
const credential = (v: string | undefined): string => {
  if (!v?.trim() || v.length > 4096 || /[\u0000-\u001f\u007f]/u.test(v)) invalid()
  return v!.trim()
}
/** Optional existing JSON credential file; never exported to browser/config responses. */
function translationCredential(env: Record<string, string | undefined>): string {
  const filename = env.TRANSLATION_API_KEY_FILE
  if (!filename) return credential(env.TRANSLATION_API_KEY)
  if (!isAbsolute(filename)) invalid()
  let descriptor: number | undefined
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(descriptor)
    if (!file.isFile() || file.size > 8192 || (file.mode & 0o077)) invalid()
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'apiKey') invalid()
    return credential((value as { apiKey: string }).apiKey)
  } catch { return invalid() }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
const integer = (v: string | undefined, max: number): number => {
  if (!v || !/^[1-9]\d*$/u.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max) invalid()
  return Number(v)
}
/** Environment selects the explicit server credential source; no desktop/keychain lookup. */
export function gatewayConfig(env: Record<string, string | undefined>): GatewayConfig | null {
  const audio = env.WEB_ENABLED === '1', text = env.WEB_TEXT_ENABLED === '1'
  if (!audio && !text) return null
  // The current cumulative budget covers text only; never enable unpriced ASR beside it.
  if (audio && text) invalid()
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
  const model = env.ASR_MODEL || 'qwen-audio-3.1-asr-flash-streaming'
  if (!['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'qwen3-asr-flash-realtime'].includes(model)) invalid()
  return { origin: origin.origin, issuer, audience, email: email.toLowerCase(), stateDirectory,
    dailySessions: audio ? integer(env.GATEWAY_DAILY_SESSIONS, 288) : 0,
    dailyCompletionRequests: audio ? integer(env.GATEWAY_DAILY_COMPLETION_REQUESTS, 10_000) : 0,
    asrKey: audio ? credential(env.ASR_API_KEY) : '', translationKey: translationCredential(env), model: model as RelayConfig['model'],
    ...(audio ? {} : { audioEnabled: false }), ...(text ? { text: { ledgerDirectory } } : {}) }
}
