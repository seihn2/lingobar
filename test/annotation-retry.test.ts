import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptionQueue } from '../src/shared/caption-queue'
import type { Caption } from '../src/shared/types'
import type { TranslationConfig, translateCaption } from '../src/main/translation'
import type { JapaneseAnnotation, annotateJapanese } from '../src/main/japanese'

vi.mock('electron', () => { throw new Error('Annotation-only retry must not load Electron') })
vi.mock('ws', () => { throw new Error('Annotation-only retry must not load ASR sockets') })
const settle = async () => { for (let count = 0; count < 60; count++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const caption = (overrides: Partial<Caption> = {}): Caption => ({ id: 'saved-synthetic', source: 'text', original: 'Synthetic finalized source',
  translatedOriginal: 'Synthetic finalized source', translations: { ja: '生物', en: 'Synthetic historical translation' }, targetLanguages: ['ja', 'en'],
  language: '英语', zh: '', en: 'Synthetic historical translation', ja: '生物', reading: '', createdAt: 1000,
  status: 'ready', saved: true, furiganaStatus: 'error', ...overrides })
const annotation = (reading = 'せいぶつ'): JapaneseAnnotation => ({ reading, jaSegments: [{ text: '生物', reading }] })
function stable(value: Caption) {
  const { reading: _reading, jaSegments: _segments, furiganaStatus: _state, ...rest } = value
  return structuredClone(rest)
}
type Job = ReturnType<typeof deferred<JapaneseAnnotation>> & { original: string; japanese: string; signal: AbortSignal }
const fixtures: Array<{ queue: CaptionQueue; jobs: Job[]; translator: ReturnType<typeof vi.fn<typeof translateCaption>> }> = []
function fixture(value = caption(), translate?: typeof translateCaption) {
  const jobs: Job[] = [], persist = vi.fn(), changed = vi.fn()
  let current: TranslationConfig = { baseUrl: 'https://synthetic.invalid', model: 'synthetic-annotation', apiKey: 'synthetic-only', targetLanguages: ['ja'], generateFurigana: true }
  const translator = vi.fn<typeof translateCaption>(translate || (() => { throw new Error('Retranslation forbidden in annotation-only retry') }))
  const annotator = vi.fn<typeof annotateJapanese>((original, japanese, _config, signal) => {
    const job = { ...deferred<JapaneseAnnotation>(), original, japanese, signal: signal! }; jobs.push(job); return job.promise
  })
  const queue = new CaptionQueue([value], () => current, changed, persist, translator, annotator)
  const result = { queue, jobs, translator, annotator, persist, changed, value, settings: (input: Partial<TranslationConfig>) => { current = { ...current, ...input } } }
  fixtures.push(result); return result
}
const network = vi.fn(() => { throw new Error('Real network forbidden in annotation retry tests') })
beforeEach(() => { vi.useFakeTimers(); network.mockClear(); vi.stubGlobal('fetch', network) })
afterEach(async () => {
  for (const f of fixtures) { f.queue.close(); for (const job of f.jobs) job.reject(new Error('Synthetic cleanup')) }
  await settle(); fixtures.length = 0
  expect(network).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('annotation-only caption retries', () => {
  it('retries saved ready Japanese with only the annotator, coalesces pending clicks and persists updated ruby', async () => {
    const f = fixture(), before = stable(f.value)
    f.queue.retryAnnotation(f.value.id); f.queue.retryAnnotation(f.value.id); await settle()
    expect(f.translator).not.toHaveBeenCalled(); expect(f.annotator).toHaveBeenCalledOnce()
    expect(f.jobs[0]).toMatchObject({ original: f.value.original, japanese: '生物' })
    expect(f.value.furiganaStatus).toBe('pending'); expect(stable(f.value)).toEqual(before)
    f.jobs[0].resolve(annotation()); await settle()
    expect(f.value).toMatchObject({ furiganaStatus: 'ready', ...annotation(), saved: true, status: 'ready' })
    expect(stable(f.value)).toEqual(before); expect(f.persist).toHaveBeenCalledOnce()
  })

  it('rejects unsettled, unavailable or source-misaligned captions and disabled Japanese settings without work', async () => {
    for (const overrides of [{ live: true }, { translationPending: true }, { status: 'error' }, { status: 'translating' },
      { ja: '', translations: { en: 'Synthetic English only' } }, { ja: '学校', translations: { ja: '生物' } },
      { translatedOriginal: 'Synthetic older prefix' }] satisfies Partial<Caption>[]) {
      const f = fixture(caption(overrides)), before = structuredClone(f.value)
      expect(() => f.queue.retryAnnotation(f.value.id)).toThrow('定稿')
      expect(f.annotator).not.toHaveBeenCalled(); expect(f.translator).not.toHaveBeenCalled(); expect(f.value).toEqual(before)
    }
    for (const settings of [{ generateFurigana: false }, { targetLanguages: ['en'] }] satisfies Partial<TranslationConfig>[]) {
      const f = fixture(), before = structuredClone(f.value); f.settings(settings)
      expect(() => f.queue.retryAnnotation(f.value.id)).toThrow('开启日语注音')
      expect(f.annotator).not.toHaveBeenCalled(); expect(f.translator).not.toHaveBeenCalled(); expect(f.value).toEqual(before)
    }
  })

  it('leaves a failed annotation independently retryable while keeping original, translations and favorite intact', async () => {
    const f = fixture(), before = stable(f.value)
    f.queue.retryAnnotation(f.value.id); await settle(); f.jobs[0].reject(new Error('Synthetic annotation failure')); await settle()
    expect(f.value).toMatchObject({ status: 'ready', furiganaStatus: 'error', saved: true }); expect(stable(f.value)).toEqual(before)
    expect(f.persist).not.toHaveBeenCalled()
    f.queue.retryAnnotation(f.value.id); await settle(); f.jobs[1].resolve(annotation()); await settle()
    expect(f.translator).not.toHaveBeenCalled(); expect(f.annotator).toHaveBeenCalledTimes(2)
    expect(f.value.furiganaStatus).toBe('ready'); expect(stable(f.value)).toEqual(before)
  })

  it('expires after25s, ignores late output and annotates the current exact source on retry', async () => {
    const f = fixture(), before = stable(f.value)
    f.queue.retryAnnotation(f.value.id); await settle(); await vi.advanceTimersByTimeAsync(25_000)
    expect(f.jobs[0].signal.aborted).toBe(true); expect(f.value.furiganaStatus).toBe('error'); expect(stable(f.value)).toEqual(before)
    f.jobs[0].resolve(annotation('ふるい')); await settle(); expect(f.value.reading).toBe('')
    f.settings({ model: 'new-annotation-model' }); f.queue.retryAnnotation(f.value.id); await settle()
    expect(f.annotator.mock.calls[1].slice(0, 2)).toEqual([f.value.original, f.value.ja])
    expect(f.annotator.mock.calls[1][2].model).toBe('new-annotation-model')
    f.jobs[1].resolve(annotation()); await settle()
    expect(f.value).toMatchObject({ furiganaStatus: 'ready', ...annotation() }); expect(stable(f.value)).toEqual(before)
    expect(f.translator).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('close cancels manual annotation and ignores late %s without changing caption content', async outcome => {
    const f = fixture(), before = stable(f.value)
    f.queue.retryAnnotation(f.value.id); await settle(); f.queue.close(); f.changed.mockClear()
    expect(f.jobs[0].signal.aborted).toBe(true); expect(f.value.furiganaStatus).toBe('error')
    if (outcome === 'success') f.jobs[0].resolve(annotation('ふるい'))
    else f.jobs[0].reject(new Error('Synthetic late failure'))
    await settle(); expect(f.changed).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled()
    expect(stable(f.value)).toEqual(before); expect(f.value.reading).toBe(''); expect(f.translator).not.toHaveBeenCalled()
  })

  it('rejects a retained-object source change even when Japanese is identical, then retries its current source', async () => {
    const f = fixture()
    f.queue.retryAnnotation(f.value.id); await settle()
    // Simulate a newer source snapshot on the retained caption; identical Japanese
    // alone must not authorize the older source's contextual reading.
    f.value.original = f.value.translatedOriginal = 'Synthetic revised finalized source'
    const revised = stable(f.value)
    f.jobs[0].resolve(annotation('なまもの')); await settle()
    expect(f.value.reading).toBe(''); expect(f.value.furiganaStatus).toBe('error'); expect(stable(f.value)).toEqual(revised)
    f.queue.retryAnnotation(f.value.id); await settle()
    expect(f.jobs[1]).toMatchObject({ original: 'Synthetic revised finalized source', japanese: '生物' })
    f.jobs[1].resolve(annotation()); await settle()
    expect(f.value).toMatchObject({ furiganaStatus: 'ready', ...annotation() }); expect(stable(f.value)).toEqual(revised)
    expect(f.translator).not.toHaveBeenCalled()
  })

  it('disabling the setting cancels manual work and prevents a new retry while preserving valid text', async () => {
    const f = fixture(), before = stable(f.value)
    f.queue.retryAnnotation(f.value.id); await settle(); f.settings({ generateFurigana: false }); f.queue.cancelAnnotationRetries()
    expect(f.jobs[0].signal.aborted).toBe(true); expect(f.value.furiganaStatus).toBe('error')
    expect(() => f.queue.retryAnnotation(f.value.id)).toThrow('开启日语注音')
    f.jobs[0].resolve(annotation('ふるい')); await settle()
    expect(f.value.reading).toBe(''); expect(stable(f.value)).toEqual(before); expect(f.translator).not.toHaveBeenCalled()
  })

  it('immediate cancellation stops the annotator before its deferred invocation', async () => {
    const f = fixture(), before = stable(f.value)
    f.queue.retryAnnotation(f.value.id); f.queue.cancelAnnotationRetries(); await settle()
    expect(f.annotator).not.toHaveBeenCalled(); expect(f.translator).not.toHaveBeenCalled()
    expect(f.value.furiganaStatus).toBe('error'); expect(stable(f.value)).toEqual(before)
  })

  it('cancels only manual retries while an independent automatic annotation remains owned and usable', async () => {
    const f = fixture(caption(), async () => ({ language: '英语', translations: { ja: '生物' }, zh: '', en: '', ja: '生物', reading: '' }))
    f.queue.add('Synthetic automatic source', 'text'); await settle()
    f.queue.retryAnnotation(f.value.id); await settle()
    expect(f.jobs.map(job => job.original)).toEqual(['Synthetic automatic source', f.value.original])
    f.queue.cancelAnnotationRetries()
    expect(f.jobs[0].signal.aborted).toBe(false); expect(f.jobs[1].signal.aborted).toBe(true)
    f.jobs[1].resolve(annotation('ふるい')); f.jobs[0].resolve(annotation()); await settle()
    expect(f.value).toMatchObject({ furiganaStatus: 'error', reading: '', saved: true, status: 'ready' })
    expect(f.queue.captions[1]).toMatchObject({ original: 'Synthetic automatic source', furiganaStatus: 'ready', ...annotation() })
    expect(f.translator).toHaveBeenCalledExactlyOnceWith('Synthetic automatic source', expect.any(Object), expect.any(AbortSignal))
  })
})
