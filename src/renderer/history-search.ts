import type { Caption } from '../shared/types'
import { isTargetLanguage, type TargetLanguage } from '../shared/languages'

export type HistoryMatch = { text: string; language: TargetLanguage | 'original' }
export type HistoryResult = { caption: Caption; match?: HistoryMatch }

/** Literal, Unicode-normalized local lookup. Never reinterpret speech as markup or a regex. */
const normalized = (value: string) => value.normalize('NFKC').toLowerCase()

export function searchHistory(captions: Caption[], query: string, savedOnly: boolean): HistoryResult[] {
  const needle = normalized(query.trim())
  const results: HistoryResult[] = []
  for (const caption of captions.slice().reverse()) {
    if (savedOnly && !caption.saved) continue
    if (!needle) { results.push({ caption }); continue }
    const fields: HistoryMatch[] = [{ text: caption.original, language: 'original' }]
    if (caption.translatedOriginal && caption.translatedOriginal !== caption.original) {
      fields.push({ text: caption.translatedOriginal, language: 'original' })
    }
    // Keep previously generated languages searchable even after the visible selection changes.
    for (const [code, text] of Object.entries({ zh: caption.zh, en: caption.en, ja: caption.ja, ...caption.translations })) {
      if (isTargetLanguage(code) && text) fields.push({ text, language: code })
    }
    const match = fields.find(field => normalized(field.text).includes(needle))
    if (match) results.push({ caption, match })
  }
  return results
}

/** New arrivals and late translations keep the reader on the same segment, not the same index. */
export function historySelection(results: HistoryResult[], id: string | null): string | null {
  return results.some(result => result.caption.id === id) ? id : results[0]?.caption.id || null
}

export function nextHistorySelection(results: HistoryResult[], id: string | null, direction: 1 | -1): string | null {
  if (!results.length) return null
  const index = results.findIndex(result => result.caption.id === id)
  return results[(Math.max(0, index) + direction + results.length) % results.length].caption.id
}
