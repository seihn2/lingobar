import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { WebSocketServer } from 'ws'
import { AccessVerifier } from './access'
import { DailyBudget } from './budget'
import { AudioBudget } from './audio-budget'
import { AUDIO_POLICY } from './audio-policy'
import { WebTextBudget } from './text-budget'
import { createTextHandler } from './text'
import { saveTranslationKey, validTranslationKey } from './credentials'
import type { GatewayConfig } from './config'
import { NodePeer, nodeTransport } from './transport'
import { RelaySession } from '../worker/session'
import { createAnnotationHandler } from '../worker/annotation'
import { parseClientMessage } from '../shared/web-protocol'
import { RelayError, type WorkerFetch } from '../worker/types'

const ASR_CREDENTIALS_PATH = '/api/settings/asr-key'
const CREDENTIALS_PATH = '/api/settings/translation-key'
interface Dependencies { publicFetch?: typeof fetch; upstream?: WorkerFetch; now?: () => number }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const error = (status: number) => json({ error: status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'quota' : status === 503 ? 'unavailable' : 'protocol' }, status)
async function send(response: Response, target: ServerResponse): Promise<void> {
  target.writeHead(response.status, Object.fromEntries(response.headers))
  target.end(await response.text())
}
function headers(req: IncomingMessage): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') result.set(name, value)
  return result
}

/** API only, loopback only. Existing static server must route these exact paths without changing Access policy. */
export function createGateway(config: GatewayConfig | null, dependencies: Dependencies = {}) {
  const now = dependencies.now || Date.now
  const verifier = config ? new AccessVerifier(config, dependencies.publicFetch, now) : null
  let budget: DailyBudget | null = null, audioBudget: AudioBudget | null = null, textBudget: WebTextBudget | null = null
  try {
    budget = config && config.audioEnabled !== false ? new DailyBudget(config, now) : null
    audioBudget = config?.audioLedgerDirectory ? new AudioBudget(config.audioLedgerDirectory) : null
    textBudget = config?.text ? new WebTextBudget(config.text.ledgerDirectory) : null
  } catch (error) {
    // Release only resources acquired by this startup, never another process's lock.
    textBudget?.close(); audioBudget?.close(); budget?.close()
    throw error
  }
  const audioStatus = () => !config || config.audioEnabled === false ? 'disabled' : !config.asrKey || !config.translationKey ? 'missing-key' : !AUDIO_POLICY.verified || !audioBudget || config.model !== AUDIO_POLICY.model ? 'budget-unverified' : audioBudget.remainingMicroCny < AUDIO_POLICY.asrReservationMicroCny ? 'quota' : 'ready'
  const upstream = dependencies.upstream || nodeTransport()
  const textUpstream = textBudget ? textBudget.fetch(upstream) : upstream
  const audioUpstream = audioBudget ? audioBudget.fetch(upstream) : async () => { throw new RelayError('unavailable') }
  const audioAnnotation = createAnnotationHandler(audioUpstream)
  const annotation = createAnnotationHandler(textBudget ? textUpstream : audioUpstream)
  let translate = config && textBudget ? createTextHandler(config.translationKey, textUpstream, { now }) : null
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false, clientTracking: true })
  const sessions = new Set<RelaySession>(), controllers = new Set<AbortController>(), expiryTimers = new Set<ReturnType<typeof setTimeout>>()
  const pending = new Set<Promise<unknown>>()
  let active = 0, authorizing = 0, annotations = 0, textRequests = 0, closing = false, windowAt = now(), requests = 0
  const hold = (promise: Promise<unknown>) => { pending.add(promise); void promise.finally(() => pending.delete(promise)) }
  function boundary(req: IncomingMessage, upgrade: boolean): number | null {
    if (closing) return 503
    if (!config) return 503
    if (req.headers.host !== new URL(config.origin).host) return 403
    const origin = req.headers.origin
    if ((origin && origin !== config.origin) || req.headers['sec-fetch-site'] === 'cross-site' || (upgrade || ['/api/annotation', '/api/audio-annotation'].includes(req.url || '') || req.url === '/api/translate' || [CREDENTIALS_PATH, ASR_CREDENTIALS_PATH].includes(req.url || '') && req.method === 'POST') && origin !== config.origin) return 403
    if (now() - windowAt >= 60_000) { windowAt = now(); requests = 0 }
    if (++requests > 60 || authorizing >= 4) return 429
    return null
  }
  async function identity(req: IncomingMessage) {
    authorizing++
    try { return await verifier!.validate(typeof req.headers['cf-access-jwt-assertion'] === 'string' ? req.headers['cf-access-jwt-assertion'] : undefined) }
    finally { authorizing-- }
  }
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    const run = async () => {
      if (req.url === '/healthz' && req.method === 'GET') return send(json({ status: config && !closing ? 'configured' : 'disabled' }, config && !closing ? 200 : 503), res)
      if (!['/app-config.json', '/api/session', '/api/annotation', '/api/audio-annotation', '/api/translate', CREDENTIALS_PATH, ASR_CREDENTIALS_PATH].includes(req.url || '')) return send(error(404), res)
      if ([CREDENTIALS_PATH, ASR_CREDENTIALS_PATH].includes(req.url || '') ? !['GET', 'POST'].includes(req.method || '') : req.method !== (['/api/annotation', '/api/audio-annotation'].includes(req.url || '') || req.url === '/api/translate' ? 'POST' : 'GET')) return send(error(405), res)
      if (!config) return send(req.url === '/app-config.json' ? json({ version: 1, backend: null }) : error(503), res)
      const denied = boundary(req, false)
      if (denied) return send(error(denied), res)
      const claims = await identity(req)
      if (!claims) return send(error(401), res)
      if (req.destroyed || res.destroyed || closing) return
      if (req.url === '/app-config.json') return send(json({ version: 1, backend: audioStatus() === 'ready' ? '/api/session' : null,
        ...(config.text ? { textBackend: config.translationKey ? '/api/translate' : null } : {}),
        ...(config.text && config.credentialsFile ? { credentialsBackend: CREDENTIALS_PATH } : {}),
        ...(config.audioRequested || config.asrCredentialsFile ? { audioStatus: audioStatus() } : {}),
        ...(config.asrCredentialsFile ? { asrCredentialsBackend: ASR_CREDENTIALS_PATH } : {}) }), res)
      if ([CREDENTIALS_PATH, ASR_CREDENTIALS_PATH].includes(req.url || '')) {
        const asr = req.url === ASR_CREDENTIALS_PATH
        const filename = asr ? config.asrCredentialsFile : config.text && config.credentialsFile
        if (!filename) return send(error(503), res)
        if (req.method === 'GET') return send(json({ configured: Boolean(asr ? config.asrKey : config.translationKey) }), res)
        if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return send(error(400), res)
        let bytes = 0, body = ''
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk)
          if (bytes > 8192) return send(error(400), res)
          body += chunk.toString('utf8')
        }
        let value: unknown
        try { value = JSON.parse(body) } catch { return send(error(400), res) }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'apiKey' ||
            !validTranslationKey((value as { apiKey: unknown }).apiKey)) return send(error(400), res)
        const apiKey = (value as { apiKey: string }).apiKey
        if (req.aborted || res.destroyed || closing || claims.exp * 1000 <= now()) return send(error(401), res)
        try { saveTranslationKey(filename, apiKey) } catch { return send(error(503), res) }
        if (asr) config.asrKey = apiKey
        else {
          config.translationKey = apiKey
          translate = textBudget ? createTextHandler(apiKey, textUpstream, { now }) : null
        }
        return send(json({ configured: true }), res)
      }
      if (req.url === '/api/session') return send(error(audioStatus() === 'ready' ? 426 : 503), res)
      if (req.url === '/api/translate') {
        if (!translate || !config.translationKey) return send(error(503), res)
        if (textRequests >= 1) return send(error(429), res)
        textRequests++
        const controller = new AbortController(); controllers.add(controller)
        const timer = setTimeout(() => controller.abort(), Math.min(60_000, claims.exp * 1000 - now()))
        const abort = () => controller.abort()
        const responseClosed = () => { if (!res.writableEnded) abort() }
        req.once('aborted', abort); res.once('close', responseClosed)
        try {
          const request = new Request(config.origin + req.url, { method: 'POST', headers: headers(req), signal: controller.signal,
            body: Readable.toWeb(req), duplex: 'half' } as RequestInit)
          const result = await translate(request)
          if (!res.destroyed) await send(result, res)
        } finally {
          controller.abort(); clearTimeout(timer); controllers.delete(controller); textRequests--
          req.removeListener('aborted', abort); res.removeListener('close', responseClosed)
        }
        return
      }
      if (req.url === '/api/audio-annotation' && audioStatus() !== 'ready') return send(error(503), res)
      if (!config.translationKey || !budget && !textBudget) return send(error(503), res)
      if (annotations >= 2) return send(error(429), res)
      try { if (req.url === '/api/audio-annotation' || !textBudget) budget?.reserve('annotation') } catch (e) { return send(error(e instanceof RelayError && e.code === 'quota' ? 429 : 503), res) }
      annotations++
      const controller = new AbortController(); controllers.add(controller)
      const timer = setTimeout(() => controller.abort(), Math.min(25_000, claims.exp * 1000 - now()))
      const abort = () => controller.abort()
      const responseClosed = () => { if (!res.writableEnded) abort() }
      req.once('aborted', abort); res.once('close', responseClosed)
      try {
        const request = new Request(config.origin + (req.url === '/api/audio-annotation' ? '/api/annotation' : req.url), { method: 'POST', headers: headers(req), signal: controller.signal,
          body: Readable.toWeb(req), duplex: 'half' } as RequestInit)
        const result = await (req.url === '/api/audio-annotation' ? audioAnnotation : annotation)(request, { WEB_ENABLED: '1', TRANSLATION_API_KEY: config.translationKey,
          AUTH_SERVICE: { fetch: async () => new Response(null, { status: !controller.signal.aborted && claims.exp * 1000 > now() ? 204 : 401 }) } })
        if (!res.destroyed) await send(result, res)
      } finally {
        controller.abort(); clearTimeout(timer); controllers.delete(controller); annotations--
        req.removeListener('aborted', abort); res.removeListener('close', responseClosed)
      }
    }
    void run().catch(() => { if (!res.headersSent && !res.destroyed) void send(error(503), res); else res.destroy() })
  })
  server.maxRequestsPerSocket = 100
  server.on('upgrade', (req, socket, head) => {
    const reject = (status: number) => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`)
    }
    const run = async () => {
      if (config?.audioEnabled === false) return reject(503)
      if (req.url !== '/api/session' || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') return reject(400)
      const denied = boundary(req, true)
      if (denied) return reject(denied)
      const claims = await identity(req)
      if (!claims) return reject(401)
      if (socket.destroyed || closing) return reject(503)
      if (audioStatus() !== 'ready') return reject(audioStatus() === 'quota' ? 429 : 503)
      if (active >= 1) return reject(429)
      // Reserve concurrency before handleUpgrade. No provider/budget work happens until a valid start control.
      active++
      let handed = false
      try {
        sockets.handleUpgrade(req, socket, head, ws => {
          handed = true
          let started = false
          const peer = new NodePeer(ws, data => {
            if (started) return true
            let message
            try { message = parseClientMessage(data) } catch { return true }
            if (message.type !== 'start') return true
            try { budget!.reserve('session'); started = true; return true }
            catch (e) {
              peer.send(JSON.stringify({ version: 1, type: 'error', sessionId: message.sessionId,
                code: e instanceof RelayError && e.code === 'quota' ? 'quota' : 'unavailable' }))
              peer.close(); return false
            }
          })
          const session = new RelaySession(peer, config!, { fetch: audioUpstream, hold, id: randomUUID, now,
            limits: { durationMs: AUDIO_POLICY.maxSessionMs, audioBytes: AUDIO_POLICY.maxAudioBytes } })
          sessions.add(session)
          const timer = setTimeout(() => session.stop(), Math.min(300_000, claims.exp * 1000 - now()))
          expiryTimers.add(timer)
          ws.once('close', () => { active--; session.stop(); sessions.delete(session); clearTimeout(timer); expiryTimers.delete(timer) })
          peer.accept()
        })
      } catch { if (!handed) active--; reject(503) }
    }
    void run().catch(() => reject(503))
  })
  return {
    server,
    async close(): Promise<void> {
      closing = true
      for (const controller of controllers) controller.abort()
      for (const session of sessions) session.stop()
      for (const timer of expiryTimers) clearTimeout(timer)
      for (const ws of sockets.clients) ws.terminate()
      server.closeAllConnections()
      await new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve() })
      sockets.close(); budget?.close(); textBudget?.close(); audioBudget?.close()
    }
  }
}
