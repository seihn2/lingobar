import type { Caption } from './types'
import { validTargetLanguages, type TargetLanguage } from './languages'
import { MAX_WEB_MESSAGE_BYTES, parseServerMessage } from './web-protocol'

export const MAX_TEXT_TRANSLATION_BYTES = 2000
export interface TextTranslationRequest {
  version: 1
  requestId: string
  original: string
  targetLanguages: TargetLanguage[]
  showFurigana: boolean
}
export interface TextTranslationResponse { version: 1; requestId: string; caption: Caption }
function invalid(): never { throw new Error('文字翻译请求或响应格式不正确。') }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Browser submits text and language choices only; provider configuration stays on the server. */
export function parseTextRequest(data: string): TextTranslationRequest {
  if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > 8192) invalid()
  let value: unknown
  try { value = JSON.parse(data) } catch { return invalid() }
  if (!object(value) || Object.keys(value).sort().join(',') !== 'original,requestId,showFurigana,targetLanguages,version' || value.version !== 1 ||
      typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.requestId) ||
      typeof value.original !== 'string' || !value.original.trim() || new TextEncoder().encode(value.original).byteLength > MAX_TEXT_TRANSLATION_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value.original) ||
      !validTargetLanguages(value.targetLanguages) || typeof value.showFurigana !== 'boolean') invalid()
  return { version: 1, requestId: value.requestId, original: value.original,
    targetLanguages: [...value.targetLanguages], showFurigana: value.showFurigana }
}

export function parseTextResponse(data: string, request: TextTranslationRequest): TextTranslationResponse {
  if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > MAX_WEB_MESSAGE_BYTES) invalid()
  let value: unknown
  try { value = JSON.parse(data) } catch { return invalid() }
  if (!object(value) || Object.keys(value).sort().join(',') !== 'caption,requestId,version' || value.version !== 1 || value.requestId !== request.requestId) invalid()
  const parsed = parseServerMessage(JSON.stringify({ version: 1, type: 'caption', sessionId: request.requestId, revision: 1, caption: value.caption }))
  if (parsed.type !== 'caption') return invalid()
  const caption = parsed.caption
  if (caption.source !== 'text' || caption.original !== request.original || caption.status !== 'ready' || caption.live || caption.translationPending ||
      JSON.stringify(caption.targetLanguages) !== JSON.stringify(request.targetLanguages) ||
      Object.keys(caption.translations || {}).length !== request.targetLanguages.length ||
      request.targetLanguages.some(code => !caption.translations?.[code]?.trim())) invalid()
  return { version: 1, requestId: request.requestId, caption }
}
