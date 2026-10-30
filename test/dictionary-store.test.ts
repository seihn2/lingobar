import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DictionaryStore } from '../src/main/dictionary-store'
import type { DictionaryAttempt, DictionaryEncounter, GeneratedDictionaryExplanation, DictionaryExplanation, DictionaryReviewEvent } from '../src/shared/dictionary'

const fault = vi.hoisted(() => ({ sync: false, rename: false, open: false }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual,
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => { if (fault.sync) { fault.sync = false; throw new Error('RAW-SYNTHETIC-PRIVATE-DISK-PATH') }; return actual.fsyncSync(...args) },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { if (fault.rename) { fault.rename = false; throw new Error('RAW-SYNTHETIC-PRIVATE-DISK-PATH') }; return actual.renameSync(...args) },
    openSync: (...args: Parameters<typeof actual.openSync>) => { if (fault.open) { fault.open = false; throw new Error('RAW-SYNTHETIC-PRIVATE-DISK-PATH') }; return actual.openSync(...args) },
  }
})
const directories: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'lingobar-dictionary-store-')); directories.push(path); return path }
afterEach(() => { fault.sync = fault.rename = fault.open = false; directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
const generated = (value: DictionaryExplanation): GeneratedDictionaryExplanation => { if (value.providerKind !== 'llm-generated') throw new Error('Expected generated fixture'); return value }
const attempt = (id = 'attempt-1'): DictionaryAttempt => ({ id, createdAt: 10, updatedAt: 10, dispatchState: 'not_started', status: 'persisting', explanationId: null })
const encounter = (id = 'encounter-1', withAttempt = true): DictionaryEncounter => ({ id, createdAt: 10, favorite: false, note: '', source: { text: 'You should pick it up now.', language: 'English', sourceType: 'text', provenance: 'user-input', captionId: null, displayedVersion: null, sourceVersion: null, span: { start: 11, end: 21, exact: 'pick it up' } }, explanations: [], attempts: withAttempt ? [attempt(`attempt-${id}`)] : [] })
const explanation = (encounterId = 'encounter-1', version = 1): GeneratedDictionaryExplanation => ({ schemaVersion: 1, encounterId, explanationId: `explanation-${encounterId}-${version}`, version, providerKind: 'llm-generated', providerLabel: 'Synthetic service', model: 'synthetic-model', promptVersion: 'dictionary-v1', createdAt: 20 + version, requestedExplanationLanguage: 'zh', finishReason: 'stop', usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 }, readingScope: 'requested-surface-unverified', content: { schemaVersion: 1, status: 'ok', reasonCode: null, targetText: 'pick it up', headword: 'pick up', reading: { text: 'pɪk ɪt ʌp', notation: 'ipa' }, partOfSpeech: '动词短语', contextMeaning: '把它拿起来', usageNote: '代词位于中间', examples: [{ text: 'Please pick it up.', translation: '请把它拿起来。' }] }, validationWarnings: [] })
const review = (encounterId = 'encounter-1', id = 'review-1', sessionId = 'session-1'): DictionaryReviewEvent => ({ id, encounterId, sessionId, explanationId: `explanation-${encounterId}-1`, createdAt: 30, response: 'recalled' })
function fixture(limits: ConstructorParameters<typeof DictionaryStore>[1] = {}) { const path = directory(); return { path, file: join(path, 'dictionary-learning-v1.json'), store: new DictionaryStore(path, limits) } }
function finish(store: DictionaryStore, id = 'encounter-1', version = 1): void {
  const record = store.get(id)!, pending = record.attempts.at(-1)!
  store.updateAttempt(id, pending.id, { dispatchState: 'may_have_started', status: 'waiting', updatedAt: 20 })
  store.appendExplanation(id, pending.id, explanation(id, version))
}

describe('bounded independent dictionary history', () => {
  it('does not create a file at startup and never migrates either legacy saved library', () => {
    const f = fixture()
    expect(readdirSync(f.path)).toEqual([])
    writeFileSync(join(f.path, 'saved.json'), 'synthetic-old-favorites')
    writeFileSync(join(f.path, 'learning-v1.json'), 'synthetic-old-annotations')
    f.store.createEncounter(encounter()); finish(f.store)
    expect(readFileSync(join(f.path, 'saved.json'), 'utf8')).toBe('synthetic-old-favorites')
    expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).toBe('synthetic-old-annotations')
    expect(new DictionaryStore(f.path).get('encounter-1')).toEqual(f.store.get('encounter-1'))
  })
  it('preserves separate encounters for identical text and returns immutable clones', () => {
    const f = fixture(), first = encounter('one', false)
    f.store.createEncounter(first); f.store.createEncounter(encounter('two', false))
    first.source.text = 'external mutation'
    const copy = f.store.get('one')!; copy.source.span.exact = 'mutation'; copy.note = 'mutation'
    const page = f.store.list(); page.items[0].favorite = true
    const exported = f.store.exportSnapshot(); exported.encounters.splice(0)
    expect(f.store.list().total).toBe(2)
    expect(f.store.get('one')!.source.text).toBe('You should pick it up now.')
    expect(f.store.get('one')!.source.span.exact).toBe('pick it up')
    expect(f.store.get('one')!.note).toBe(''); expect(f.store.get('one')!.favorite).toBe(false)
  })
  it('appends explanation versions only and keeps earlier results during a new pending attempt', () => {
    const f = fixture(); f.store.createEncounter(encounter()); finish(f.store)
    f.store.addAttempt('encounter-1', attempt('attempt-2'))
    expect(f.store.get('encounter-1')!.explanations).toHaveLength(1)
    finish(f.store, 'encounter-1', 2)
    expect(f.store.get('encounter-1')!.explanations.map(item => item.version)).toEqual([1, 2])
    expect(() => f.store.appendExplanation('encounter-1', 'attempt-2', explanation('encounter-1', 3))).toThrow('已结束')
    expect(() => f.store.updateAttempt('encounter-1', 'attempt-2', { status: 'cancelled' })).toThrow('已经结束')
  })
  it('atomically stores ambiguous/declined outcomes without inventing usable answers', () => {
    const f = fixture()
    for (const [id, status, reason] of [['ambiguous', 'ambiguous', 'ambiguous_context'], ['declined', 'declined', 'unsupported_language']] as const) {
      f.store.createEncounter(encounter(id)); const current = f.store.get(id)!.attempts[0]
      f.store.updateAttempt(id, current.id, { status: 'waiting', dispatchState: 'may_have_started' })
      const item = explanation(id); item.content = { schemaVersion: 1, status, reasonCode: reason, targetText: 'pick it up', headword: null, reading: null, partOfSpeech: null, contextMeaning: null, usageNote: null, examples: null }
      f.store.appendExplanation(id, current.id, item)
      expect(f.store.get(id)!.attempts[0].status).toBe(status === 'ambiguous' ? 'ambiguous' : 'model_declined')
      expect(generated(f.store.get(id)!.explanations[0]).content.contextMeaning).toBeNull()
      expect(() => f.store.addReview(review(id, `review-${id}`))).toThrow()
    }
  })
  it('retains failed intents until explicit deletion and searches phrase/source/meaning/note with bounded pages', () => {
    const f = fixture()
    f.store.createEncounter(encounter('failed')); f.store.updateAttempt('failed', 'attempt-failed', { status: 'service_error' })
    f.store.createEncounter(encounter('ready')); finish(f.store, 'ready'); f.store.edit('ready', { favorite: true, note: '独立合成笔记 é' })
    const japanese = encounter('japanese', false); japanese.createdAt = 40; japanese.source = { text: '日本語を学ぶ', language: '日本語', sourceType: 'text', provenance: 'user-input', captionId: null, displayedVersion: null, sourceVersion: null, span: { start: 0, end: 3, exact: '日本語' } }; f.store.createEncounter(japanese)
    expect(f.store.list({ incomplete: true }).items.map(item => item.id)).toEqual(['japanese', 'failed'])
    expect(f.store.list({ query: 'pick it up' }).total).toBe(2)
    expect(f.store.list({ query: 'should' }).total).toBe(2)
    expect(f.store.list({ query: '拿起来' }).items[0].id).toBe('ready')
    expect(f.store.list({ query: '笔记 é' }).items[0].id).toBe('ready')
    expect(f.store.list({ favorite: true, incomplete: false }).items.map(item => item.id)).toEqual(['ready'])
    expect(f.store.list({ language: '日本語', provenance: 'user-input' }).total).toBe(1)
    expect(f.store.list({ pageSize: 1, page: 99 }).page).toBe(3)
    expect(f.store.list({ pageSize: 1, page: 1 }).items[0].id).toBe('japanese')
    for (const query of [{ page: 0 }, { page: 1.5 }, { pageSize: 51 }, { query: 'x'.repeat(501) }, { favorite: 'true' }, { unknown: true }]) expect(() => f.store.list(query as any)).toThrow('查询无效')
  })
  it('cleans only the explicitly deleted encounter and all of its review history', () => {
    const f = fixture(); f.store.createEncounter(encounter()); finish(f.store); f.store.edit('encounter-1', { favorite: true }); f.store.addReview(review())
    f.store.createEncounter(encounter('other')); finish(f.store, 'other'); f.store.edit('other', { favorite: true }); f.store.addReview(review('other', 'review-other'))
    f.store.remove('encounter-1')
    expect(f.store.get('encounter-1')).toBeNull()
    expect(f.store.exportSnapshot().reviews.map(item => item.encounterId)).toEqual(['other'])
    expect(f.store.get('other')!.explanations).toHaveLength(1)
    f.store.remove('encounter-1'); expect(f.store.list().total).toBe(1)
  })
  it('keeps favorite and note updates serialized without changing source or explanations', () => {
    const f = fixture(); f.store.createEncounter(encounter()); finish(f.store)
    const source = f.store.get('encounter-1')!.source
    f.store.edit('encounter-1', { favorite: true }); f.store.edit('encounter-1', { note: 'one' }); f.store.edit('encounter-1', { note: 'two' })
    expect(f.store.get('encounter-1')).toMatchObject({ favorite: true, note: 'two', source })
    expect(f.store.get('encounter-1')!.explanations).toHaveLength(1)
    expect(() => f.store.edit('encounter-1', { note: 'x'.repeat(4001) })).toThrow()
    expect(() => f.store.edit('encounter-1', { source: {} } as any)).toThrow()
  })
})

describe('atomic writes, budgets, recovery and schema protection', () => {
  it.each(['open', 'sync', 'rename'] as const)('leaves the previous disk and memory generation intact on %s failure', mode => {
    const f = fixture(); f.store.createEncounter(encounter('stable', false))
    const before = readFileSync(f.file, 'utf8'), revision = f.store.revision
    fault[mode] = true
    expect(() => f.store.edit('stable', { note: 'must not persist' })).toThrow('写入失败')
    expect(() => { fault[mode] = true; f.store.edit('stable', { note: 'private' }) }).not.toThrow('RAW-SYNTHETIC')
    expect(readFileSync(f.file, 'utf8')).toBe(before)
    expect(f.store.get('stable')!.note).toBe('')
    expect(f.store.revision).toBe(revision)
    expect(readdirSync(f.path)).toEqual(['dictionary-learning-v1.json'])
    f.store.edit('stable', { note: 'recovered' }); expect(f.store.get('stable')!.note).toBe('recovered')
  })
  it('reserves completion headroom across unrelated edits while an attempt is pending', () => {
    const f = fixture({ bytes: 5500, reservationBytes: 3000 })
    f.store.createEncounter(encounter())
    expect(() => f.store.edit('encounter-1', { note: 'x'.repeat(2200) })).toThrow('容量上限')
    expect(f.store.get('encounter-1')!.note).toBe('')
    f.store.updateAttempt('encounter-1', 'attempt-encounter-1', { status: 'cancelled' })
    f.store.edit('encounter-1', { note: 'x'.repeat(2200) })
    expect(f.store.get('encounter-1')!.note).toHaveLength(2200)
  })
  it('rejects a new request before writing when the logical completion reservation cannot fit', () => {
    const f = fixture({ bytes: 1024, reservationBytes: 2048 })
    expect(() => f.store.assertCanStart()).toThrow('预留')
    expect(() => f.store.createEncounter(encounter())).toThrow('预留')
    expect(readdirSync(f.path)).toEqual([])
  })
  it('never silently removes attempts or explanation versions at their bounds', () => {
    const f = fixture({ encounters: 2, explanations: 1, attempts: 2 })
    f.store.createEncounter(encounter()); finish(f.store)
    const before = f.store.get('encounter-1')!
    expect(() => f.store.assertCanStart('encounter-1')).toThrow('已满')
    expect(() => f.store.addAttempt('encounter-1', attempt('second'))).toThrow('已满')
    expect(f.store.get('encounter-1')).toEqual(before)
    f.store.createEncounter(encounter('second', false))
    expect(() => f.store.assertCanStart()).toThrow('条目已满')
    const a = fixture({ attempts: 1 }); a.store.createEncounter(encounter()); a.store.updateAttempt('encounter-1', 'attempt-encounter-1', { status: 'service_error' })
    expect(() => a.store.addAttempt('encounter-1', attempt('extra'))).toThrow('已满')
    expect(a.store.get('encounter-1')!.attempts).toHaveLength(1)
  })
  it('recovers both pre-dispatch and may-have-started attempts as Interrupted without a provider', () => {
    const f = fixture(); f.store.createEncounter(encounter('not-started')); f.store.createEncounter(encounter('possibly-started'))
    f.store.updateAttempt('possibly-started', 'attempt-possibly-started', { status: 'waiting', dispatchState: 'may_have_started' })
    const restored = new DictionaryStore(f.path)
    expect(restored.get('not-started')!.attempts[0]).toMatchObject({ status: 'interrupted', dispatchState: 'not_started' })
    expect(restored.get('possibly-started')!.attempts[0]).toMatchObject({ status: 'interrupted', dispatchState: 'may_have_started' })
    expect(new DictionaryStore(f.path).exportSnapshot()).toEqual(restored.exportSnapshot())
  })
  it('preserves the original pending file and makes recovery readonly if recovery cannot commit', () => {
    const f = fixture(); f.store.createEncounter(encounter())
    const before = readFileSync(f.file, 'utf8'); fault.rename = true
    const restored = new DictionaryStore(f.path)
    expect(restored.warning).toContain('恢复状态未保存')
    expect(restored.get('encounter-1')!.attempts[0].status).toBe('interrupted')
    expect(readFileSync(f.file, 'utf8')).toBe(before)
    expect(() => restored.edit('encounter-1', { note: 'cannot write' })).toThrow('只读')
  })
  it.each(['corrupt', 'higher', 'unknown-key', 'unknown-nested'])('preserves %s data without forwarding unknown objects or touching old libraries', mode => {
    const f = fixture(); f.store.createEncounter(encounter('stable', false))
    const document = JSON.parse(readFileSync(f.file, 'utf8'))
    if (mode === 'higher') document.schemaVersion = 2
    if (mode === 'unknown-key') document.privateEndpoint = 'PRIVATE-NOT-FORWARDED'
    if (mode === 'unknown-nested') document.encounters[0].source.span.extra = 'PRIVATE-NOT-FORWARDED'
    const raw = mode === 'corrupt' ? '{broken' : JSON.stringify(document)
    writeFileSync(f.file, raw)
    const restored = new DictionaryStore(f.path)
    expect(restored.warning).toContain('只读')
    expect(restored.list().items).toEqual([])
    expect(() => restored.createEncounter(encounter('new', false))).toThrow('只读')
    expect(readFileSync(f.file, 'utf8')).toBe(raw)
    expect(JSON.stringify(restored.exportSnapshot())).not.toContain('PRIVATE-NOT-FORWARDED')
  })
  it('refuses another writer or newer schema appearing after startup', () => {
    const f = fixture(); f.store.createEncounter(encounter('stable', false))
    const future = '{"schemaVersion":99,"future":"preserve"}'
    writeFileSync(f.file, future)
    expect(() => f.store.edit('stable', { note: 'no overwrite' })).toThrow('其他进程')
    expect(readFileSync(f.file, 'utf8')).toBe(future)
    expect(f.store.get('stable')!.note).toBe('')
  })
  it('ignores an abandoned temporary file left before rename', () => {
    const f = fixture(); f.store.createEncounter(encounter('stable', false))
    writeFileSync(`${f.file}.abandoned.tmp`, '{uncommitted')
    expect(new DictionaryStore(f.path).get('stable')!.id).toBe('stable')
  })
})

describe('source, envelope and review identity constraints', () => {
  it.each([
    (item: DictionaryEncounter) => { item.source.span.exact = 'wrong' },
    (item: DictionaryEncounter) => { item.source.span.end = 22 },
    (item: DictionaryEncounter) => { item.source.text = 'x'.repeat(2001) },
    (item: DictionaryEncounter) => { item.source.language = '' },
    (item: DictionaryEncounter) => { item.source.provenance = 'main-verified'; item.source.sourceVersion = 'a'.repeat(64) },
    (item: DictionaryEncounter) => { item.source.captionId = 'must-not-upgrade' },
    (item: DictionaryEncounter) => { Object.assign(item.source, { unknown: true }) },
  ])('rejects invalid or forged source shape before any persistent write', mutate => {
    const f = fixture(), item = encounter(); mutate(item)
    expect(() => f.store.createEncounter(item)).toThrow()
    expect(readdirSync(f.path)).toEqual([])
  })
  it('accepts legitimate source digest provenance and rejects a split emoji/combining sequence', () => {
    const f = fixture(), verified = encounter('verified', false)
    verified.source.provenance = 'main-verified'; verified.source.captionId = 'caption-id'; verified.source.sourceVersion = 'a'.repeat(64); verified.source.displayedVersion = 'b'.repeat(64)
    f.store.createEncounter(verified)
    expect(f.store.get('verified')!.source.provenance).toBe('main-verified')
    for (const [source, end, exact] of [['👩🏽‍💻', 2, '👩'], ['é', 1, 'e']] as const) {
      const broken = encounter('broken', false); broken.source.text = source; broken.source.span = { start: 0, end, exact }
      expect(() => f.store.createEncounter(broken)).toThrow()
    }
  })
  it('rejects forged model/application fields and output echo without replacing prior committed data', () => {
    const f = fixture(); f.store.createEncounter(encounter()); f.store.updateAttempt('encounter-1', 'attempt-encounter-1', { status: 'waiting', dispatchState: 'may_have_started' })
    for (const mutate of [
      (item: GeneratedDictionaryExplanation) => { Object.assign(item, { endpoint: 'https://private.invalid' }) },
      (item: GeneratedDictionaryExplanation) => { item.providerLabel = 'https://private.invalid' },
      (item: GeneratedDictionaryExplanation) => { item.content.targetText = 'another word' },
      (item: GeneratedDictionaryExplanation) => { item.version = 2 },
      (item: GeneratedDictionaryExplanation) => { item.finishReason = 'length' as any },
      (item: GeneratedDictionaryExplanation) => { Object.assign(item.content.reading!, { audioUrl: 'https://private.invalid' }) },
    ]) {
      const value = explanation(); mutate(value)
      expect(() => f.store.appendExplanation('encounter-1', 'attempt-encounter-1', value)).toThrow()
      expect(f.store.get('encounter-1')!.explanations).toEqual([])
    }
    f.store.appendExplanation('encounter-1', 'attempt-encounter-1', explanation())
    expect(generated(new DictionaryStore(f.path).get('encounter-1')!.explanations[0]).content.reading).toEqual({ text: 'pɪk ɪt ʌp', notation: 'ipa' })
  })
  it('does not roll dispatch state backward or duplicate review events; undo is session-scoped and idempotent', () => {
    const f = fixture(); f.store.createEncounter(encounter()); finish(f.store)
    expect(() => f.store.updateAttempt('encounter-1', 'attempt-encounter-1', { dispatchState: 'not_started' })).toThrow('回退')
    f.store.edit('encounter-1', { favorite: true })
    const item = review(); f.store.addReview(item); f.store.addReview(item)
    expect(f.store.exportSnapshot().reviews).toHaveLength(1)
    expect(() => f.store.addReview({ ...item, response: 'not_recalled' })).toThrow('冲突')
    expect(() => f.store.removeReview(item.id, 'different-session')).toThrow('本次复习')
    expect(f.store.removeReview(item.id, item.sessionId)).toBe(true)
    expect(f.store.removeReview(item.id, item.sessionId)).toBe(false)
    expect(f.store.exportSnapshot().reviews).toEqual([])
  })
  it('refuses a new self-report after unfavorite while retaining prior completed history', () => {
    const f = fixture(); f.store.createEncounter(encounter()); finish(f.store)
    expect(() => f.store.addReview(review())).toThrow('仍在收藏')
    f.store.edit('encounter-1', { favorite: true }); f.store.addReview(review())
    f.store.edit('encounter-1', { favorite: false }); f.store.addReview(review())
    expect(f.store.exportSnapshot().reviews).toHaveLength(1)
    expect(() => f.store.addReview(review('encounter-1', 'new-report'))).toThrow('仍在收藏')
  })
  it('does not increase review count on write failure and rejects nonexistent/deleted answers', () => {
    const f = fixture({ reviews: 1, reviewsPerEncounter: 1 }); f.store.createEncounter(encounter()); finish(f.store)
    f.store.edit('encounter-1', { favorite: true })
    fault.rename = true
    expect(() => f.store.addReview(review())).toThrow('写入失败')
    expect(f.store.exportSnapshot().reviews).toEqual([])
    f.store.addReview(review())
    expect(() => f.store.addReview(review('encounter-1', 'second-review'))).toThrow('已满')
    f.store.remove('encounter-1')
    expect(() => f.store.addReview(review())).toThrow()
  })
})
