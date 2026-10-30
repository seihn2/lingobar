import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DictionaryLearning } from '../src/main/dictionary-learning'
import { DictionaryStore, type DictionaryStoreLimits } from '../src/main/dictionary-store'
import type { explainDictionary } from '../src/main/dictionary-provider'
import { DictionarySchemaError } from '../src/shared/dictionary-model'
import { dictionarySourceVersion, type DictionaryAvailability, type DictionaryExplainInput, type DictionaryOpen } from '../src/shared/dictionary'
import { learningOriginal, learningTarget, type Phrase } from '../src/shared/learning'
import type { Caption } from '../src/shared/types'

// Every file belongs to a newly created synthetic directory. No network/audio/keys are available.
const fault = vi.hoisted(() => ({ renames: 0, failAt: 0 }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    fault.renames++
    if (fault.failAt === fault.renames) { fault.failAt = 0; throw new Error('SYNTHETIC-PRIVATE-PATH-MUST-NOT-LEAK') }
    return actual.renameSync(...args)
  } }
})

type Result = Awaited<ReturnType<typeof explainDictionary>>
type Job = { input: { sourceText: string; targetText: string; requestedExplanationLanguage: string }; signal: AbortSignal; resolve(value: Result): void; reject(error: Error): void; settled: boolean }
const resources: Array<{ path: string; learning: DictionaryLearning; jobs: Job[] }> = []
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
const caption = (id = 'synthetic-caption', extra: Partial<Caption> = {}): Caption => ({ id, source: 'system', original: 'You should pick it up now.', translatedOriginal: 'You should pick it up now.', language: 'English', zh: '你现在应该把它拿起来。', en: '', ja: '今それを拾って。', reading: '', translations: { zh: '你现在应该把它拿起来。', ja: '今それを拾って。' }, status: 'ready', saved: false, createdAt: 1, ...extra })
const phrase: Phrase = { start: 11, end: 21, exact: 'pick it up' }
const descriptor = (): DictionaryAvailability => ({ configured: true, providerLabel: 'DeepSeek', model: 'synthetic-model', offlineDictionaryAvailable: false })
function openInput(item: Caption): DictionaryOpen {
  return { captionId: item.id, displayedText: learningOriginal(item), sourceVersion: dictionarySourceVersion(item), displayedVersion: learningTarget(item, { targetLanguages: ['zh', 'ja'], showFurigana: true }).version }
}
function result(target = phrase.exact): Result {
  return { content: { schemaVersion: 1, status: 'ok', reasonCode: null, targetText: target, headword: 'AI lemma', reading: { text: 'synthetic reading', notation: 'other' }, partOfSpeech: '合成词性', contextMeaning: 'SYNTHETIC-HIDDEN-MEANING', usageNote: 'SYNTHETIC-HIDDEN-USAGE', examples: [{ text: 'This is a generated example.', translation: 'AI生成例句译文' }] }, finishReason: 'stop', usage: null, promptVersion: 'dictionary-v1', validationWarnings: [] }
}
function fixture(options: { limits?: Partial<DictionaryStoreLimits>; captions?: Caption[]; availability?: DictionaryAvailability; raw?: string } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'lingobar-dictionary-state-'))
  if (options.raw !== undefined) writeFileSync(join(path, 'dictionary-learning-v1.json'), options.raw)
  const store = new DictionaryStore(path, options.limits)
  const captions = options.captions || [caption()]
  const jobs: Job[] = [], changed = vi.fn()
  const provider = vi.fn((input: Job['input'], signal: AbortSignal) => new Promise<Result>((resolve, reject) => { jobs.push({ input: structuredClone(input), signal, resolve, reject, settled: false }) }))
  const availability = options.availability || descriptor()
  const learning = new DictionaryLearning(store, () => captions, () => availability, provider, changed)
  resources.push({ path, learning, jobs })
  const open = (owner = 1, item = captions[0]) => learning.open(owner, openInput(item))
  const request = (owner = 1, extra: Partial<DictionaryExplainInput> = {}) => learning.explain(owner, { handle: open(owner).handle!, span: phrase, language: 'zh', ...extra })
  return { path, file: join(path, 'dictionary-learning-v1.json'), store, captions, jobs, provider, changed, availability, learning, open, request }
}
type Fixture = ReturnType<typeof fixture>
async function complete(f: Fixture, index = f.jobs.length - 1, value?: Result) {
  const job = f.jobs[index]; job.settled = true; job.resolve(value || result(job.input.targetText)); await settle()
}
async function reject(f: Fixture, error: Error, index = f.jobs.length - 1) { f.jobs[index].settled = true; f.jobs[index].reject(error); await settle() }
async function seed(f: Fixture, count = 1) {
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    const waiting = f.request(); await complete(f)
    f.learning.edit(waiting.encounterId, { favorite: true, note: `ANSWER-NOTE-${index}` }); ids.push(waiting.encounterId)
  }
  return ids
}
beforeEach(() => {
  fault.renames = fault.failAt = 0
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real fetch is forbidden') }))
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Real sockets are forbidden') } })
})
afterEach(async () => {
  fault.failAt = 0
  for (const resource of resources) {
    resource.learning.close()
    for (const job of resource.jobs) if (!job.settled) { job.settled = true; job.resolve(result(job.input.targetText)) }
  }
  await settle(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  resources.splice(0).forEach(resource => rmSync(resource.path, { recursive: true, force: true }))
})

describe('immutable application-owned aligned source handles', () => {
  it('accepts source-only agreement after late translation/ruby and an untranslated tail; later queue eviction cannot replace it', async () => {
    const f = fixture(), before = openInput(f.captions[0])
    f.captions[0].original += ' unfinished tail'
    f.captions[0].translationPending = true; f.captions[0].live = true
    f.captions[0].translations!.ja = '遅い新訳'; f.captions[0].jaSegments = [{ text: '遅', reading: 'おそ' }, { text: 'い新訳' }]
    const handle = f.learning.open(1, before)
    expect(handle.handle).toBeTypeOf('string'); expect(handle.source?.text).toBe(before.displayedText)
    f.captions.splice(0)
    const waiting = f.learning.explain(1, { handle: handle.handle!, span: phrase, language: 'zh' })
    expect(f.provider).toHaveBeenCalledTimes(1)
    expect(f.jobs[0].input).toEqual({ sourceText: before.displayedText, targetText: phrase.exact, requestedExplanationLanguage: 'zh' })
    await complete(f)
    expect(f.learning.get(waiting.encounterId)?.encounter.source).toMatchObject({ text: before.displayedText, provenance: 'main-verified', span: phrase })
  })
  it.each(['changed-source', 'forged-text', 'forged-version', 'never-registered-evicted'])('fails closed for %s with no request and no fallback to a newer or user-input sentence', mode => {
    const f = fixture(), input = openInput(f.captions[0])
    if (mode === 'changed-source') f.captions[0].translatedOriginal = 'changed source'
    if (mode === 'forged-text') input.displayedText = 'forged source'
    if (mode === 'forged-version') input.sourceVersion = 'forged'
    if (mode === 'never-registered-evicted') f.captions.splice(0)
    const rejected = f.learning.open(1, input)
    expect(rejected).toMatchObject({ handle: null, source: null })
    expect(rejected.reason).toContain('重新选择')
    expect(() => f.learning.explain(1, { handle: 'forged', span: phrase, language: 'zh' })).toThrow('快照')
    expect(f.provider).not.toHaveBeenCalled(); expect(f.store.list().total).toBe(0)
  })
  it('binds handles to owners and replaces only that owner’s previous handle', () => {
    const f = fixture(), one = f.open(1), two = f.open(2)
    expect(() => f.learning.explain(2, { handle: one.handle!, span: phrase, language: 'zh' })).toThrow('快照')
    const newer = f.open(1)
    expect(() => f.learning.explain(1, { handle: one.handle!, span: phrase, language: 'zh' })).toThrow('快照')
    f.learning.release(1, one.handle) // A late release must not revoke the replacement.
    expect(f.learning.explain(1, { handle: newer.handle!, span: phrase, language: 'zh' }).state).toBe('waiting')
    expect(two.handle).not.toBe(one.handle)
    expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it('releasing a detail or owner invalidates future uses but does not cancel already dispatched work', async () => {
    const f = fixture(), handle = f.open(), waiting = f.learning.explain(1, { handle: handle.handle!, span: phrase, language: 'zh' })
    f.learning.release(1, handle.handle); f.learning.releaseOwner(1)
    expect(f.jobs[0].signal.aborted).toBe(false)
    expect(() => f.learning.explain(1, { handle: handle.handle!, span: phrase, language: 'zh' })).toThrow()
    await complete(f)
    expect(f.learning.get(waiting.encounterId)?.run?.state).toBe('ready')
    expect(f.learning.get(waiting.encounterId)?.encounter.explanations).toHaveLength(1)
    expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it.each(['user-input', 'saved-favorite'] as const)('never upgrades persisted %s provenance when reopening after captions change', async provenance => {
    const f = fixture({ captions: [caption('source', { source: provenance === 'user-input' ? 'text' : 'system', saved: provenance === 'saved-favorite' })] })
    const waiting = f.request(); await complete(f)
    const source = f.learning.get(waiting.encounterId)!.encounter.source
    expect(source.provenance).toBe(provenance)
    if (provenance === 'user-input') expect(source).toMatchObject({ captionId: null, displayedVersion: null, sourceVersion: null })
    f.captions[0] = caption('different-live-source')
    const { span: _span, ...snapshot } = source
    expect(f.learning.openEncounter(2, waiting.encounterId).source).toEqual(snapshot)
  })
  it.each([
    { start: 11, end: 21, exact: 'other text' }, { start: -1, end: 10, exact: 'pick it up' }, { start: 0.5, end: 1, exact: 'Y' }, { ...phrase, ignored: 'must reject' },
  ])('rejects forged offset/echo %# before persistence or provider dispatch', span => {
    const f = fixture()
    expect(() => f.request(1, { span })).toThrow('短语')
    expect(f.store.list().total).toBe(0); expect(f.provider).not.toHaveBeenCalled()
  })
  it.each([['👩🏽‍💻', 0, 2, '👩'], ['é', 0, 1, 'e']] as const)('rejects split grapheme span in %s', (text, start, end, exact) => {
    const f = fixture({ captions: [caption('unicode', { original: text, translatedOriginal: text })] })
    expect(() => f.request(1, { span: { start, end, exact } })).toThrow('短语')
    expect(f.provider).not.toHaveBeenCalled()
  })
})

describe('durable intent, single dispatch and failure ownership', () => {
  it.each([1, 2])('refuses dispatch when disk phase%i fails and retains the correct not-started state', async phase => {
    const f = fixture(); fault.failAt = phase
    const state = f.request()
    expect(state).toMatchObject({ state: 'persist_error', dispatchState: 'not_started' })
    expect(state.message).toContain('未发出'); expect(f.provider).not.toHaveBeenCalled()
    if (phase === 1) expect(readdirSync(f.path)).toEqual([])
    else {
      const item = f.store.get(state.encounterId)!
      expect(item.attempts).toHaveLength(1); expect(item.attempts[0]).toMatchObject({ status: 'persisting', dispatchState: 'not_started' })
      const cancelled = f.learning.cancel(state.encounterId, state.attemptId)
      expect(cancelled.message).toContain('本解释请求未发出'); expect(cancelled.message).not.toContain('可能已发出')
    }
    await settle(); expect(f.provider).not.toHaveBeenCalled()
  })
  it('repeated failed first writes leave no absent-encounter generation allocations', () => {
    const f = fixture()
    for (let index = 0; index < 16; index++) {
      fault.failAt = fault.renames + 1
      expect(f.request().state).toBe('persist_error')
    }
    expect(f.provider).not.toHaveBeenCalled(); expect(f.store.list().total).toBe(0); expect(readdirSync(f.path)).toEqual([])
    // A resource-bound assertion only; no production diagnostic or private content is exposed.
    expect((f.learning as unknown as { generations: Map<string, number> }).generations.size).toBe(0)
  })
  it('preflights reserved bytes and unavailable service before any request', () => {
    const f = fixture({ limits: { bytes: 1024, reservationBytes: 2048 } })
    expect(() => f.request()).toThrow('预留'); expect(f.provider).not.toHaveBeenCalled(); expect(readdirSync(f.path)).toEqual([])
    const disabled = fixture({ availability: { ...descriptor(), configured: false } })
    expect(() => disabled.request()).toThrow('设置'); expect(disabled.provider).not.toHaveBeenCalled(); expect(readdirSync(disabled.path)).toEqual([])
  })
  it('enforces a global single-flight across owners and treats subsequent explicit identical queries as distinct encounters', async () => {
    const f = fixture(), first = f.request(1)
    expect(() => f.request(1)).toThrow('在途'); expect(() => f.request(2)).toThrow('在途')
    expect(f.provider).toHaveBeenCalledTimes(1)
    await complete(f)
    const second = f.request(2); await complete(f)
    expect(second.encounterId).not.toBe(first.encounterId); expect(f.store.list().total).toBe(2)
    const reopen = f.learning.openEncounter(2, first.encounterId)
    const appended = f.learning.explain(2, { handle: reopen.handle!, encounterId: first.encounterId, span: phrase, language: 'ja' })
    await complete(f)
    expect(appended.encounterId).toBe(first.encounterId)
    expect(f.store.get(first.encounterId)!.explanations.map(item => item.version)).toEqual([1, 2])
    expect(f.store.list().total).toBe(2); expect(f.provider).toHaveBeenCalledTimes(3)
  })
  it('compares re-explanation source/span values without depending on JSON property order', async () => {
    const f = fixture(), waiting = f.request(); await complete(f)
    const handle = f.learning.openEncounter(1, waiting.encounterId)
    const reordered = { exact: phrase.exact, end: phrase.end, start: phrase.start }
    const appended = f.learning.explain(1, { handle: handle.handle!, encounterId: waiting.encounterId, span: reordered, language: 'zh' })
    expect(appended.state).toBe('waiting'); await complete(f)
    expect(f.store.get(waiting.encounterId)!.explanations.map(item => item.version)).toEqual([1, 2])
  })
  it.each(['encounters', 'explanations', 'attempts'] as const)('does not silently evict %s at its configured bound', async limit => {
    const f = fixture({ limits: { [limit]: 1 } }), first = f.request(); await complete(f)
    if (limit === 'encounters') expect(() => f.request()).toThrow('已满')
    else {
      const handle = f.learning.openEncounter(1, first.encounterId)
      expect(() => f.learning.explain(1, { handle: handle.handle!, encounterId: first.encounterId, span: phrase, language: 'zh' })).toThrow('已满')
    }
    expect(f.provider).toHaveBeenCalledTimes(1); expect(f.store.get(first.encounterId)!.explanations).toHaveLength(1)
  })
  it.each(['ambiguous', 'declined'] as const)('persists model %s without fabricating an ok answer or automatic retry', async status => {
    const f = fixture(), waiting = f.request(), value = result()
    value.content = { schemaVersion: 1, status, reasonCode: status === 'ambiguous' ? 'ambiguous_context' : 'unsupported_language', targetText: phrase.exact, headword: null, reading: null, partOfSpeech: null, contextMeaning: null, usageNote: null, examples: null }
    await complete(f, 0, value)
    expect(f.learning.get(waiting.encounterId)?.run?.state).toBe(status === 'ambiguous' ? 'ambiguous' : 'model_declined')
    expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it.each(['schema', 'service'] as const)('records a terminal %s failure with no raw response/key/endpoint or hidden retry', async category => {
    const f = fixture(), waiting = f.request()
    await reject(f, category === 'schema' ? new DictionarySchemaError() : new Error('SECRET-KEY https://private.invalid/user-content'))
    const detail = f.learning.get(waiting.encounterId)!
    expect(detail.run?.state).toBe(category === 'schema' ? 'schema_error' : 'service_error')
    expect(detail.run?.message).not.toMatch(/SECRET|private\.invalid|user-content/)
    expect(detail.run?.message).toContain('可能已发出'); expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it('has a25s local deadline and ignores provider completion after it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00Z'))
    const f = fixture(), waiting = f.request()
    await vi.advanceTimersByTimeAsync(25000); await settle()
    expect(f.jobs[0].signal.aborted).toBe(true); expect(f.learning.get(waiting.encounterId)?.run?.state).toBe('service_error')
    await complete(f)
    expect(f.store.get(waiting.encounterId)!.explanations).toEqual([]); expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it('invalidates cancellation immediately so a late successful result cannot become ready', async () => {
    const f = fixture(), waiting = f.request()
    const cancelled = f.learning.cancel(waiting.encounterId, waiting.attemptId)
    expect(cancelled).toMatchObject({ state: 'cancelled', dispatchState: 'may_have_started' })
    expect(cancelled.message).toContain('不代表退款'); expect(f.jobs[0].signal.aborted).toBe(true)
    await complete(f)
    expect(f.learning.get(waiting.encounterId)?.run?.state).toBe('cancelled')
    expect(f.store.get(waiting.encounterId)!.explanations).toEqual([])
  })
  it('still revokes a cancelled generation when persisting cancellation itself fails', async () => {
    const f = fixture(), waiting = f.request(); fault.failAt = fault.renames + 1
    expect(f.learning.cancel(waiting.encounterId, waiting.attemptId).message).toContain('未能写盘')
    await complete(f)
    expect(f.store.get(waiting.encounterId)!.explanations).toEqual([])
    expect(new DictionaryStore(f.path).get(waiting.encounterId)!.attempts[0]).toMatchObject({ status: 'interrupted', dispatchState: 'may_have_started' })
  })
  it('does not resurrect a deleted encounter on late output or a stale retry-save', async () => {
    const f = fixture(), waiting = f.request(); f.learning.remove(waiting.encounterId)
    expect(f.jobs[0].signal.aborted).toBe(true); await complete(f)
    expect(f.learning.get(waiting.encounterId)).toBeNull(); expect(f.store.list().total).toBe(0)
    expect(() => f.learning.retrySave(waiting.encounterId, waiting.attemptId)).toThrow('没有可保存')
  })
  it.each([false, true])('revokes deleted-history handles even if deletion fails=%s; an active-caption query remains a separate explicit encounter', async failDeletion => {
    const f = fixture(), [encounterId] = await seed(f)
    const history = f.learning.openEncounter(1, encounterId), active = f.open(2)
    if (failDeletion) { fault.failAt = fault.renames + 1; expect(() => f.learning.remove(encounterId)).toThrow('未删除') }
    else f.learning.remove(encounterId)
    expect(() => f.learning.explain(1, { handle: history.handle!, span: phrase, language: 'zh' })).toThrow('快照')
    expect(f.provider).toHaveBeenCalledTimes(1)
    const explicit = f.learning.explain(2, { handle: active.handle!, span: phrase, language: 'zh' })
    expect(explicit.encounterId).not.toBe(encounterId); await complete(f)
    expect(f.store.list().total).toBe(failDeletion ? 2 : 1); expect(f.provider).toHaveBeenCalledTimes(2)
  })
  it('reports failed deletion honestly while permanently revoking its old in-flight result', async () => {
    const f = fixture(), waiting = f.request(); fault.failAt = fault.renames + 1
    expect(() => f.learning.remove(waiting.encounterId)).toThrow('未删除')
    expect(f.store.get(waiting.encounterId)).not.toBeNull(); await complete(f)
    expect(f.store.get(waiting.encounterId)!.explanations).toEqual([])
    expect(f.learning.get(waiting.encounterId)?.run?.message).toContain('失效')
    f.learning.remove(waiting.encounterId); expect(f.store.get(waiting.encounterId)).toBeNull()
  })
  it('keeps ReadyUnsaved only in memory and retry-save performs no additional provider request', async () => {
    const f = fixture(), waiting = f.request(); fault.failAt = fault.renames + 1
    await complete(f)
    expect(f.learning.hasUnsaved).toBe(true)
    expect(f.learning.get(waiting.encounterId)?.run).toMatchObject({ state: 'ready_unsaved', unsaved: { encounterId: waiting.encounterId } })
    expect(f.store.get(waiting.encounterId)!.explanations).toEqual([])
    expect(() => f.request()).toThrow('仅在内存')
    const saved = f.learning.retrySave(waiting.encounterId, waiting.attemptId)
    expect(saved.state).toBe('ready'); expect(f.learning.hasUnsaved).toBe(false)
    expect(f.store.get(waiting.encounterId)!.explanations).toHaveLength(1); expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it('removes a discarded in-memory result from the visible run even when its status cannot be persisted', async () => {
    const f = fixture(), waiting = f.request(); fault.failAt = fault.renames + 1; await complete(f)
    expect(f.learning.get(waiting.encounterId)?.run?.unsaved).toBeDefined()
    fault.failAt = fault.renames + 1
    expect(() => f.learning.discardUnsaved(waiting.encounterId, waiting.attemptId)).toThrow('状态未能写盘')
    expect(f.learning.hasUnsaved).toBe(false)
    expect(f.learning.get(waiting.encounterId)?.run).toMatchObject({ state: 'cancelled', message: expect.stringContaining('状态未能写盘') })
    expect(f.learning.get(waiting.encounterId)?.run?.unsaved).toBeUndefined()
    expect(() => f.learning.retrySave(waiting.encounterId, waiting.attemptId)).toThrow('没有可保存')
    expect(f.store.get(waiting.encounterId)!.explanations).toEqual([])
    expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it.each(['discard', 'delete', 'close'] as const)('a ReadyUnsaved %s cannot be revived by a later save or restart', async operation => {
    const f = fixture(), waiting = f.request(); fault.failAt = fault.renames + 1; await complete(f)
    if (operation === 'discard') f.learning.discardUnsaved(waiting.encounterId, waiting.attemptId)
    if (operation === 'delete') f.learning.remove(waiting.encounterId)
    if (operation === 'close') f.learning.close()
    expect(f.learning.hasUnsaved).toBe(false)
    expect(() => f.learning.retrySave(waiting.encounterId, waiting.attemptId)).toThrow()
    const loaded = new DictionaryStore(f.path).get(waiting.encounterId)
    if (operation === 'delete') expect(loaded).toBeNull()
    else { expect(loaded!.explanations).toEqual([]); expect(loaded!.attempts[0].status).toBe(operation === 'close' ? 'interrupted' : 'cancelled') }
    expect(f.provider).toHaveBeenCalledTimes(1)
  })
  it.each(['{broken', '{"schemaVersion":90,"future":"keep"}'])('keeps corrupt/unknown original bytes and makes zero provider requests', raw => {
    const f = fixture({ raw })
    expect(f.store.warning).toContain('只读')
    expect(() => f.request()).toThrow('只读'); expect(f.provider).not.toHaveBeenCalled()
    expect(readFileSync(f.file, 'utf8')).toBe(raw)
  })
  it('recovers both dispatch states as Interrupted without repeating requests or touching old favorite files', () => {
    const notStarted = fixture(); fault.failAt = fault.renames + 2
    const first = notStarted.request()
    const started = fixture(), second = started.request(); started.learning.close()
    for (const [f, state, dispatch] of [[notStarted, first, 'not_started'], [started, second, 'may_have_started']] as const) {
      writeFileSync(join(f.path, 'saved.json'), 'old saved bytes'); writeFileSync(join(f.path, 'learning-v1.json'), 'old metadata bytes')
      const restored = new DictionaryStore(f.path), provider = vi.fn(() => Promise.resolve(result()))
      const learning = new DictionaryLearning(restored, () => [], descriptor, provider, vi.fn())
      expect(learning.get(state.encounterId)?.run).toMatchObject({ state: 'interrupted', dispatchState: dispatch })
      expect(provider).not.toHaveBeenCalled()
      expect(readFileSync(join(f.path, 'saved.json'), 'utf8')).toBe('old saved bytes')
      expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).toBe('old metadata bytes')
      learning.close()
    }
  })
})

describe('explicit recall, reveal, rating and scoped undo', () => {
  it('returns answer-free review cards and records neither opening, revealing, skipping nor exit', async () => {
    const f = fixture(); await seed(f, 2)
    const calls = f.provider.mock.calls.length, review = f.learning.startReview(1)
    const text = JSON.stringify(review)
    expect(text).not.toMatch(/HIDDEN-MEANING|HIDDEN-USAGE|ANSWER-NOTE|contextMeaning|examples|translations/)
    expect(f.store.exportSnapshot().reviews).toEqual([])
    const card = review.cards[0], revealed = f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
    expect(revealed.explanation.providerKind === 'llm-generated' && revealed.explanation.content.contextMeaning).toBe('SYNTHETIC-HIDDEN-MEANING')
    expect(f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId).revealId).toBe(revealed.revealId)
    f.learning.skip(1, review.sessionId); f.learning.endReview(1, review.sessionId)
    expect(f.store.exportSnapshot().reviews).toEqual([]); expect(f.provider).toHaveBeenCalledTimes(calls)
  })
  it('requires an owner-scoped current revealed answer and makes a double-rating token idempotent', async () => {
    const f = fixture(); await seed(f, 2)
    const review = f.learning.startReview(1), card = review.cards[0]
    expect(() => f.learning.rate(1, review.sessionId, 'forged', 'recalled')).toThrow('揭示')
    expect(() => f.learning.reveal(2, review.sessionId, card.encounterId, card.explanationId)).toThrow('会话')
    expect(() => f.learning.reveal(1, review.sessionId, review.cards[1].encounterId, review.cards[1].explanationId)).toThrow('当前')
    const revealed = f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
    const rated = f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')
    expect(rated).toMatchObject({ completed: 1, cursor: 1 })
    expect(f.learning.rate(1, review.sessionId, revealed.revealId, 'not_recalled')).toEqual(rated)
    expect(f.store.exportSnapshot().reviews).toHaveLength(1)
    expect(f.store.exportSnapshot().reviews[0]).toMatchObject({ encounterId: card.encounterId, explanationId: card.explanationId, response: 'recalled' })
  })
  it('rates the actual saved version selected for review even when a later explanation is appended', async () => {
    const f = fixture(), [encounterId] = await seed(f)
    const review = f.learning.startReview(1), card = review.cards[0], handle = f.learning.openEncounter(1, encounterId)
    f.learning.explain(1, { handle: handle.handle!, encounterId, span: phrase, language: 'ja' }); await complete(f)
    expect(f.store.get(encounterId)!.explanations).toHaveLength(2)
    const revealed = f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
    expect(revealed.explanation.version).toBe(1)
    f.learning.rate(1, review.sessionId, revealed.revealId, 'not_recalled')
    expect(f.store.exportSnapshot().reviews[0].explanationId).toBe(card.explanationId)
  })
  it('does not increment counts or move past an answer when its self-report write fails', async () => {
    const f = fixture(); await seed(f)
    const review = f.learning.startReview(1), card = review.cards[0], revealed = f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
    fault.failAt = fault.renames + 1
    expect(() => f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')).toThrow('写入失败')
    expect(f.learning.reviewState(1, review.sessionId)).toMatchObject({ completed: 0, cursor: 0, lastEventId: null })
    expect(f.store.exportSnapshot().reviews).toEqual([])
    expect(f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')).toMatchObject({ completed: 1, cursor: 1 })
  })
  it('undo affects only the latest actual rating in this session and repeated undo cannot remove an earlier event', async () => {
    const f = fixture(); await seed(f, 3)
    const review = f.learning.startReview(1), firstCard = review.cards[0]
    const firstReveal = f.learning.reveal(1, review.sessionId, firstCard.encounterId, firstCard.explanationId)
    const first = f.learning.rate(1, review.sessionId, firstReveal.revealId, 'recalled')
    const secondCard = review.cards[1], secondReveal = f.learning.reveal(1, review.sessionId, secondCard.encounterId, secondCard.explanationId)
    const second = f.learning.rate(1, review.sessionId, secondReveal.revealId, 'not_recalled')
    expect(() => f.learning.undo(2, review.sessionId, second.lastEventId)).toThrow('会话')
    expect(() => f.learning.undo(1, review.sessionId, first.lastEventId)).toThrow('最近一次')
    const undone = f.learning.undo(1, review.sessionId, second.lastEventId)
    expect(undone).toMatchObject({ completed: 1, cursor: 1, lastEventId: first.lastEventId })
    expect(f.learning.undo(1, review.sessionId, second.lastEventId)).toEqual(undone)
    expect(f.learning.rate(1, review.sessionId, secondReveal.revealId, 'recalled')).toEqual(undone)
    expect(f.store.exportSnapshot().reviews.map(event => event.id)).toEqual([first.lastEventId])
    const replacement = f.learning.startReview(1)
    expect(replacement.sessionId).not.toBe(review.sessionId)
    expect(() => f.learning.undo(1, review.sessionId, first.lastEventId)).toThrow('会话')
  })
  it('a failed undo preserves the count/cursor and permits one explicit retry', async () => {
    const f = fixture(); await seed(f)
    const review = f.learning.startReview(1), card = review.cards[0], revealed = f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
    const rated = f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')
    fault.failAt = fault.renames + 1
    expect(() => f.learning.undo(1, review.sessionId, rated.lastEventId)).toThrow('写入失败')
    expect(f.learning.reviewState(1, review.sessionId)).toEqual(rated)
    expect(f.store.exportSnapshot().reviews).toHaveLength(1)
    expect(f.learning.undo(1, review.sessionId, rated.lastEventId)).toMatchObject({ completed: 0, cursor: 0, lastEventId: null })
  })
  it('deleting a previously reviewed card preserves the next retained card instead of skipping it', async () => {
    const f = fixture(); await seed(f, 3)
    const review = f.learning.startReview(1), first = review.cards[0]
    const revealed = f.learning.reveal(1, review.sessionId, first.encounterId, first.explanationId)
    f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')
    f.learning.remove(first.encounterId)
    const next = f.learning.reviewState(1, review.sessionId)
    expect(next.cards[next.cursor].encounterId).toBe(review.cards[1].encounterId)
    expect(next.completed).toBe(0); expect(f.store.exportSnapshot().reviews).toEqual([])
  })
  it('reindexes undo anchors after an earlier card is deleted', async () => {
    const f = fixture(); await seed(f, 3)
    const review = f.learning.startReview(1)
    for (const card of review.cards.slice(0, 2)) {
      const revealed = f.learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
      f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')
    }
    f.learning.remove(review.cards[0].encounterId)
    const current = f.learning.reviewState(1, review.sessionId)
    const undone = f.learning.undo(1, review.sessionId, current.lastEventId)
    expect(undone.cards[undone.cursor].encounterId).toBe(review.cards[1].encounterId)
    expect(undone.completed).toBe(0)
  })
  it('rejects a removed/unfavorited answer and does not create an event on skip or later stale rating', async () => {
    const f = fixture(), ids = await seed(f, 2)
    const review = f.learning.startReview(1), first = review.cards[0]
    f.learning.edit(ids[0], { favorite: false })
    expect(() => f.learning.reveal(1, review.sessionId, first.encounterId, first.explanationId)).toThrow('变化')
    f.learning.skip(1, review.sessionId)
    const second = review.cards[1], revealed = f.learning.reveal(1, review.sessionId, second.encounterId, second.explanationId)
    f.learning.remove(second.encounterId)
    expect(() => f.learning.rate(1, review.sessionId, revealed.revealId, 'recalled')).toThrow()
    expect(f.store.exportSnapshot().reviews).toEqual([])
  })
})
