import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DictionaryLearning } from '../src/main/dictionary-learning'
import { DictionaryStore } from '../src/main/dictionary-store'
import { dictionaryJson, dictionaryMarkdown } from '../src/main/dictionary-export'
import { dictionarySourceVersion, type DictionaryOfflineInput, type GeneratedDictionaryExplanation } from '../src/shared/dictionary'
import type { OfflineHit, OfflineLookupInput, OfflineLookupResult } from '../src/shared/offline-dictionary'
import type { Caption } from '../src/shared/types'
import { learningOriginal, learningTarget } from '../src/shared/learning'

const fault = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fault.rename) { fault.rename = false; throw new Error('Synthetic write failure') }
    return actual.renameSync(...args)
  } }
})
const directories: string[] = []
const resources: DictionaryLearning[] = []
const network = vi.fn(() => { throw new Error('Network forbidden') })
const phrase = { start: 4, end: 8, exact: 'cats' }
const hit = (): OfflineHit => ({
  pack: { schemaVersion: 1, packId: 'fixture-en', version: 'sample-1', sourceLanguage: 'en', glossLanguage: 'en', sourceName: 'Synthetic dictionary fixture', sourceUrl: 'https://example.test/dictionary', sourceRevision: 'fixture-revision-1', license: 'CC0-1.0 synthetic test content', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Synthetic test data, not a real dictionary claim.', dbSha256: 'a'.repeat(64), counts: { entries: 1, senses: 2, forms: 1 } },
  entry: { id: 'entry-cat', headword: 'cat', language: 'en', readings: ['kæt'], partOfSpeech: 'noun', forms: [{ form: 'cats', tags: ['plural'] }], senses: [
    { id: 'sense-animal', glosses: ['A synthetic animal definition.'], tags: [], examples: [{ text: 'The cat sleeps.', translation: null }] },
    { id: 'sense-other', glosses: ['A separate synthetic sense.'], tags: ['figurative'], examples: [] }
  ] }, matchPath: 'form', matchedText: 'cats'
})
function fixture(captions: Caption[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'lingobar-offline-learning-')); directories.push(directory)
  const store = new DictionaryStore(directory), state = { results: [hit()] }
  const lookup = vi.fn((input: OfflineLookupInput): OfflineLookupResult => ({ query: input.text, language: input.language, requestedGlossLanguage: input.glossLanguage || 'zh', results: structuredClone(state.results), message: '' }))
  const provider = vi.fn(async () => { throw new Error('AI provider forbidden') })
  const learning = new DictionaryLearning(store, () => captions, () => ({ configured: false, providerLabel: 'DeepSeek', model: '', offlineDictionaryAvailable: false }), provider, vi.fn(), lookup)
  resources.push(learning)
  const open = (owner = 1) => learning.openInput(owner, { text: 'Two cats sleep.', language: 'en' })
  const input = (owner = 1): DictionaryOfflineInput => ({ handle: open(owner).handle!, span: phrase, language: 'en', glossLanguage: 'zh' })
  const save = (value = input(), senseId = 'sense-animal') => learning.saveOffline(1, { ...value, packId: 'fixture-en', packVersion: 'sample-1', packSha256: 'a'.repeat(64), entryId: 'entry-cat', senseId })
  return { directory, store, state, lookup, provider, learning, open, input, save }
}
beforeEach(() => { fault.rename = false; network.mockClear(); vi.stubGlobal('fetch', network); vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Sockets forbidden') } }) })
afterEach(() => { resources.splice(0).forEach(learning => learning.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('local selected-sense learning without AI configuration', () => {
  it('keeps source-labelled readings in frozen history and export, hidden until explicit review reveal', () => {
    const f = fixture(), readings = [
      '来源韩文记音 · hangeul；tags=["phonetic"]：공(ː)산당',
      '来源读音 · zh_pron；tags=["Min-Nan","Hokkien"]；raw_tags=["菲律賓"]：--le',
      '来源读音 · zh_pron；tags=["<img src=\"https://remote.invalid/\">"]：![raw](https://remote.invalid/)'
    ]
    f.state.results[0].entry.readings = readings
    const saved = f.save(), before = structuredClone(saved)
    f.state.results = []
    const restarted = new DictionaryStore(f.directory)
    expect(restarted.get(saved.id)).toEqual(before)
    const exported = JSON.parse(dictionaryJson(restarted.exportSnapshot()))
    expect(exported.entries[0].explanation.entry.readings).toEqual(readings)
    expect(exported.readingNotice).toContain('不视为标准答案')
    expect(exported.readingNotice).not.toContain('已请求')
    const markdown = dictionaryMarkdown(restarted.exportSnapshot())
    expect(markdown).toContain('来源读音记录（未校验）')
    for (const line of markdown.split('\n').filter(line => line.includes('remote.invalid'))) expect(line.startsWith('    ')).toBe(true)
    const review = f.learning.startReview(1)
    expect(JSON.stringify(review)).not.toMatch(/공\(ː\)산당|--le|remote\.invalid|hangeul|zh_pron/)
    const revealed = f.learning.reveal(1, review.sessionId, saved.id, saved.explanations[0].explanationId).explanation
    expect(revealed.providerKind === 'offline-dictionary' && revealed.entry.readings).toEqual(readings)
    expect(f.provider).not.toHaveBeenCalled()
  })
  it('preserves an explicitly punctuated spacing headword in learning snapshots without accepting blank ordinary words', () => {
    const f = fixture()
    f.state.results[0].entry.headword = ' '
    expect(() => f.save()).toThrow('学习历史格式')
    f.state.results[0].entry.partOfSpeech = 'punct'
    const saved = f.save(), restarted = new DictionaryStore(f.directory)
    const explanation = restarted.get(saved.id)!.explanations[0]
    expect(explanation.providerKind).toBe('offline-dictionary')
    if (explanation.providerKind !== 'offline-dictionary') throw new Error('Expected offline source')
    expect(explanation.entry.headword).toBe(' ')
    expect(JSON.parse(dictionaryJson(restarted.exportSnapshot())).entries[0].explanation.entry.headword).toBe(' ')
  })
  it('opens explicit user input, queries and saves only the selected source/sense without any provider dispatch', () => {
    const f = fixture(), input = f.input()
    const result = f.learning.offlineLookup(1, input)
    expect(result.results[0].entry.senses).toHaveLength(2)
    expect(f.store.list().total).toBe(0)
    const saved = f.save(input, 'sense-other'), explanation = saved.explanations[0]
    expect(saved.source).toMatchObject({ text: 'Two cats sleep.', sourceType: 'text', provenance: 'user-input', captionId: null, displayedVersion: null, sourceVersion: null, span: phrase })
    expect(saved.favorite).toBe(true); expect(saved.attempts).toEqual([])
    expect(explanation.providerKind).toBe('offline-dictionary')
    if (explanation.providerKind !== 'offline-dictionary') throw new Error('Expected offline result')
    expect(explanation.sense.id).toBe('sense-other'); expect(explanation.pack.sourceRevision).toBe('fixture-revision-1')
    expect(explanation).not.toHaveProperty('model'); expect(explanation).not.toHaveProperty('usage'); expect(explanation).not.toHaveProperty('finishReason')
    expect(f.lookup).toHaveBeenCalledTimes(2); expect(f.provider).not.toHaveBeenCalled()
    expect(new DictionaryStore(f.directory).get(saved.id)).toEqual(saved)
  })
  it('rechecks enabled pack data instead of accepting renderer definitions, and never binds another window or changed selection', () => {
    const f = fixture(), input = f.input()
    expect(() => f.learning.offlineLookup(2, input)).toThrow('快照')
    expect(() => f.save({ ...input, span: { start: 5, end: 8, exact: 'cats' } })).toThrow('短语')
    expect(() => f.learning.saveOffline(1, { ...input, packId: 'fixture-en', packVersion: 'sample-1', packSha256: 'a'.repeat(64), entryId: 'entry-cat', senseId: 'forged', gloss: 'renderer forgery' })).toThrow('词库或义项')
    f.state.results = []
    expect(() => f.save(input)).toThrow('词库或义项')
    expect(f.store.list().total).toBe(0); expect(f.provider).not.toHaveBeenCalled()
  })
  it('refuses a saved selection after its pack version or bytes change instead of silently choosing the new definition', () => {
    const f = fixture(), input = f.input()
    f.learning.offlineLookup(1, input)
    f.state.results[0].pack.version = 'sample-2'
    expect(() => f.save(input)).toThrow('词库已更新')
    f.state.results[0].pack.version = 'sample-1'; f.state.results[0].pack.dbSha256 = 'b'.repeat(64)
    expect(() => f.save(input)).toThrow('词库已更新')
    expect(f.store.list().total).toBe(0); expect(f.provider).not.toHaveBeenCalled()
  })
  it('freezes source and dictionary sense snapshots across source revisions, pack update/uninstall and restart', () => {
    const caption: Caption = { id: 'caption-1', source: 'system', original: 'Two cats sleep.', translatedOriginal: 'Two cats sleep.', language: 'English', translations: { zh: '合成句' }, zh: '合成句', en: '', ja: '', reading: '', createdAt: 1, status: 'ready', saved: false }
    const f = fixture([caption])
    const handle = f.learning.open(1, { captionId: caption.id, displayedText: learningOriginal(caption), sourceVersion: dictionarySourceVersion(caption), displayedVersion: learningTarget(caption, { targetLanguages: ['zh'], showFurigana: false }).version })
    caption.original = caption.translatedOriginal = 'Changed subtitle.'
    const saved = f.save({ handle: handle.handle!, span: phrase, language: 'en' }), before = structuredClone(saved)
    f.state.results[0].pack.version = 'sample-2'; f.state.results[0].entry.senses[0].glosses = ['New version definition.']; f.state.results = []
    expect(f.store.get(saved.id)).toEqual(before)
    expect(new DictionaryStore(f.directory).get(saved.id)).toEqual(before)
    expect(f.store.get(saved.id)!.source.provenance).toBe('main-verified')
    expect(f.store.list({ query: 'synthetic animal' }).total).toBe(1)
  })
  it('reviews the selected committed sense, keeps answers out of the prompt, and makes self-rating/undo idempotent', () => {
    const f = fixture(), saved = f.save(), review = f.learning.startReview(1)
    expect(review.cards[0].encounterId).toBe(saved.id)
    expect(JSON.stringify(review)).not.toContain('synthetic animal')
    const revealed = f.learning.reveal(1, review.sessionId, saved.id, saved.explanations[0].explanationId)
    expect(revealed.explanation.providerKind).toBe('offline-dictionary')
    const rated = f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')
    expect(f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')).toEqual(rated)
    expect(f.store.exportSnapshot().reviews).toHaveLength(1)
    const undone = f.learning.undo(1, review.sessionId, rated.lastEventId!)
    expect(f.learning.undo(1, review.sessionId, rated.lastEventId!)).toEqual(undone)
    expect(f.store.exportSnapshot().reviews).toEqual([]); expect(f.provider).not.toHaveBeenCalled()
    f.learning.remove(saved.id)
    expect(f.store.list().total).toBe(0); expect(JSON.parse(dictionaryJson(f.store.exportSnapshot())).entries).toEqual([])
  })
  it('exports source/license/sense data as offline data and escapes dictionary text in Markdown', () => {
    const f = fixture(), payload = '<img src="https://remote.invalid/">\n![external](https://remote.invalid/)'
    f.state.results[0].entry.senses[0].glosses = [payload]
    const saved = f.save(), doc = f.store.exportSnapshot(), json = JSON.parse(dictionaryJson(doc))
    expect(json.entries[0].source).toEqual(saved.source)
    expect(json.entries[0].explanation).toEqual(saved.explanations[0])
    expect(json.entries[0].explanation.providerKind).toBe('offline-dictionary')
    const markdown = dictionaryMarkdown(doc)
    expect(markdown).toContain('离线词典义项'); expect(markdown).toContain('CC0-1.0 synthetic test content'); expect(markdown).not.toContain('### AI 语境解释')
    for (const line of markdown.split('\n').filter(line => line.includes('remote.invalid'))) expect(line.startsWith('    ')).toBe(true)
  })
  it('retains the actual version-two pack format through save, restart, export and review', () => {
    const f = fixture()
    f.state.results[0].pack.schemaVersion = 2
    const saved = f.save(), restarted = new DictionaryStore(f.directory)
    const explanation = restarted.get(saved.id)!.explanations[0]
    expect(explanation.providerKind).toBe('offline-dictionary')
    if (explanation.providerKind !== 'offline-dictionary') throw new Error('Expected offline source')
    expect(explanation.pack.schemaVersion).toBe(2)
    expect(JSON.parse(dictionaryJson(restarted.exportSnapshot())).entries[0].explanation.pack.schemaVersion).toBe(2)
    const review = f.learning.startReview(1)
    const answer = f.learning.reveal(1, review.sessionId, saved.id, explanation.explanationId).explanation
    expect(answer.providerKind === 'offline-dictionary' && answer.pack.schemaVersion).toBe(2)
    expect(f.provider).not.toHaveBeenCalled()
  })
  it('keeps all 254 source-reading records and manifest3 across frozen history, export and review', () => {
    const f = fixture(), readings = Array.from({ length: 254 }, (_, index) => `来源中文记音（zh_pron；标签：["synthetic-variety-${index}"]）：synthetic-${index}`)
    f.state.results[0].pack.schemaVersion = 3
    f.state.results[0].entry.readings = readings
    const saved = f.save(), restarted = new DictionaryStore(f.directory)
    const explanation = restarted.get(saved.id)!.explanations[0]
    expect(explanation.providerKind === 'offline-dictionary' && explanation.pack.schemaVersion).toBe(3)
    expect(explanation.providerKind === 'offline-dictionary' && explanation.entry.readings).toEqual(readings)
    const exported = JSON.parse(dictionaryJson(restarted.exportSnapshot())).entries[0].explanation
    expect(exported.pack.schemaVersion).toBe(3); expect(exported.entry.readings.at(-1)).toBe(readings.at(-1))
    const review = f.learning.startReview(1)
    expect(JSON.stringify(review)).not.toContain('synthetic-variety')
    const answer = f.learning.reveal(1, review.sessionId, saved.id, explanation.explanationId).explanation
    expect(answer.providerKind === 'offline-dictionary' && answer.entry.readings.at(-1)).toBe(readings.at(-1))
    f.state.results[0].entry.readings = Array.from({ length: 257 }, (_, index) => `source-${index}`)
    expect(() => f.save()).toThrow('学习历史格式')
    expect(f.store.list().total).toBe(1)
    expect(f.provider).not.toHaveBeenCalled()
  })
  it('retains old AI records alongside offline cards without rewriting other learning files', () => {
    const f = fixture()
    writeFileSync(join(f.directory, 'saved.json'), 'synthetic old favorite file'); writeFileSync(join(f.directory, 'learning-v1.json'), 'synthetic old sidecar')
    const saved = f.save(), source = saved.source
    f.store.createEncounter({ id: 'old-ai', createdAt: 1, source, favorite: true, note: '', explanations: [], attempts: [{ id: 'old-attempt', createdAt: 1, updatedAt: 1, dispatchState: 'not_started', status: 'persisting', explanationId: null }] })
    f.store.updateAttempt('old-ai', 'old-attempt', { status: 'waiting', dispatchState: 'may_have_started' })
    const generated: GeneratedDictionaryExplanation = { schemaVersion: 1, encounterId: 'old-ai', explanationId: 'old-answer', version: 1, providerKind: 'llm-generated', providerLabel: 'Synthetic model', model: 'fixture', promptVersion: 'v1', createdAt: 2, requestedExplanationLanguage: 'zh', finishReason: 'stop', usage: null, readingScope: 'requested-surface-unverified', validationWarnings: [], content: { schemaVersion: 1, status: 'ok', reasonCode: null, targetText: 'cats', headword: 'cat', reading: null, partOfSpeech: null, contextMeaning: 'Synthetic generated meaning.', usageNote: null, examples: null } }
    f.store.appendExplanation('old-ai', 'old-attempt', generated)
    expect(new DictionaryStore(f.directory).get('old-ai')!.explanations[0]).toEqual(generated)
    expect(f.learning.startReview(1).cards).toHaveLength(2)
    expect(readFileSync(join(f.directory, 'saved.json'), 'utf8')).toBe('synthetic old favorite file')
    expect(readFileSync(join(f.directory, 'learning-v1.json'), 'utf8')).toBe('synthetic old sidecar')
  })
  it('reports a failed local snapshot write without creating a request or success record, and preserves protected files', () => {
    const f = fixture(), input = f.input(); fault.rename = true
    expect(() => f.save(input)).toThrow('写入失败')
    expect(f.store.list().total).toBe(0); expect(f.provider).not.toHaveBeenCalled()
    expect(readdirSync(f.directory)).toEqual([])
    const filename = join(f.directory, 'dictionary-learning-v1.json'), protectedText = '{"schemaVersion":999,"private":"synthetic"}'
    writeFileSync(filename, protectedText)
    const readonly = new DictionaryStore(f.directory)
    expect(() => readonly.createEncounter({ id: 'protected', createdAt: 1, source: { text: 'Two cats sleep.', language: 'en', sourceType: 'text', provenance: 'user-input', captionId: null, displayedVersion: null, sourceVersion: null, span: phrase }, favorite: false, note: '', explanations: [], attempts: [] })).toThrow()
    expect(readFileSync(filename, 'utf8')).toBe(protectedText)
  })
})
