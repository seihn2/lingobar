import { describe, expect, it } from 'vitest'
import type { Caption } from '../src/shared/types'
import { historySelection, nextHistorySelection, searchHistory } from '../src/renderer/history-search'

const caption = (id: string, extra: Partial<Caption> = {}): Caption => ({
  id, source: 'text', original: 'Synthetic original', language: 'English', zh: '', en: '', ja: '', reading: '',
  createdAt: 0, status: 'ready', saved: false, ...extra,
})

describe('local history lookup', () => {
  it('finds CJK, canonically equivalent accents, full-width letters, and whole emoji sequences', () => {
    const records = [caption('unicode', { original: '東京 Cafe\u0301 ＡＢＣ 👩🏽‍💻' })]
    for (const query of ['東京', 'CAFÉ', 'abc', '👩🏽‍💻']) expect(searchHistory(records, query, false).map(result => result.caption.id)).toEqual(['unicode'])
  })

  it('searches existing languages outside the current visible selection and legacy translations', () => {
    const records = [caption('legacy', { ja: '合成例' }), caption('other-language', { translations: { de: 'Ein synthetisches Beispiel' } })]
    expect(searchHistory(records, 'Beispiel', false)[0].match).toEqual({ text: 'Ein synthetisches Beispiel', language: 'de' })
    expect(searchHistory(records, '合成', false)[0].caption.id).toBe('legacy')
  })

  it('finds both revised recognition and its last translated source without inventing cross-field matches', () => {
    const record = caption('partial', { original: 'Corrected source', translatedOriginal: 'Older source', translations: { fr: 'Exemple' } })
    expect(searchHistory([record], 'corrected', false)).toHaveLength(1)
    expect(searchHistory([record], 'older', false)).toHaveLength(1)
    expect(searchHistory([record], 'source exemple', false)).toHaveLength(0)
  })

  it('treats HTML and regex characters as literal text and never changes saved data or order', () => {
    const records = [caption('old', { original: '<img src=x> a+b [.*]', saved: true }), caption('new', { original: 'plain' })]
    const before = structuredClone(records)
    expect(searchHistory(records, '[.*]', false)[0].caption.id).toBe('old')
    expect(searchHistory(records, 'img', false)[0].match?.text).toBe('<img src=x> a+b [.*]')
    expect(searchHistory(records, ' ', false).map(result => result.caption.id)).toEqual(['new', 'old'])
    expect(searchHistory(records, '', true).map(result => result.caption.id)).toEqual(['old'])
    expect(records).toEqual(before)
  })

  it('keeps selection by segment ID across 100 arrivals and a late translated match', () => {
    const old = caption('selected', { original: 'needle' })
    const arrivals = Array.from({ length: 100 }, (_, index) => caption(`new-${index}`, { translations: { fr: 'needle' } }))
    const results = searchHistory([old, ...arrivals], 'needle', false)
    expect(historySelection(results, old.id)).toBe(old.id)
    expect(nextHistorySelection(results, old.id, 1)).toBe('new-99')
    expect(nextHistorySelection(results, 'new-99', -1)).toBe(old.id)
  })

  it('handles a removed selected segment, cleared history, and no matches', () => {
    const results = searchHistory([caption('survivor')], '', false)
    expect(historySelection(results, 'removed')).toBe('survivor')
    expect(historySelection([], 'removed')).toBeNull()
    expect(nextHistorySelection([], 'removed', 1)).toBeNull()
    expect(searchHistory([caption('one')], 'absent', false)).toEqual([])
  })
})
