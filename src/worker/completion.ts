import { translateCaption, type CaptionTranslation, type TranslationConfig } from '../main/translation'
import { annotateJapanese, type JapaneseAnnotation } from '../main/japanese'
import type { TargetLanguage } from '../shared/languages'
import { RelayError, upstreamStatus, type RelayConfig, type WorkerFetch } from './types'

export const TRANSLATION_ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const MAX_COMPLETION_REQUESTS = 40
export interface CompletionService {
  translate(original: string, targets: TargetLanguage[], partial: boolean, signal: AbortSignal): Promise<CaptionTranslation>
  annotate(original: string, japanese: string, signal: AbortSignal): Promise<JapaneseAnnotation>
}

/** A per-connection request budget leaves headroom below the documented free invocation subrequest limit. */
export function createCompletion(config: RelayConfig, transport: WorkerFetch): CompletionService {
  let requests = 0
  async function bounded<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let rejectDeadline!: (reason: RelayError) => void
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
    const cancel = () => { controller.abort(); rejectDeadline(new RelayError('unavailable')) }
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(new RelayError('upstream')) }, 25_000)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) { cancel(); return await deadline }
      return await Promise.race([deadline, work(controller.signal)])
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
  }
  function settings(signal: AbortSignal, targets?: TargetLanguage[], partial = false): { config: TranslationConfig; failure: () => RelayError } {
    let code: 'upstream' | 'unauthorized' | 'quota' = 'upstream'
    const guarded: typeof fetch = async (input, init) => {
      if (signal.aborted) throw new RelayError('unavailable')
      if (String(input) !== TRANSLATION_ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error') throw new RelayError('protocol')
      if (requests >= MAX_COMPLETION_REQUESTS) { code = 'quota'; throw new RelayError('quota') }
      requests++
      const response = await transport(TRANSLATION_ENDPOINT, init)
      if (!response.ok) {
        const status = upstreamStatus(response.status)
        code = status === 'unauthorized' || status === 'quota' ? status : 'upstream'
        void response.body?.cancel().catch(() => {})
      }
      return response
    }
    return { config: { baseUrl: 'https://api.deepseek.com', apiKey: config.translationKey, model: 'deepseek-flash', targetLanguages: targets, generateFurigana: false, partial, fetch: guarded }, failure: () => new RelayError(signal.aborted ? 'unavailable' : code) }
  }
  return {
    async translate(original, targets, partial, signal) {
      return bounded(signal, async child => {
        const job = settings(child, targets, partial)
        try {
          const result = await translateCaption(original, job.config, child)
          if (Object.values(result.translations).some(value => !value || value.length > 8000)) throw new RelayError('upstream')
          return result
        } catch { throw job.failure() }
      })
    },
    async annotate(original, japanese, signal) {
      return bounded(signal, async child => {
        const job = settings(child)
        try { return await annotateJapanese(original, japanese, job.config, child) }
        catch { throw job.failure() }
      })
    }
  }
}
