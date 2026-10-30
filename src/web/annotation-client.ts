import { ANNOTATION_TIMEOUT_MS, MAX_ANNOTATION_BYTES, annotationError, parseAnnotationRequest, parseAnnotationResponse, type AnnotationErrorCode, type AnnotationRequest, type AnnotationResponse } from '../shared/annotation-protocol'

const messages: Record<AnnotationErrorCode, string> = {
  busy: '注音请求较多，请稍后重试。', timeout: '注音请求超时，请重试。',
  unauthorized: '注音服务未授权，请检查服务端配置。', quota: '注音服务额度已用尽。',
  upstream: '注音服务暂不可用，请稍后重试。', protocol: '注音服务返回的数据格式不正确。', unavailable: '注音服务尚未配置完成。'
}
export class AnnotationFailure extends Error {
  constructor(readonly code: AnnotationErrorCode) { super(messages[code]); this.name = 'AnnotationFailure' }
}
export function annotationCancelled(): Error { const error = new Error('已取消注音。'); error.name = 'AbortError'; return error }

/** Fixed same-origin, text-only request. The deadline also bounds transports that ignore AbortSignal. */
export async function requestAnnotation(input: AnnotationRequest, origin: string, parent: AbortSignal, transport: typeof fetch = fetch, endpoint: '/api/annotation' | '/api/audio-annotation' | '/owner/api/annotation' | '/owner/api/audio-annotation' = '/api/annotation'): Promise<AnnotationResponse> {
  if (!['/api/annotation', '/api/audio-annotation', '/owner/api/annotation', '/owner/api/audio-annotation'].includes(endpoint)) throw new AnnotationFailure('protocol')
  const request = parseAnnotationRequest(JSON.stringify(input))
  const abort = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let reject!: (reason: Error) => void
  const interruption = new Promise<never>((_resolve, no) => { reject = no })
  const cancel = (error: Error) => { reject(error); abort.abort(); void reader?.cancel().catch(() => {}) }
  const onAbort = () => cancel(annotationCancelled())
  parent.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => cancel(new AnnotationFailure('timeout')), ANNOTATION_TIMEOUT_MS)
  const work = async () => {
    if (parent.aborted) throw annotationCancelled()
    const response = await transport(new URL(endpoint, origin), { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: abort.signal })
    if (abort.signal.aborted) { void response.body?.cancel().catch(() => {}); throw annotationCancelled() }
    if (!response.body || (response.headers.has('Content-Length') && Number(response.headers.get('Content-Length')) > MAX_ANNOTATION_BYTES)) {
      void response.body?.cancel().catch(() => {}); throw new AnnotationFailure('protocol')
    }
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []; let bytes = 0
    while (true) {
      const part = await reader.read()
      if (abort.signal.aborted) throw annotationCancelled()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_ANNOTATION_BYTES) throw new AnnotationFailure('protocol')
      chunks.push(part.value)
    }
    const buffer = new Uint8Array(bytes); let offset = 0
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength }
    let body: string
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { throw new AnnotationFailure('protocol') }
    if (!response.ok) throw new AnnotationFailure(annotationError(body, response.status))
    try { return parseAnnotationResponse(body, request) } catch { throw new AnnotationFailure('protocol') }
  }
  try { return await Promise.race([work(), interruption]) }
  catch (error) {
    if (parent.aborted) throw annotationCancelled()
    if (error instanceof AnnotationFailure) throw error
    throw new AnnotationFailure('upstream')
  } finally {
    clearTimeout(timer); parent.removeEventListener('abort', onAbort)
    abort.abort(); void reader?.cancel().catch(() => {})
  }
}
