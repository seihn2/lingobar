import type { Caption } from './types'
import { isTargetLanguage, validTargetLanguages, type TargetLanguage } from './languages'

export const MAX_WEB_MESSAGE_BYTES = 128 * 1024
export const MAX_WEB_CAPTIONS = 500

export interface WebSessionSettings {
  targetLanguages: TargetLanguage[]
  showOriginal: boolean
  showFurigana: boolean
}
export type WebErrorCode = 'unauthorized' | 'quota' | 'upstream' | 'protocol' | 'unavailable'
export type WebClientMessage =
  | { version: 1; type: 'start'; sessionId: string; settings: WebSessionSettings }
  | { version: 1; type: 'stop'; sessionId: string }
  | { version: 1; type: 'retry'; sessionId: string; id: string }
export type WebServerMessage =
  | { version: 1; type: 'ready'; sessionId: string }
  | { version: 1; type: 'caption'; sessionId: string; revision: number; caption: Caption }
  | { version: 1; type: 'retract'; sessionId: string; id: string }
  | { version: 1; type: 'error'; sessionId: string; code: WebErrorCode }

const MAX_TEXT_UNITS = 8000
const LEGACY_LANGUAGES = ['zh', 'en', 'ja'] as const
const ERROR_CODES: readonly WebErrorCode[] = ['unauthorized', 'quota', 'upstream', 'protocol', 'unavailable']
function invalid(): never { throw new Error('Invalid web session message') }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function text(value: unknown, maximum = MAX_TEXT_UNITS): string {
  // Text is data, including HTML-like text. Reject broken Unicode and control
  // characters; preserve ordinary spacing/newlines without HTML interpretation.
  if (typeof value !== 'string' || value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value)) invalid()
  return value
}
function identifier(value: unknown): string {
  const result = text(value, 128)
  if (!result.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) invalid()
  return result
}

function japaneseSegments(value: unknown, japanese: string): NonNullable<Caption['jaSegments']> {
  if (!japanese || !Array.isArray(value) || value.length < 1 || value.length > 1000) invalid()
  const result: NonNullable<Caption['jaSegments']> = []
  let combined = ''
  for (const item of value) {
    if (!record(item)) invalid()
    const part = text(item.text)
    if (!part.length) invalid()
    if (Object.hasOwn(item, 'reading')) {
      const reading = text(item.reading)
      if (!/^[\p{Script=Han}\p{Decimal_Number}\u3005\u3006\u3007\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+$/u.test(part) ||
        !/[\p{Script=Han}\u3006]/u.test(part) ||
        !/^[\p{Script=Hiragana}\p{Script=Katakana}\u3099\u309aー・ \u3000]+$/u.test(reading) ||
        !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(reading)) invalid()
      result.push({ text: part, reading })
    } else result.push({ text: part })
    combined += part
    if (combined.length > MAX_TEXT_UNITS) invalid()
  }
  if (combined !== japanese) invalid()
  return result
}

function caption(value: unknown): Caption {
  if (!record(value)) invalid()
  const id = identifier(value.id)
  if (value.source !== 'microphone' && value.source !== 'text') invalid()
  const original = text(value.original)
  const language = text(value.language, 80)
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0) invalid()
  if (value.status !== 'ready' && value.status !== 'translating' && value.status !== 'error') invalid()
  const translations: Partial<Record<TargetLanguage, string>> = {}
  if (Object.hasOwn(value, 'translations')) {
    if (!record(value.translations)) invalid()
    const entries = Object.entries(value.translations)
    if (entries.length > 8) invalid()
    for (const [code, translated] of entries) {
      if (!isTargetLanguage(code)) invalid()
      translations[code] = text(translated)
    }
  }
  for (const code of LEGACY_LANGUAGES) {
    if (!Object.hasOwn(value, code)) continue
    const legacy = text(value[code])
    if (!Object.hasOwn(translations, code) && legacy) translations[code] = legacy
  }
  if (Object.keys(translations).length > 8) invalid()
  const result: Caption = {
    id, source: value.source, original, language, createdAt: value.createdAt, status: value.status,
    translations, zh: translations.zh ?? '', en: translations.en ?? '', ja: translations.ja ?? '',
    reading: Object.hasOwn(value, 'reading') ? text(value.reading) : '', saved: false
  }
  if (Object.hasOwn(value, 'targetLanguages')) {
    if (!validTargetLanguages(value.targetLanguages)) invalid()
    result.targetLanguages = [...value.targetLanguages]
  }
  for (const field of ['live', 'translationPending'] as const) {
    if (!Object.hasOwn(value, field)) continue
    if (typeof value[field] !== 'boolean') invalid()
    result[field] = value[field]
  }
  if (Object.hasOwn(value, 'translatedOriginal')) result.translatedOriginal = text(value.translatedOriginal)
  if (Object.hasOwn(value, 'furiganaStatus')) {
    if (value.furiganaStatus !== 'pending' && value.furiganaStatus !== 'ready' && value.furiganaStatus !== 'error') invalid()
    result.furiganaStatus = value.furiganaStatus
  }
  if (Object.hasOwn(value, 'jaSegments')) result.jaSegments = japaneseSegments(value.jaSegments, result.ja)
  // saved belongs to this browser. Free-form upstream errors, settings, keys
  // and all other non-protocol fields never enter the returned caption.
  return result
}

/** Parse a bounded WebSocket text frame; binary PCM uses a separate channel. */
export function parseServerMessage(data: unknown): WebServerMessage {
  if (typeof data !== 'string' || data.length > MAX_WEB_MESSAGE_BYTES || new TextEncoder().encode(data).byteLength > MAX_WEB_MESSAGE_BYTES) invalid()
  let value: unknown
  try { value = JSON.parse(data) } catch { return invalid() }
  if (!record(value) || value.version !== 1) invalid()
  const sessionId = identifier(value.sessionId)
  if (value.type === 'ready') return { version: 1, type: 'ready', sessionId }
  if (value.type === 'retract') return { version: 1, type: 'retract', sessionId, id: identifier(value.id) }
  if (value.type === 'error') {
    if (typeof value.code !== 'string' || !ERROR_CODES.includes(value.code as WebErrorCode)) invalid()
    return { version: 1, type: 'error', sessionId, code: value.code as WebErrorCode }
  }
  if (value.type === 'caption') {
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) invalid()
    return { version: 1, type: 'caption', sessionId, revision: value.revision as number, caption: caption(value.caption) }
  }
  return invalid()
}

/** Strict client controls: endpoints, models, provider keys and arbitrary proxy options are never accepted. */
export function parseClientMessage(data: unknown): WebClientMessage {
  if (typeof data !== 'string' || data.length > MAX_WEB_MESSAGE_BYTES || new TextEncoder().encode(data).byteLength > MAX_WEB_MESSAGE_BYTES) invalid()
  let value: unknown
  try { value = JSON.parse(data) } catch { return invalid() }
  if (!record(value) || value.version !== 1) invalid()
  const sessionId = identifier(value.sessionId)
  const fields = value.type === 'start' ? ['version', 'type', 'sessionId', 'settings'] : value.type === 'retry' ? ['version', 'type', 'sessionId', 'id'] : ['version', 'type', 'sessionId']
  if (Object.keys(value).some(key => !fields.includes(key))) invalid()
  if (value.type === 'stop') return { version: 1, type: 'stop', sessionId }
  if (value.type === 'retry') return { version: 1, type: 'retry', sessionId, id: identifier(value.id) }
  if (value.type !== 'start' || !record(value.settings)) invalid()
  const settings = value.settings
  if (Object.keys(settings).some(key => !['targetLanguages', 'showOriginal', 'showFurigana'].includes(key)) ||
    !validTargetLanguages(settings.targetLanguages) || typeof settings.showOriginal !== 'boolean' || typeof settings.showFurigana !== 'boolean') invalid()
  return { version: 1, type: 'start', sessionId, settings: { targetLanguages: [...settings.targetLanguages], showOriginal: settings.showOriginal, showFurigana: settings.showFurigana } }
}
