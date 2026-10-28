import { describe, expect, it, vi } from 'vitest'
import { dictionaryJson, dictionaryMarkdown } from '../src/main/dictionary-export'
import type { DictionaryDocument, DictionaryEncounter, DictionaryExplanation } from '../src/shared/dictionary'

const explanation = (id = 'explanation-1', version = 1): DictionaryExplanation => ({
  schemaVersion: 1, encounterId: 'encounter-1', explanationId: id, version, providerKind: 'llm-generated', providerLabel: 'Synthetic service', model: 'synthetic-model', promptVersion: 'dictionary-v1', createdAt: 12,
  requestedExplanationLanguage: 'zh', finishReason: 'stop', usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 }, readingScope: 'requested-surface-unverified',
  content: { schemaVersion: 1, status: 'ok', reasonCode: null, targetText: 'pick it up', headword: 'pick up', reading: { text: 'pɪk ɪt ʌp', notation: 'ipa' }, partOfSpeech: '动词短语', contextMeaning: '把它拿起来', usageNote: '保留代词位置', examples: [{ text: 'Please pick it up.', translation: '请把它拿起来。' }] }, validationWarnings: [],
})
const encounter = (): DictionaryEncounter => ({
  id: 'encounter-1', createdAt: 10, favorite: true, note: 'Synthetic personal note',
  source: { text: 'You should pick it up now.', language: 'English', sourceType: 'text', provenance: 'user-input', captionId: null, displayedVersion: null, sourceVersion: null, span: { start: 11, end: 21, exact: 'pick it up' } },
  explanations: [explanation()], attempts: [{ id: 'attempt-1', createdAt: 10, updatedAt: 12, dispatchState: 'may_have_started', status: 'ready', explanationId: 'explanation-1' }],
})
const document = (): DictionaryDocument => ({ schemaVersion: 1, encounters: [encounter()], reviews: [{ id: 'review-1', sessionId: 'session-1', encounterId: 'encounter-1', explanationId: 'explanation-1', createdAt: 20, response: 'recalled' }] })

describe('committed structured dictionary exports without requests or writes', () => {
  it('exports an independent source/span and complete application envelope for each version', () => {
    const doc = document(); doc.encounters[0].explanations.push(explanation('explanation-2', 2))
    const result = JSON.parse(dictionaryJson(doc))
    expect(result).toMatchObject({ schemaVersion: 1, kind: 'lingobar-dictionary-learning-export' })
    expect(result.disclaimer).toContain('AI生成')
    expect(result.readingNotice).toContain('表面形式'); expect(result.readingNotice).toContain('原形')
    expect(result.usageNotice).toContain('不代表账单')
    expect(result.entries).toHaveLength(2)
    for (const entry of result.entries) {
      expect(entry.source).toEqual(doc.encounters[0].source)
      expect(entry.source.span.exact).toBe('pick it up')
      expect(entry.explanation.readingScope).toBe('requested-surface-unverified')
      expect(entry.explanation.content).toEqual(doc.encounters[0].explanations[0].content)
    }
    expect(result.entries[1].explanation.version).toBe(2)
    expect(result.reviewEvents).toEqual(doc.reviews)
  })

  it('does not suppress a valid old version while a newer attempt waits and never emits intent-only entries', () => {
    const doc = document()
    doc.encounters[0].attempts.push({ id: 'pending-2', createdAt: 30, updatedAt: 30, dispatchState: 'may_have_started', status: 'waiting', explanationId: null })
    doc.encounters.push({ ...encounter(), id: 'failed-only', explanations: [], favorite: false, note: '' })
    const result = JSON.parse(dictionaryJson(doc))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].explanation.explanationId).toBe('explanation-1')
    expect(dictionaryMarkdown(doc)).toContain('把它拿起来')
    expect(dictionaryJson(doc)).not.toContain('pending-2')
    expect(dictionaryJson(doc)).not.toContain('failed-only')
  })

  it('keeps favorite-only, note-only and pending favorite encounters separate from generated entries', () => {
    const doc = document()
    doc.encounters = [
      { ...encounter(), id: 'favorite-only', explanations: [], favorite: true, note: '' },
      { ...encounter(), id: 'note-only', explanations: [], favorite: false, note: 'Saved synthetic note' },
      { ...encounter(), id: 'pending-favorite', explanations: [], favorite: true, note: '', attempts: [{ id: 'pending', createdAt: 10, updatedAt: 10, dispatchState: 'may_have_started', status: 'waiting', explanationId: null }] },
      { ...encounter(), id: 'failed-intent-only', explanations: [], favorite: false, note: '' },
      { ...encounter(), id: 'blank-note-only', explanations: [], favorite: false, note: '  ' },
    ]
    const result = JSON.parse(dictionaryJson(doc))
    expect(result.entries).toEqual([])
    expect(result.unexplainedEncounters.map((item: { encounterId: string }) => item.encounterId)).toEqual(['favorite-only', 'note-only', 'pending-favorite'])
    for (const entry of result.unexplainedEncounters) {
      expect(entry.source).toEqual(doc.encounters[0].source)
      expect(entry.explanationAvailable).toBe(false)
      expect(entry).not.toHaveProperty('explanation')
      expect(entry).not.toHaveProperty('content')
    }
    expect(result.reviewEvents).toEqual([])
    const markdown = dictionaryMarkdown(doc)
    expect(markdown).toContain('尚无已保存解释的收藏与笔记')
    expect(markdown).toContain('Saved synthetic note')
    expect(markdown).not.toContain('failed-intent-only')
    expect(markdown).not.toContain('### AI 语境解释')
    expect(markdown).not.toContain('把它拿起来')
  })

  it('safely projects unexplained notes and never fabricates an answer while a request is pending', () => {
    const doc = document(), item = doc.encounters[0]
    item.explanations = []; item.note = '<img src="https://evil.invalid/">\n![remote](https://evil.invalid/)'
    Object.assign(item, { apiKey: 'NO-EXPORT' }); Object.assign(item.source, { endpoint: 'https://private.invalid' })
    const result = JSON.parse(dictionaryJson(doc))
    expect(result.unexplainedEncounters[0].note).toBe(item.note)
    expect(dictionaryJson(doc)).not.toContain('NO-EXPORT'); expect(dictionaryJson(doc)).not.toContain('private.invalid')
    const markdown = dictionaryMarkdown(doc)
    for (const line of markdown.split('\n').filter(line => line.includes('evil.invalid'))) expect(line.startsWith('    ')).toBe(true)
    expect(markdown).toContain('没有已保存解释')
  })

  it('preserves nullable fields, non-ok reasons and application-only duplicate-example warnings', () => {
    const doc = document()
    const item = doc.encounters[0].explanations[0]
    item.content = { schemaVersion: 1, status: 'ambiguous', reasonCode: 'ambiguous_context', targetText: 'pick it up', headword: null, reading: null, partOfSpeech: null, contextMeaning: null, usageNote: null, examples: null }
    item.usage = null
    item.validationWarnings = ['example_duplicates_source']
    const result = JSON.parse(dictionaryJson(doc)).entries[0].explanation
    expect(result.content).toEqual(item.content)
    expect(result.validationWarnings).toEqual(['example_duplicates_source'])
    expect(result.content).not.toHaveProperty('validationWarnings')
    const markdown = dictionaryMarkdown(doc)
    expect(markdown).toContain('ambiguous_context')
    expect(markdown).toContain('example_duplicates_source')
    expect(markdown).toContain('    未提供')
  })

  it('projects exact allowed fields and drops rogue endpoint, key and unknown nested metadata', () => {
    const doc = document()
    const item = doc.encounters[0]
    Object.assign(doc, { endpoint: 'https://private.invalid/api' })
    Object.assign(item, { apiKey: 'NEVER-EXPORT-SYNTHETIC-KEY' })
    Object.assign(item.source, { endpoint: 'https://private.invalid/source' })
    Object.assign(item.source.span, { rogue: 'PRIVATE-ROGUE' })
    Object.assign(item.explanations[0], { endpoint: 'https://private.invalid/provider', apiKey: 'NEVER-EXPORT-SYNTHETIC-KEY' })
    Object.assign(item.explanations[0].content, { unknown: 'PRIVATE-ROGUE' })
    Object.assign(item.explanations[0].content.reading!, { audioUrl: 'https://private.invalid/audio' })
    Object.assign(item.explanations[0].content.examples![0], { imageUrl: 'https://private.invalid/image' })
    Object.assign(item.explanations[0].usage!, { secret: 'PRIVATE-ROGUE' })
    Object.assign(doc.reviews[0], { private: 'PRIVATE-ROGUE' })
    for (const result of [dictionaryJson(doc), dictionaryMarkdown(doc)]) {
      expect(result).not.toContain('private.invalid')
      expect(result).not.toContain('NEVER-EXPORT-SYNTHETIC-KEY')
      expect(result).not.toContain('PRIVATE-ROGUE')
    }
  })

  it('keeps generated examples/headword/reading and provenance explicitly qualified', () => {
    const doc = document()
    const markdown = dictionaryMarkdown(doc)
    expect(markdown).toContain('AI建议原形（不用于合并遭遇）')
    expect(markdown).toContain('AI读音（对应对象未验证，可能是建议原形）')
    expect(markdown).toContain('AI生成例句（不是原句引文或真实词典例句）')
    expect(markdown).toContain('用户主动输入：不会升级为应用内核对来源。')
    doc.encounters[0].source.provenance = 'saved-favorite'
    expect(dictionaryMarkdown(doc)).toContain('不声称已核实当时屏幕显示或语音内容')
    doc.encounters[0].source.provenance = 'main-verified'
    expect(dictionaryMarkdown(doc)).toContain('不保证ASR识别正确')
  })

  it('escapes every physical line boundary into a code block, including hostile Markdown/HTML/URLs', () => {
    const payload = '<img src="https://evil.invalid/image">\n![remote](https://evil.invalid/image)\r\n[link](https://evil.invalid/)\r```html\n</pre><script>alert(1)</script>\u2028https://evil.invalid/autolink\u2029# injected heading\n    \n```'
    const doc = document(), item = doc.encounters[0]
    item.source.text = payload; item.source.language = payload; item.note = payload
    item.explanations[0].providerLabel = payload
    item.explanations[0].model = payload
    item.explanations[0].content.contextMeaning = payload
    item.explanations[0].content.examples![0].text = payload
    item.explanations[0].content.examples![0].translation = payload
    const markdown = dictionaryMarkdown(doc)
    for (const line of markdown.split('\n').filter(line => /evil\.invalid|<script>|```|injected heading/.test(line))) {
      expect(line.startsWith('    '), line).toBe(true)
    }
    expect(markdown).not.toContain('\r'); expect(markdown).not.toContain('\u2028'); expect(markdown).not.toContain('\u2029')
    // JSON data remains exact; safety formatting only changes Markdown representation.
    expect(JSON.parse(dictionaryJson(doc)).entries[0].source.text).toBe(payload)
  })

  it('removes deleted/orphan review identities from the new snapshot and leaves the input untouched', () => {
    const doc = document(), before = structuredClone(doc)
    doc.reviews.push({ ...doc.reviews[0], id: 'orphan', encounterId: 'deleted', explanationId: 'gone' })
    expect(JSON.parse(dictionaryJson(doc)).reviewEvents).toEqual(before.reviews)
    doc.encounters = []
    const exported = JSON.parse(dictionaryJson(doc))
    expect(exported.entries).toEqual([]); expect(exported.unexplainedEncounters).toEqual([]); expect(exported.reviewEvents).toEqual([])
    expect(dictionaryMarkdown(doc)).not.toContain('pick it up')
    const original = document(); dictionaryJson(original); dictionaryMarkdown(original)
    expect(original).toEqual(before)
  })

  it('performs no fetch or other service action', () => {
    const network = vi.fn(() => { throw new Error('Network is forbidden') })
    vi.stubGlobal('fetch', network)
    try { dictionaryJson(document()); dictionaryMarkdown(document()); expect(network).not.toHaveBeenCalled() }
    finally { vi.unstubAllGlobals() }
  })
})
