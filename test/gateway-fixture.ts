import { generateKeyPairSync, sign } from 'node:crypto'
import type { GatewayConfig } from '../src/gateway/config'

// Generated in memory for tests, never account keys, audio, recordings or user text.
export const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-kid', alg: 'RS256', use: 'sig' }
export const now = Date.UTC(2026, 9, 28, 12)
export const configuration = (stateDirectory: string): GatewayConfig => ({ origin: 'https://lingobar.example', issuer: 'https://synthetic-team.cloudflareaccess.com',
  audience: 'a'.repeat(64), email: 'synthetic@example.test', stateDirectory, dailySessions: 2, dailyCompletionRequests: 100,
  asrKey: 'synthetic-asr', translationKey: 'synthetic-translation', model: 'qwen-audio-3.1-asr-flash-streaming' })
export function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const payload = { iss: configuration('').issuer, aud: [configuration('').audience], email: configuration('').email, sub: 'synthetic-subject',
    iat: Math.floor(now / 1000) - 1, exp: Math.floor(now / 1000) + 3600, ...claims }
  const value = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-kid', ...header })).toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.')
  return value + '.' + sign('RSA-SHA256', Buffer.from(value), pair.privateKey).toString('base64url')
}
export const jwks = async () => Response.json({ keys: [publicJwk] })
