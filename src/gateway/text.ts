import { randomUUID } from 'node:crypto'
import { parseTextRequest, parseTextResponse } from '../shared/text-protocol'
import type { Caption } from '../shared/types'
import { createCompletion } from '../worker/completion'
import { RelayError, type WorkerFetch } from '../worker/types'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const failure = (code: string, status: number) => json({ error: code }, status)

async function body(request: Request): Promise<string> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' || !request.body) throw new RelayError('protocol')
  const declared = request.headers.get('Content-Length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 8192)) throw new RelayError('protocol')
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  request.signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0, text = ''
  try {
    while (true) {
      if (request.signal.aborted) throw new RelayError('unavailable')
      const part = await reader.read()
      if (request.signal.aborted) throw new RelayError('unavailable')
      if (part.done) return text + decoder.decode()
      bytes += part.value.byteLength
      if (bytes > 8192) { cancel(); throw new RelayError('protocol') }
      text += decoder.decode(part.value, { stream: true })
    }
  } finally { request.signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

/** Explicit text work only. Access/Origin and total-budget admission belong to the gateway. */
export function createTextHandler(translationKey: string, transport: WorkerFetch,
  options: { now?: () => number; id?: () => string } = {}) {
  return async (request: Request): Promise<Response> => {
    try {
      const input = parseTextRequest(await body(request))
      if (request.signal.aborted) throw new RelayError('unavailable')
      // Translation has no automatic retry. Optional ruby retains its existing
      // bounded format retry, and each actual fetch is separately reserved.
      const completion = createCompletion({ translationKey }, transport, 3)
      const translated = await completion.translate(input.original, input.targetLanguages, false, request.signal)
      const caption: Caption = { id: `text:${(options.id || randomUUID)()}`, source: 'text',
        original: input.original, translatedOriginal: input.original, ...translated,
        targetLanguages: [...input.targetLanguages], createdAt: (options.now || Date.now)(), status: 'ready', saved: false }
      if (input.showFurigana && input.targetLanguages.includes('ja') && translated.ja) {
        try {
          const annotation = await completion.annotate(input.original, translated.ja, request.signal)
          caption.reading = annotation.reading; caption.jaSegments = annotation.jaSegments; caption.furiganaStatus = 'ready'
        } catch {
          if (request.signal.aborted) throw new RelayError('unavailable')
          caption.furiganaStatus = 'error'
        }
      }
      if (request.signal.aborted) throw new RelayError('unavailable')
      return json(parseTextResponse(JSON.stringify({ version: 1, requestId: input.requestId, caption }), input))
    } catch (error) {
      const code = request.signal.aborted ? 'unavailable' : error instanceof RelayError ? error.code : 'protocol'
      return failure(code, code === 'unauthorized' ? 401 : code === 'quota' ? 429 : code === 'unavailable' ? 503 : code === 'upstream' ? 502 : 400)
    }
  }
}
