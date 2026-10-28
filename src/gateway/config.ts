import { isAbsolute } from 'node:path'
import type { RelayConfig } from '../worker/types'

export interface GatewayConfig extends RelayConfig {
  origin: string
  issuer: string
  audience: string
  email: string
  stateDirectory: string
  dailySessions: number
  dailyCompletionRequests: number
}
const invalid = (): never => { throw new Error('Invalid gateway configuration') }
const credential = (v: string | undefined): string => {
  if (!v?.trim() || v.length > 4096 || /[\u0000-\u001f\u007f]/u.test(v)) invalid()
  return v!.trim()
}
const integer = (v: string | undefined, max: number): number => {
  if (!v || !/^[1-9]\d*$/u.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max) invalid()
  return Number(v)
}
/** Only the executable reads process.env. No settings files or desktop credentials are consulted. */
export function gatewayConfig(env: Record<string, string | undefined>): GatewayConfig | null {
  if (env.WEB_ENABLED !== '1') return null
  let origin: URL
  try { origin = new URL(env.GATEWAY_PUBLIC_ORIGIN || '') } catch { return invalid() }
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/' || origin.username || origin.password) invalid()
  const issuer = env.ACCESS_ISSUER || ''
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u.test(issuer)) invalid()
  const audience = env.ACCESS_AUDIENCE || '', email = env.ACCESS_ALLOWED_EMAIL || ''
  if (!/^[a-f0-9]{64}$/u.test(audience) || !/^[^\s@,;]{1,128}@[^\s@,;]{1,128}$/u.test(email)) invalid()
  const stateDirectory = env.GATEWAY_STATE_DIRECTORY || ''
  if (!isAbsolute(stateDirectory)) invalid()
  const model = env.ASR_MODEL || 'qwen-audio-3.1-asr-flash-streaming'
  if (!['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'qwen3-asr-flash-realtime'].includes(model)) invalid()
  return { origin: origin.origin, issuer, audience, email: email.toLowerCase(), stateDirectory,
    dailySessions: integer(env.GATEWAY_DAILY_SESSIONS, 288),
    dailyCompletionRequests: integer(env.GATEWAY_DAILY_COMPLETION_REQUESTS, 10_000),
    asrKey: credential(env.ASR_API_KEY), translationKey: credential(env.TRANSLATION_API_KEY), model: model as RelayConfig['model'] }
}
