import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import type { GatewayConfig } from './config'

interface Claims { exp: number; sub: string }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const decode = (v: string): Record<string, unknown> => {
  if (!/^[A-Za-z0-9_-]+$/u.test(v)) throw new Error()
  const decoded: unknown = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'))
  if (!object(decoded)) throw new Error()
  return decoded
}
/** Access header is untrusted until signature, pinned issuer/audience, time and allowlist all pass. */
export class AccessVerifier {
  private keys = new Map<string, KeyObject>()
  private expires = 0
  private retryAt = 0
  private pending: Promise<void> | null = null
  constructor(private config: Pick<GatewayConfig, 'issuer' | 'audience' | 'email'>,
    private transport: typeof fetch = fetch, private now = Date.now) {}
  private async refresh(): Promise<void> {
    if (this.pending) return this.pending
    if (this.now() < this.retryAt) throw new Error()
    this.retryAt = this.now() + 30_000
    const work = async () => {
      const controller = new AbortController()
      let reject!: () => void
      const timeout = new Promise<never>((_resolve, fail) => { reject = () => fail(new Error()) })
      const timer = setTimeout(() => { controller.abort(); reject() }, 3000)
      try {
        const load = async () => {
          const response = await this.transport(`${this.config.issuer}/cdn-cgi/access/certs`, { redirect: 'error', signal: controller.signal })
          if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error() }
          const reader = response.body.getReader()
          let text = '', bytes = 0
          try {
            const decoder = new TextDecoder('utf-8', { fatal: true })
            while (true) {
              const chunk = await reader.read()
              if (controller.signal.aborted) throw new Error()
              if (chunk.done) { text += decoder.decode(); break }
              if ((bytes += chunk.value.byteLength) > 65_536) throw new Error()
              text += decoder.decode(chunk.value, { stream: true })
            }
          } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
          const jwks: unknown = JSON.parse(text)
          if (!object(jwks) || !Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 16) throw new Error()
          const keys = new Map<string, KeyObject>()
          for (const key of jwks.keys) {
            if (!object(key) || key.kty !== 'RSA' || (key.alg && key.alg !== 'RS256') || (key.use && key.use !== 'sig') ||
              typeof key.kid !== 'string' || key.kid.length > 128 || keys.has(key.kid) || typeof key.n !== 'string' ||
              Buffer.from(key.n, 'base64url').length < 256 || Buffer.from(key.n, 'base64url').length > 512 || key.e !== 'AQAB' || 'd' in key) throw new Error()
            keys.set(key.kid, createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' }))
          }
          if (controller.signal.aborted) throw new Error()
          this.keys = keys; this.expires = this.now() + 300_000
        }
        await Promise.race([load(), timeout])
      } finally { clearTimeout(timer); controller.abort() }
    }
    this.pending = work().finally(() => { this.pending = null })
    return this.pending
  }
  async validate(token: string | undefined): Promise<Claims | null> {
    try {
      if (!token || token.length > 8192) return null
      const parts = token.split('.')
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[2])) return null
      const header = decode(parts[0]), claims = decode(parts[1]), seconds = Math.floor(this.now() / 1000)
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 128 || 'crit' in header ||
        claims.iss !== this.config.issuer || !Array.isArray(claims.aud) || !claims.aud.includes(this.config.audience) ||
        typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds ||
        typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > seconds || claims.iat >= claims.exp ||
        (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > seconds)) ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 ||
        typeof claims.email !== 'string' || claims.email.toLowerCase() !== this.config.email) return null
      if (this.expires <= this.now() || !this.keys.has(header.kid)) await this.refresh()
      const key = this.keys.get(header.kid)
      if (!key || this.expires <= this.now() || !verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), key, Buffer.from(parts[2], 'base64url'))) return null
      if (claims.exp * 1000 <= this.now()) return null
      return { exp: claims.exp, sub: claims.sub }
    } catch { return null }
  }
}
