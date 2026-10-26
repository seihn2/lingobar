import { ANNOTATION_TIMEOUT_MS, MAX_ANNOTATION_BYTES, parseAnnotationRequest, parseAnnotationResponse, type AnnotationErrorCode } from '../shared/annotation-protocol'
import { annotationConfig, authorized, type WorkerEnv } from './config'
import { createCompletion } from './completion'
import { RelayError, type WorkerFetch } from './types'

class HttpFailure extends Error {
  constructor(readonly code: AnnotationErrorCode, readonly status: number) { super(code) }
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const failure = (code: AnnotationErrorCode, status: number): Response => json({ version: 1, error: code }, status)
const statusFor = (code: AnnotationErrorCode): number => code === 'unauthorized' ? 401 : code === 'busy' || code === 'quota' ? 429
  : code === 'timeout' ? 504 : code === 'protocol' ? 400 : code === 'unavailable' ? 503 : 502

async function boundedBody(request: Request, signal: AbortSignal): Promise<string> {
  if (!request.body) throw new HttpFailure('protocol', 400)
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  let bytes = 0, text = '', complete = false
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw new HttpFailure('unavailable', 499)
      const chunk = await reader.read()
      if (signal.aborted) throw new HttpFailure('unavailable', 499)
      if (chunk.done) { complete = true; return text + decoder.decode() }
      bytes += chunk.value.byteLength
      if (bytes > MAX_ANNOTATION_BYTES) throw new HttpFailure('protocol', 413)
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    if (error instanceof HttpFailure) throw error
    throw new HttpFailure('protocol', 400)
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    reader.releaseLock()
  }
}

/** One factory belongs to one Worker isolate. Text annotation never opens an ASR session. */
export function createAnnotationHandler(transport: WorkerFetch): (request: Request, env: WorkerEnv) => Promise<Response> {
  let active = 0
  return async (request, env) => {
    const url = new URL(request.url)
    if (url.pathname !== '/api/annotation') return failure('protocol', 404)
    if (request.method !== 'POST') return failure('protocol', 405)
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password || request.headers.has('Upgrade')) return failure('protocol', 400)
    if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return failure('unauthorized', 403)
    if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return failure('protocol', 415)
    const length = request.headers.get('Content-Length')
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) return failure('protocol', 400)
    if (length !== null && Number(length) > MAX_ANNOTATION_BYTES) return failure('protocol', 413)
    const config = annotationConfig(env)
    if (!config) return failure('unavailable', 503)
    if (request.signal.aborted) return failure('unavailable', 499)
    if (active >= 2) return failure('busy', 429)
    active++
    const controller = new AbortController()
    let rejectDeadline!: (error: HttpFailure) => void
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
    const cancel = () => { rejectDeadline(new HttpFailure('unavailable', 499)); controller.abort() }
    const timer = setTimeout(() => { rejectDeadline(new HttpFailure('timeout', 504)); controller.abort() }, ANNOTATION_TIMEOUT_MS)
    request.signal.addEventListener('abort', cancel, { once: true })
    const work = async (): Promise<Response> => {
      // The verifier needs routing and identity evidence only, never the caption body.
      const authRequest = new Request(request.url, { method: 'POST', headers: request.headers, signal: controller.signal })
      const allowed = await authorized(authRequest, env.AUTH_SERVICE!, '/api/annotation')
      if (controller.signal.aborted) throw new HttpFailure('unavailable', 499)
      if (!allowed) throw new HttpFailure('unauthorized', 401)
      let input: ReturnType<typeof parseAnnotationRequest>
      try { input = parseAnnotationRequest(await boundedBody(request, controller.signal)) }
      catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure('protocol', 400) }
      if (controller.signal.aborted) throw new HttpFailure('unavailable', 499)
      const result = await createCompletion(config, transport, 2).annotate(input.original, input.japanese, controller.signal)
      if (controller.signal.aborted) throw new HttpFailure('unavailable', 499)
      let response: ReturnType<typeof parseAnnotationResponse>
      try {
        response = parseAnnotationResponse(JSON.stringify({ version: 1, type: 'annotation', requestId: input.requestId,
          sessionId: input.sessionId, captionId: input.captionId, sourceRevision: input.sourceRevision, language: 'ja',
          reading: result.reading, jaSegments: result.jaSegments }), input)
      } catch { throw new HttpFailure('upstream', 502) }
      return json(response)
    }
    try { return await Promise.race([deadline, work()]) }
    catch (error) {
      if (error instanceof HttpFailure) return failure(error.code, error.status)
      if (error instanceof RelayError) return failure(error.code, statusFor(error.code))
      return failure('upstream', 502)
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', cancel)
      controller.abort(); active--
    }
  }
}
