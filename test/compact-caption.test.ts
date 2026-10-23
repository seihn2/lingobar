import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Caption, Settings } from '../src/shared/types'
import CompactCaption from '../src/renderer/CompactCaption'
import { alignedOriginal, compactRows, incomingText, survivingCaptionId, untranslatedErrorSource } from '../src/renderer/caption-text'
import { advanceReading, emptyReadingClock } from '../src/renderer/reading-schedule'

const caption = (id: string, status: Caption['status'] = 'ready'): Caption => ({
  id, source: 'system', original: `Original ${id}`, language: 'English',
  zh: `中文 ${id}`, en: `English ${id}`, ja: '天気', reading: 'てんき',
  translations: { fr: `Français ${id}`, ja: '天気', zh: `中文 ${id}` },
  jaSegments: [{ text: '天気', reading: 'てんき' }], createdAt: 0, saved: false, status,
})

describe('compact multilingual captions', () => {
  it('always pairs the original with exactly the selected languages in their configured order', () => {
    const rows = compactRows(caption('one'), ['fr', 'ja'])
    expect(rows.map(row => row.code)).toEqual(['original', 'fr', 'ja'])
    expect(rows.map(row => row.text)).toEqual(['Original one', 'Français one', '天気'])
    expect(compactRows(undefined, ['ko']).map(row => row.code)).toEqual(['original', 'ko'])
  })

  it('keeps rows matched while awaiting a new prefix, then displays it immediately', () => {
    const previous = caption('previous')
    const pending = caption('next', 'translating')
    const options = { targets: ['fr', 'ja'] as Settings['targetLanguages'], showFurigana: true }
    const first = advanceReading([previous], emptyReadingClock(), options, 0)
    const held = advanceReading([previous, { ...pending, zh: '', en: '', ja: '', translations: {} }], first.clock, options, 200)
    expect(held.clock.id).toBe('previous')
    const displayed = [previous, pending].find(item => item.id === held.clock.id)
    expect(compactRows(displayed, options.targets).map(row => row.text)).toEqual(['Original previous', 'Français previous', '天気'])
    const finished = advanceReading([previous, caption('next')], held.clock, options, 300)
    expect(finished.clock.id).toBe('next')
    expect(finished.wakeAt).toBeNull()
  })

  it('renders source and selected rows in compact mode even when expanded original is hidden, with actual ruby', () => {
    const settings = { targetLanguages: ['fr', 'ja'], showOriginal: false, showFurigana: true } as Settings
    const markup = renderToStaticMarkup(createElement(CompactCaption, {
      captions: [caption('one')], settings, preview: false,
      readingSession: { clock: null, following: true, anchor: null }, partial: [], listening: false, notice: '', onRetry() {},
    }))
    expect(markup).toContain('data-language="original"')
    expect(markup).toContain('Original one')
    expect(markup.indexOf('data-language="fr"')).toBeLessThan(markup.indexOf('data-language="ja"'))
    expect(markup).not.toContain('data-language="zh"')
    expect(markup).toContain('<ruby>天気<rp>(</rp><rt>てんき</rt>')
    const hiddenRuby = renderToStaticMarkup(createElement(CompactCaption, {
      captions: [caption('one')], settings: { ...settings, showFurigana: false }, preview: false,
      readingSession: { clock: null, following: true, anchor: null }, partial: [], listening: false, notice: '', onRetry() {},
    }))
    expect(hiddenRuby).not.toContain('<ruby>')
    expect(hiddenRuby).toContain('天気')
  })

  it('updates the same multilingual rows against the exact translated source while speech continues', () => {
    const draft: Caption = { ...caption('live'), original: 'Today I am learning Japanese with a friend', translatedOriginal: 'Today I am learning Japanese', live: true, translationPending: true }
    expect(compactRows(draft, ['fr', 'ja'])[0].text).toBe('Today I am learning Japanese')
    expect(alignedOriginal(draft)).not.toBe(draft.original)
    expect(incomingText(draft.original, draft)).toBe('with a friend')
    const updated = { ...draft, translatedOriginal: draft.original, translations: { fr: 'Nouvelle traduction', ja: '新しい訳文' }, ja: '新しい訳文', jaSegments: undefined }
    expect(updated.id).toBe(draft.id)
    expect(compactRows(updated, ['fr', 'ja']).map(row => row.text)).toEqual([draft.original, 'Nouvelle traduction', '新しい訳文'])
    expect(incomingText(updated.original, updated)).toBe('')
  })

  it('never trims unrelated utterances or ASR corrections using an old translated prefix', () => {
    const draft: Caption = { ...caption('live'), original: 'She is learning Japanese', translatedOriginal: 'He is learning', live: true }
    expect(incomingText(draft.original, draft)).toBe(draft.original)
    expect(incomingText('He is learning Spanish', draft)).toBe('He is learning Spanish')
    expect(incomingText('He is learning', { ...draft, original: 'He is learning', live: false })).toBe('He is learning')
    const initial = { ...draft, zh: '', en: '', ja: '', translations: {}, translatedOriginal: undefined }
    expect(alignedOriginal(initial)).toBe(initial.original)
    expect(incomingText(initial.original, initial)).toBe('')
  })

  it('keeps the original row aligned and renders only untranslated incoming text in the compact view', () => {
    const draft: Caption = { ...caption('live'), original: 'Today I learn Japanese with a friend', translatedOriginal: 'Today I learn Japanese', live: true, translationPending: true }
    const markup = renderToStaticMarkup(createElement(CompactCaption, {
      captions: [draft], settings: { targetLanguages: ['fr', 'ja'], showOriginal: false, showFurigana: true } as Settings, preview: false,
      readingSession: { clock: null, following: true, anchor: null }, partial: [{ source: 'system', text: draft.original }], listening: true, notice: '', onRetry() {},
    }))
    expect(markup).toContain('data-caption-id="live"')
    expect(markup).toContain('Today I learn Japanese</p>')
    expect(markup).toContain('with a friend')
    expect(markup).not.toContain(draft.original)
    expect(markup).not.toContain('重新翻译这段')
  })

  it('moves back from a retracted speculative live chunk while preserving ordinary history positions', () => {
    const previous = [caption('history'), { ...caption('first'), live: true }, { ...caption('retracted'), live: true }]
    expect(survivingCaptionId(previous, previous.slice(0, 2), 'retracted')).toBe('first')
    expect(survivingCaptionId(previous, [previous[0]], 'retracted')).toBe('history')
    expect(survivingCaptionId(previous, previous.slice(1), 'history')).toBe('history')
    expect(survivingCaptionId([previous[2]], [], 'retracted')).toBeNull()
  })

  it('preserves the untranslated remainder or corrected source separately when a final update fails', () => {
    const failed: Caption = { ...caption('failed', 'error'), original: 'Today I learn Japanese with a friend', translatedOriginal: 'Today I learn Japanese', live: false, translationPending: false }
    expect(alignedOriginal(failed)).toBe('Today I learn Japanese')
    expect(untranslatedErrorSource(failed)).toEqual({ label: '未译原文', text: 'with a friend' })
    expect(untranslatedErrorSource({ ...failed, original: 'Today I teach Japanese' })).toEqual({ label: '修正原文', text: 'Today I teach Japanese' })
    expect(untranslatedErrorSource({ ...failed, status: 'ready' })).toBeNull()
    const markup = renderToStaticMarkup(createElement(CompactCaption, {
      captions: [failed], settings: { targetLanguages: ['fr', 'ja'], showFurigana: false } as Settings, preview: false,
      readingSession: { clock: null, following: true, anchor: null }, partial: [], listening: false, notice: '', onRetry() {},
    }))
    expect(markup).toContain('Today I learn Japanese</p>')
    expect(markup).toContain('未译原文：with a friend')
    expect(markup).toContain('重新翻译这段')
  })
})
