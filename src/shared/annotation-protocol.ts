import type { Caption } from './types'
import { parseJapaneseSegments } from './web-protocol'

export const MAX_ANNOTATION_BYTES = 65_536
export const ANNOTATION_TIMEOUT_MS = 30_000
const ERRORS = ['busy', 'timeout', 'unauthorized', 'quota', 'upstream', 'protocol', 'unavailable'] as const
export type AnnotationErrorCode = typeof ERRORS[number]
interface Identity {
  version: 1
  type: 'annotation'
  requestId: string
  sessionId: string
  captionId: string
  sourceRevision: number
  language: 'ja'
}
export interface AnnotationRequest extends Identity { original: string; japanese: string }
export interface AnnotationResponse extends Identity { reading: string; jaSegments: NonNullable<Caption['jaSegments']> }
const IDENTITY = ['version', 'type', 'requestId', 'sessionId', 'captionId', 'sourceRevision', 'language']
function invalid(): never { throw new Error('Invalid annotation message') }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function text(value: unknown, max = 8000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) invalid()
  return value
}
function identifier(value: unknown, max = 128): string {
  const id = text(value, max)
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(id)) invalid()
  return id
}
function decode(data: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof data !== 'string' || data.length > MAX_ANNOTATION_BYTES || new TextEncoder().encode(data).byteLength > MAX_ANNOTATION_BYTES) invalid()
  let value: unknown
  try { value = JSON.parse(data) } catch { return invalid() }
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
  return value
}
function identity(value: Record<string, unknown>): Identity {
  if (value.version !== 1 || value.type !== 'annotation' || value.language !== 'ja' || !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1) invalid()
  return { version: 1, type: 'annotation', requestId: identifier(value.requestId), sessionId: identifier(value.sessionId), captionId: identifier(value.captionId, 512), sourceRevision: value.sourceRevision as number, language: 'ja' }
}
export function parseAnnotationRequest(data: unknown): AnnotationRequest {
  const value = decode(data, [...IDENTITY, 'original', 'japanese'])
  return { ...identity(value), original: text(value.original), japanese: text(value.japanese) }
}
export function parseAnnotationResponse(data: unknown, expected: AnnotationRequest): AnnotationResponse {
  const value = decode(data, [...IDENTITY, 'reading', 'jaSegments']), result = identity(value)
  if (IDENTITY.some(key => result[key as keyof Identity] !== expected[key as keyof Identity])) invalid()
  return { ...result, reading: text(value.reading, 8000, true), jaSegments: parseJapaneseSegments(value.jaSegments, expected.japanese) }
}
export function annotationError(data: unknown, status: number): AnnotationErrorCode {
  try {
    const value = decode(data, ['version', 'error'])
    if (value.version === 1 && typeof value.error === 'string' && ERRORS.includes(value.error as AnnotationErrorCode)) return value.error as AnnotationErrorCode
  } catch { /* Never expose a remote error body. */ }
  return status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'quota' : status === 504 ? 'timeout' : status === 503 || status === 404 ? 'unavailable' : 'upstream'
}
/** Text-only eligibility. Raw recognition and a translated prefix must not be mixed. */
export function annotationText(caption: Caption): { original: string; japanese: string } | null {
  if (caption.status !== 'ready' || caption.live || caption.translationPending || !caption.original.trim() || caption.original.length > 8000 ||
    (caption.translatedOriginal !== undefined && caption.translatedOriginal !== caption.original)) return null
  const japanese = caption.translations?.ja || caption.ja
  if (!japanese?.trim() || japanese.length > 8000 || japanese !== caption.ja) return null
  return { original: caption.translatedOriginal || caption.original, japanese }
}
