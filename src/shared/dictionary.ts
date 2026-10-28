import type { Caption } from './types'
import type { TargetLanguage } from './languages'
import type { Phrase } from './learning'
import { learningOriginal } from './learning'
import type { DictionaryModelV1 } from './dictionary-model'
export type { DictionaryModelV1 } from './dictionary-model'

export const DICTIONARY_LIMITS = { encounters: 5000, explanations: 20, attempts: 50, note: 4000, bytes: 32 * 1024 * 1024, reservationBytes: 128 * 1024, reviews: 50000, reviewsPerEncounter: 500 } as const
export type DictionarySnapshot = {
  text: string; language: string; sourceType: Caption['source']; provenance: 'main-verified' | 'saved-favorite' | 'user-input'
  captionId: string | null; displayedVersion: string | null; sourceVersion: string | null
}
export type DictionarySource = DictionarySnapshot & { span: Phrase }
/** Compare aligned source only: late translation/ruby and an untranslated tail must not invalidate a legitimate source snapshot. */
export const dictionarySourceVersion = (caption: Caption) => JSON.stringify([caption.source, caption.language, learningOriginal(caption)])
export type DictionaryUsage = { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }
export type DictionaryExplanation = {
  schemaVersion: 1; encounterId: string; explanationId: string; version: number
  providerKind: 'llm-generated'; providerLabel: string; model: string; promptVersion: string
  createdAt: number; requestedExplanationLanguage: TargetLanguage; finishReason: 'stop'; usage: DictionaryUsage | null
  readingScope: 'requested-surface-unverified'; content: DictionaryModelV1; validationWarnings: Array<'example_duplicates_source'>
}
export type AttemptStatus = 'persisting' | 'waiting' | 'ready' | 'ambiguous' | 'model_declined' | 'schema_error' | 'service_error' | 'cancelled' | 'interrupted'
export type DictionaryAttempt = { id: string; createdAt: number; updatedAt: number; dispatchState: 'not_started' | 'may_have_started'; status: AttemptStatus; explanationId: string | null }
export type DictionaryEncounter = { id: string; createdAt: number; source: DictionarySource; favorite: boolean; note: string; explanations: DictionaryExplanation[]; attempts: DictionaryAttempt[] }
export type DictionaryReviewEvent = { id: string; sessionId: string; encounterId: string; explanationId: string; createdAt: number; response: 'recalled' | 'not_recalled' }
export type DictionaryDocument = { schemaVersion: 1; encounters: DictionaryEncounter[]; reviews: DictionaryReviewEvent[] }
export type DictionaryQuery = { query?: string; language?: string; provenance?: DictionarySnapshot['provenance']; favorite?: boolean; incomplete?: boolean; page?: number; pageSize?: number }
export type DictionaryPage = { items: DictionaryEncounter[]; total: number; page: number; pageSize: number; revision: number; warning: string }
export type DictionaryAvailability = { configured: boolean; providerLabel: string; model: string; offlineDictionaryAvailable: false }
export type DictionaryHandleResult = { handle: string | null; reason: string; source: DictionarySnapshot | null }
export type DictionaryOpen = { captionId: string; displayedText: string; sourceVersion: string; displayedVersion: string }
export type DictionaryRunState = { encounterId: string; attemptId: string; state: 'waiting' | 'ready' | 'ambiguous' | 'model_declined' | 'schema_error' | 'service_error' | 'cancelled' | 'interrupted' | 'ready_unsaved' | 'persist_error'; dispatchState: 'not_started' | 'may_have_started'; message: string; unsaved?: DictionaryExplanation }
export type DictionaryDetail = { encounter: DictionaryEncounter; run: DictionaryRunState | null }
export type DictionaryExplainInput = { handle: string; span: Phrase; language: TargetLanguage; encounterId?: string }
export type DictionaryReviewCard = { encounterId: string; explanationId: string; source: DictionarySource }
export type DictionaryReviewSession = { sessionId: string; cards: DictionaryReviewCard[]; cursor: number; completed: number; lastEventId: string | null }
export interface DictionaryAPI {
  availability(): Promise<DictionaryAvailability>
  open(input: DictionaryOpen): Promise<DictionaryHandleResult>
  openEncounter(id: string): Promise<DictionaryHandleResult>
  release(handle: string): Promise<void>
  explain(input: DictionaryExplainInput): Promise<DictionaryRunState>
  cancel(encounterId: string, attemptId: string): Promise<DictionaryRunState>
  retrySave(encounterId: string, attemptId: string): Promise<DictionaryRunState>
  discardUnsaved(encounterId: string, attemptId: string): Promise<void>
  list(query: DictionaryQuery): Promise<DictionaryPage>
  get(id: string): Promise<DictionaryDetail | null>
  edit(id: string, input: { favorite?: boolean; note?: string }): Promise<void>
  remove(id: string): Promise<void>
  export(format: 'json' | 'markdown'): Promise<{ saved: boolean; message: string }>
  reviewState(sessionId: string): Promise<DictionaryReviewSession>
  endReview(sessionId: string): Promise<void>
  startReview(): Promise<DictionaryReviewSession>
  reveal(sessionId: string, encounterId: string, explanationId: string): Promise<{ revealId: string; explanation: DictionaryExplanation }>
  rate(sessionId: string, revealId: string, response: 'recalled' | 'not_recalled'): Promise<DictionaryReviewSession>
  skip(sessionId: string): Promise<DictionaryReviewSession>
  undo(sessionId: string, eventId: string): Promise<DictionaryReviewSession>
  onChanged(callback: () => void): () => void
}
