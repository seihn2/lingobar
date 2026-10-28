import type { Caption, Settings } from './types'
import { isTargetLanguage } from './languages'

export type Phrase = { start: number; end: number; exact: string }
export type LearningSession = { id: string; name: string; startedAt: number; endedAt?: number }
export type LearningRecord = { captionId: string; fingerprint: string; sessionId: string | null; savedAt: number; phrases: Phrase[]; note: string }
export type LearningState = { sessions: LearningSession[]; records: LearningRecord[]; currentSessionId: string | null; warning: string; shortcutAvailable: boolean; unanchoredIds?: string[] }
export type LearningTarget = { id: string; version: string; sourceVersion?: string }
export type LearningResult = { kind: 'saved' | 'already' | 'incomplete' | 'changed' | 'unavailable' | 'partial'; message: string }
export type LearningEdit = { target: LearningTarget; phrases: Phrase[]; note: string }
export interface DesktopLearningAPI {
  pin(target: LearningTarget | null): Promise<LearningResult>
  save(edit: LearningEdit): Promise<LearningResult>
  session(name: string | null): Promise<void>
  removeNotes(id: string): Promise<void>
  onQuickPin(callback: () => void): () => void
}
export function learningOriginal(caption: Caption): string {
  const translated = Boolean(caption.zh || caption.en || caption.ja || Object.values(caption.translations || {}).some(Boolean))
  return translated && caption.translatedOriginal ? caption.translatedOriginal : caption.original
}
export const learningSourceVersion = (caption: Caption) => JSON.stringify([caption.source, caption.language, caption.original, learningOriginal(caption)])
/** Exact display revision; saved flags are deliberately excluded for idempotent pinning. */
export function learningTarget(caption: Caption, settings: Pick<Settings, 'targetLanguages' | 'showFurigana'>): LearningTarget {
  return { id: caption.id, sourceVersion: learningSourceVersion(caption), version: JSON.stringify([caption.original, learningOriginal(caption), caption.language, caption.source,
    caption.status, Boolean(caption.live), Boolean(caption.translationPending), settings.targetLanguages,
    settings.targetLanguages.map(code => caption.translations?.[code] || (code === 'zh' || code === 'en' || code === 'ja' ? caption[code] : '')),
    settings.showFurigana ? caption.jaSegments : null, settings.showFurigana ? caption.furiganaStatus : null]) }
}
export function saveEligible(caption: Caption): boolean {
  return caption.id.length > 0 && caption.id.length <= 200 && caption.language.length > 0 && caption.language.length <= 80 && caption.original.length <= 8000 && caption.status === 'ready' && !caption.live && !caption.translationPending && learningOriginal(caption) === caption.original && Boolean(caption.original.trim()) &&
    Object.entries({ zh: caption.zh, en: caption.en, ja: caption.ja, ...caption.translations }).some(([code, text]) => isTargetLanguage(code) && typeof text === 'string' && text.trim().length > 0)
}
export function validTarget(value: unknown): value is LearningTarget {
  return !!value && typeof value === 'object' && typeof (value as LearningTarget).id === 'string' && (value as LearningTarget).id.length > 0 && (value as LearningTarget).id.length <= 200 && typeof (value as LearningTarget).version === 'string' && (value as LearningTarget).version.length <= 180000 && ((value as LearningTarget).sourceVersion === undefined || (typeof (value as LearningTarget).sourceVersion === 'string' && (value as LearningTarget).sourceVersion!.length <= 100000))
}
export function graphemeBoundaries(source: string): Set<number> {
  // Fail closed on runtimes lacking Segmenter; never split a surrogate/ZWJ/combining sequence.
  const boundaries = new Set<number>([source.length])
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source)) boundaries.add(part.index)
  return boundaries
}
export function validPhrase(source: string, value: unknown): value is Phrase {
  if (!value || typeof value !== 'object') return false
  const { start, end, exact } = value as Phrase
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > source.length || typeof exact !== 'string' || exact.length > 1000 || source.slice(start, end) !== exact) return false
  const boundaries = graphemeBoundaries(source)
  return boundaries.has(start) && boundaries.has(end)
}
