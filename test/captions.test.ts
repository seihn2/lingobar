import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionQueue } from '../src/main/captions'
import type { Caption } from '../src/shared/types'
import type { CaptionTranslation, TranslationConfig, translateCaption } from '../src/main/translation'
import type { TargetLanguage } from '../src/shared/languages'
import type { annotateJapanese, JapaneseAnnotation } from '../src/main/japanese'
import { trace } from '../src/main/diagnostics'

vi.mock('electron', () => { throw new Error('Pure caption tests must not load Electron or its installer') })
vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))

const config = { baseUrl: 'https://example.test/v1', model: 'translation-test', apiKey: 'test-key', generateFurigana: false }
const translation = (text: string): CaptionTranslation => ({ language: '英语', translations: { zh: `中文 ${text}`, en: text, ja: `日本語 ${text}` }, zh: `中文 ${text}`, en: text, ja: `日本語 ${text}`, reading: `にほんご ${text}`, jaSegments: [{ text: '日本語', reading: 'にほんご' }, { text: ` ${text}` }] })
const selectedTranslation = (translations: Partial<Record<TargetLanguage, string>>): CaptionTranslation => ({
  language: '英语', translations, zh: translations.zh || '', en: translations.en || '', ja: translations.ja || '', reading: ''
})
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred() {
  let resolve!: (value: CaptionTranslation) => void
  let reject!: (error: Error) => void
  const promise = new Promise<CaptionTranslation>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function deferredAnnotation() {
  let resolve!: (value: JapaneseAnnotation) => void
  let reject!: (error: Error) => void
  const promise = new Promise<JapaneseAnnotation>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const annotation = (reading = 'にほんご'): JapaneseAnnotation => ({ reading, jaSegments: [{ text: '日本語', reading }] })

afterEach(() => vi.useRealTimers())

function savedCaption(id = 'saved-1'): Caption {
  return { id, source: 'system', original: 'saved source', ...translation('saved source'), createdAt: 1000, status: 'ready', saved: true }
}

describe('CaptionQueue', () => {
  it('keeps source order when parallel translations finish in reverse order, and drains waiting work', async () => {
    const work = [deferred(), deferred(), deferred()]
    const translator = vi.fn<typeof translateCaption>()
    work.forEach(job => translator.mockImplementationOnce(() => job.promise))
    const queue = new CaptionQueue([], () => config, vi.fn(), vi.fn(), translator)
    queue.add('first', 'system')
    queue.add('second', 'microphone')
    queue.add('third', 'system')
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    work[1].resolve(translation('second'))
    await settle()
    expect(translator).toHaveBeenCalledTimes(3)
    expect(queue.captions.map(c => [c.original, c.status])).toEqual([
      ['first', 'translating'], ['second', 'ready'], ['third', 'translating']
    ])
    work[2].resolve(translation('third'))
    work[0].resolve(translation('first'))
    await settle()
    expect(queue.captions.map(c => [c.original, c.en, c.source])).toEqual([
      ['first', 'first', 'system'], ['second', 'second', 'microphone'], ['third', 'third', 'system']
    ])
  })

  it('aborts active work and ignores stale resolution or rejection after close', async () => {
    const success = deferred()
    const failure = deferred()
    const translator = vi.fn<typeof translateCaption>()
      .mockImplementationOnce(() => success.promise).mockImplementationOnce(() => failure.promise)
    const changed = vi.fn()
    const queue = new CaptionQueue([], () => config, changed, vi.fn(), translator)
    queue.add('first', 'system'); queue.add('second', 'system'); queue.add('waiting', 'system')
    await settle()
    queue.close()
    expect(translator.mock.calls.every(([, , signal]) => signal?.aborted)).toBe(true)
    changed.mockClear()
    success.resolve(translation('stale result'))
    failure.reject(new Error('stale failure'))
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(changed).not.toHaveBeenCalled()
    expect(queue.captions.every(c => c.status === 'translating' && c.en === '')).toBe(true)
  })

  it('retains failed originals and retries the same caption once with current configuration', async () => {
    let current = config
    const translator = vi.fn<typeof translateCaption>().mockRejectedValueOnce(new Error('请检查翻译设置'))
      .mockResolvedValueOnce(translation('retained original'))
    const queue = new CaptionQueue([], () => current, vi.fn(), vi.fn(), translator)
    queue.add('retained original', 'text')
    await settle()
    const id = queue.captions[0].id
    expect(queue.captions[0]).toMatchObject({ status: 'error', error: '请检查翻译设置', original: 'retained original' })
    current = { ...config, model: 'reconfigured-model' }
    queue.retry(id); queue.retry(id)
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls[1][1].model).toBe('reconfigured-model')
    expect(queue.captions).toHaveLength(1)
    expect(queue.captions[0]).toMatchObject({ id, status: 'ready', original: 'retained original', en: 'retained original' })
    expect(queue.captions[0]).not.toHaveProperty('error')
  })

  it('preserves an overloaded caption as retryable original instead of silently deleting it', async () => {
    const jobs: ReturnType<typeof deferred>[] = []
    const translator = vi.fn<typeof translateCaption>().mockImplementation(() => {
      const job = deferred(); jobs.push(job); return job.promise
    })
    const queue = new CaptionQueue([], () => config, vi.fn(), vi.fn(), translator)
    for (let i = 0; i < 23; i++) queue.add(`caption ${i}`, 'system')
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(queue.captions[2]).toMatchObject({ original: 'caption 2', status: 'error' })
    expect(queue.captions[2].error).toContain('原文已保留')
    queue.close()
    jobs.forEach(job => job.resolve(translation('closed')))
    await settle()
  })

  it('persists saving and unsaving ready history, while protecting saved captions during retention', async () => {
    const old = savedCaption()
    const persist = vi.fn()
    const queue = new CaptionQueue([old], () => config, vi.fn(), persist, vi.fn<typeof translateCaption>().mockResolvedValue(translation('new')))
    for (let i = 0; i < 152; i++) {
      queue.add(`new ${i}`, 'text')
      await settle()
    }
    expect(queue.captions).toHaveLength(151)
    expect(queue.captions[0]).toEqual(old)
    const recent = queue.captions.at(-1)!
    queue.toggleSaved(recent.id)
    expect(recent.saved).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    queue.toggleSaved(old.id)
    expect(old.saved).toBe(false)
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('does not save unfinished or failed captions', async () => {
    const work = deferred()
    const persist = vi.fn()
    const queue = new CaptionQueue([], () => config, vi.fn(), persist, () => work.promise)
    queue.add('not yet translated', 'text')
    const id = queue.captions[0].id
    queue.toggleSaved(id)
    work.reject(new Error('翻译失败'))
    await settle()
    queue.toggleSaved(id)
    expect(persist).not.toHaveBeenCalled()
    expect(queue.captions[0].saved).toBe(false)
  })

  it('keeps saved state unchanged if persisting the toggle fails', () => {
    const saved = savedCaption()
    const changed = vi.fn()
    const queue = new CaptionQueue([saved], () => config, changed, () => { throw new Error('disk full') })
    expect(() => queue.toggleSaved(saved.id)).toThrow('disk full')
    expect(saved.saved).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps queued target languages and provider settings from enqueue time when settings change', async () => {
    const targets: TargetLanguage[] = ['en']
    let current: TranslationConfig = { ...config, targetLanguages: targets }
    const work = [deferred(), deferred(), deferred(), deferred()]
    const translator = vi.fn<typeof translateCaption>()
    work.forEach(job => translator.mockImplementationOnce(() => job.promise))
    const queue = new CaptionQueue([], () => current, vi.fn(), vi.fn(), translator)
    queue.add('first', 'text'); queue.add('second', 'text'); queue.add('queued before change', 'text')
    await settle()
    targets.splice(0, targets.length, 'fr')
    current = { ...current, model: 'new-model', baseUrl: 'https://new.example.test/v1' }
    queue.add('queued after change', 'text')
    work[0].resolve(selectedTranslation({ en: 'first' }))
    await settle()
    expect(translator.mock.calls[0][1].targetLanguages).toEqual(['en'])
    expect(translator.mock.calls[2][1]).toMatchObject({ targetLanguages: ['en'], model: config.model, baseUrl: config.baseUrl })
    work[1].resolve(selectedTranslation({ en: 'second' }))
    await settle()
    expect(translator.mock.calls[3][1]).toMatchObject({ targetLanguages: ['fr'], model: 'new-model', baseUrl: 'https://new.example.test/v1' })
    work[2].resolve(selectedTranslation({ en: 'queued before change' }))
    work[3].resolve(selectedTranslation({ fr: 'nouvelle traduction' }))
    await settle()
    expect(queue.captions[2].translations).toEqual({ en: 'queued before change' })
    expect(queue.captions[3].translations).toEqual({ fr: 'nouvelle traduction' })
  })

  it('retranslates a ready caption into new targets while preserving previous translations and furigana', async () => {
    const original = { ...savedCaption(), saved: false }
    const previous = structuredClone(original)
    const translator = vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ fr: 'ancienne phrase', de: 'alter Satz' }))
    const queue = new CaptionQueue([original], () => ({ ...config, targetLanguages: ['fr', 'de'] }), vi.fn(), vi.fn(), translator)
    queue.retry(original.id)
    queue.retry(original.id)
    await settle()
    expect(translator).toHaveBeenCalledTimes(1)
    expect(translator.mock.calls[0][1].targetLanguages).toEqual(['fr', 'de'])
    expect(queue.captions).toHaveLength(1)
    expect(original).toMatchObject({ id: previous.id, original: previous.original, createdAt: previous.createdAt, status: 'ready' })
    expect(original.translations).toEqual({ ...previous.translations, fr: 'ancienne phrase', de: 'alter Satz' })
    expect(original.zh).toBe(previous.zh)
    expect(original.en).toBe(previous.en)
    expect(original.ja).toBe(previous.ja)
    expect(original.reading).toBe(previous.reading)
    expect(original.jaSegments).toEqual(previous.jaSegments)
  })

  it('retains previous saved translations on retranslation failure while exposing a retryable error', async () => {
    const original = savedCaption()
    const previous = structuredClone(original)
    const persist = vi.fn()
    const translator = vi.fn<typeof translateCaption>().mockRejectedValue(new Error('服务暂时不可用'))
    const queue = new CaptionQueue([original], () => ({ ...config, targetLanguages: ['fr'] }), vi.fn(), persist, translator)
    queue.retry(original.id)
    await settle()
    expect(translator).toHaveBeenCalledTimes(1)
    expect(original).toMatchObject({ status: 'error', error: '服务暂时不可用', saved: true, original: previous.original })
    expect(original.translations).toEqual(previous.translations)
    expect(original.jaSegments).toEqual(previous.jaSegments)
    expect(original.reading).toBe(previous.reading)
    expect(persist).not.toHaveBeenCalled()
  })

  it('persists successful retranslation of a saved caption with merged historical languages', async () => {
    const original = savedCaption()
    const previous = structuredClone(original)
    const persisted: Caption[][] = []
    const persist = vi.fn((captions: Caption[]) => { persisted.push(structuredClone(captions)) })
    const translator = vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ fr: 'traduction conservée' }))
    const queue = new CaptionQueue([original], () => ({ ...config, targetLanguages: ['fr'] }), vi.fn(), persist, translator)
    queue.retry(original.id)
    await settle()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persisted[0]).toHaveLength(1)
    expect(persisted[0][0]).toMatchObject({ id: original.id, saved: true, status: 'ready', translations: { ...previous.translations, fr: 'traduction conservée' } })
    expect(persisted[0][0].jaSegments).toEqual(previous.jaSegments)
  })

  it('publishes and saves valid translations while LLM annotation is still pending', async () => {
    const work = deferredAnnotation()
    const annotator = vi.fn<typeof annotateJapanese>().mockImplementation(() => work.promise)
    const snapshots: Caption[][] = []
    const original = savedCaption()
    const queue = new CaptionQueue([original], () => ({ ...config, generateFurigana: true }), vi.fn(),
      captions => snapshots.push(structuredClone(captions)),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語', zh: '日语' })), annotator)
    queue.retry(original.id)
    await settle()
    expect(original).toMatchObject({ status: 'ready', furiganaStatus: 'pending', ja: '日本語', zh: '日语' })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0][0]).toMatchObject({ status: 'ready', saved: true, ja: '日本語' })
    work.resolve(annotation())
    await settle()
    expect(original).toMatchObject({ status: 'ready', furiganaStatus: 'ready', ...annotation() })
    expect(snapshots).toHaveLength(2)
    queue.close()
  })

  it('keeps translations readable when the optional annotation fails', async () => {
    const work = deferredAnnotation()
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), vi.fn(), vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語', zh: '日语' })),
      () => work.promise)
    queue.add('Japanese', 'system')
    await settle()
    expect(queue.captions[0].furiganaStatus).toBe('pending')
    work.reject(new Error('bad annotation'))
    await settle()
    expect(queue.captions[0]).toMatchObject({ status: 'ready', furiganaStatus: 'error', ja: '日本語', zh: '日语' })
    expect(queue.captions[0].error).toBeUndefined()
    queue.close()
  })

  it('does not generate LLM annotation when the user disabled furigana', async () => {
    const annotator = vi.fn<typeof annotateJapanese>()
    const queue = new CaptionQueue([], () => config, vi.fn(), vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    queue.add('Japanese', 'system')
    await settle()
    expect(annotator).not.toHaveBeenCalled()
    expect(queue.captions[0]).toMatchObject({ status: 'ready', ja: '日本語' })
    expect(queue.captions[0]).not.toHaveProperty('furiganaStatus')
    queue.close()
  })

  it('ignores stale annotation after retry even if the Japanese text is identical', async () => {
    const work = [deferredAnnotation(), deferredAnnotation()]
    const annotator = vi.fn<typeof annotateJapanese>()
      .mockImplementationOnce(() => work[0].promise).mockImplementationOnce(() => work[1].promise)
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), vi.fn(), vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    queue.add('Japanese', 'text')
    await settle()
    const caption = queue.captions[0]
    queue.retry(caption.id)
    await settle()
    expect(annotator).toHaveBeenCalledTimes(2)
    expect(annotator.mock.calls[0][3]?.aborted).toBe(true)
    work[0].resolve(annotation('ふるい'))
    await settle()
    expect(caption).toMatchObject({ status: 'ready', furiganaStatus: 'pending', reading: '' })
    work[1].resolve(annotation())
    await settle()
    expect(caption).toMatchObject({ furiganaStatus: 'ready', ...annotation() })
    queue.close()
  })

  it.each(['pending', 'ready'] as const)('reuses %s annotation when ASR returns to the same translated snapshot', async status => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(0)
    const work = deferredAnnotation()
    const annotator = vi.fn<typeof annotateJapanese>().mockImplementation(() => work.promise)
    const translator = vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' }))
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), vi.fn(), vi.fn(), translator, annotator)
    queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(650)
    if (status === 'ready') { work.resolve(annotation()); await settle() }
    expect(queue.captions[0].furiganaStatus).toBe(status)
    // A speculative ASR correction is coalesced back to the same source before translation starts.
    queue.updatePartial('Japanese language', 'system')
    queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(1100)
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls.map(([original]) => original)).toEqual(['Japanese', 'Japanese'])
    expect(annotator).toHaveBeenCalledTimes(1)
    expect(annotator.mock.calls[0][3]?.aborted).toBe(false)
    expect(queue.captions[0].furiganaStatus).toBe(status)
    work.resolve(annotation())
    await settle()
    expect(queue.captions[0]).toMatchObject({ furiganaStatus: 'ready', ...annotation() })
    queue.close()
  })

  it.each(['original', 'japanese', 'baseUrl', 'model', 'apiKey'] as const)('replaces annotation when its %s input changes', async input => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(0)
    let current: TranslationConfig = { ...config, generateFurigana: true }
    const work = [deferredAnnotation(), deferredAnnotation()]
    const annotator = vi.fn<typeof annotateJapanese>()
      .mockImplementationOnce(() => work[0].promise).mockImplementationOnce(() => work[1].promise)
    const translator = vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' }))
    const queue = new CaptionQueue([], () => current, vi.fn(), vi.fn(), translator, annotator)
    queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(650)
    if (input === 'baseUrl') current = { ...current, baseUrl: 'https://second.example.test/v1' }
    if (input === 'model') current = { ...current, model: 'second-model' }
    if (input === 'apiKey') current = { ...current, apiKey: 'second-test-key' }
    if (input === 'japanese') translator.mockResolvedValue(selectedTranslation({ ja: '日本語です' }))
    queue.updatePartial('Japanese language', 'system')
    if (input !== 'original') queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(1100)
    expect(annotator).toHaveBeenCalledTimes(2)
    expect(annotator.mock.calls[0][3]?.aborted).toBe(true)
    annotator.mock.calls[0][4]?.(annotation('ふるい'))
    work[0].resolve(annotation('ふるい'))
    await settle()
    expect(queue.captions[0]).toMatchObject({ furiganaStatus: 'pending', reading: '' })
    queue.close()
  })

  it('reuses pending annotation across target changes and finalization without extending its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(0)
    let current: TranslationConfig = { ...config, generateFurigana: true, targetLanguages: ['ja'] }
    const work = deferredAnnotation()
    const annotator = vi.fn<typeof annotateJapanese>().mockImplementation(() => work.promise)
    const queue = new CaptionQueue([], () => current, vi.fn(), vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(650)
    await vi.advanceTimersByTimeAsync(20_000)
    current = { ...current, targetLanguages: ['ja', 'fr'] }
    queue.finishSentence('Japanese', 'system')
    await settle()
    expect(annotator).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(annotator.mock.calls[0][3]?.aborted).toBe(true)
    expect(queue.captions[0]).toMatchObject({ status: 'ready', furiganaStatus: 'error' })
    annotator.mock.calls[0][4]?.(annotation('おそい'))
    expect(queue.captions[0].reading).toBe('')
    queue.close()
  })

  it('explicitly retries a completed annotation even when its inputs are unchanged', async () => {
    const annotator = vi.fn<typeof annotateJapanese>().mockResolvedValue(annotation())
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), vi.fn(), vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    queue.add('Japanese', 'text')
    await settle()
    queue.retry(queue.captions[0].id)
    await settle()
    expect(annotator).toHaveBeenCalledTimes(2)
    queue.close()
  })

  it('publishes annotation progress before completion and ignores progress after retry or close', async () => {
    vi.mocked(trace).mockClear()
    const work = [deferredAnnotation(), deferredAnnotation()]
    const annotator = vi.fn<typeof annotateJapanese>()
      .mockImplementationOnce(() => work[0].promise).mockImplementationOnce(() => work[1].promise)
    const changed = vi.fn()
    const persist = vi.fn()
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), changed, persist,
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    queue.add('Japanese', 'text')
    await settle()
    const caption = queue.captions[0]
    queue.toggleSaved(caption.id)
    changed.mockClear(); persist.mockClear()
    expect(annotator.mock.calls[0][4]).toBeTypeOf('function')
    annotator.mock.calls[0][4]?.(annotation('にほん'))
    expect(caption).toMatchObject({ furiganaStatus: 'pending', ...annotation('にほん') })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(persist).not.toHaveBeenCalled()
    queue.retry(caption.id)
    await settle()
    annotator.mock.calls[0][4]?.(annotation('ふるい'))
    expect(caption.reading).not.toBe('ふるい')
    annotator.mock.calls[1][4]?.(annotation())
    expect(caption).toMatchObject({ furiganaStatus: 'pending', ...annotation() })
    work[1].resolve(annotation())
    await settle()
    expect(caption).toMatchObject({ furiganaStatus: 'ready', ...annotation() })
    expect(persist).toHaveBeenCalledTimes(2)
    queue.close()
    changed.mockClear()
    annotator.mock.calls[1][4]?.(annotation('おそい'))
    work[0].resolve(annotation('ふるい'))
    await settle()
    expect(caption.reading).toBe('にほんご')
    expect(changed).not.toHaveBeenCalled()
    const annotationEvents = vi.mocked(trace).mock.calls.filter(([event]) => event.startsWith('annotation.'))
    expect(annotationEvents.map(([event]) => event)).toEqual([
      'annotation.start', 'annotation.progress', 'annotation.cancelled', 'annotation.start', 'annotation.progress', 'annotation.ready'
    ])
    expect(annotationEvents[0][1]).toMatchObject({ sourceChars: 8, chars: 3, queueMs: expect.any(Number) })
    expect(annotationEvents[1][1]).toMatchObject({ firstProgressMs: expect.any(Number) })
    for (const value of ['Japanese', '日本語', 'にほん', config.baseUrl, config.apiKey, config.model]) {
      expect(JSON.stringify(annotationEvents)).not.toContain(value)
    }
  })

  it('bounds queued plus running annotation time to 25 seconds without losing translations', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const work = [deferredAnnotation(), deferredAnnotation(), deferredAnnotation()]
    const annotator = vi.fn<typeof annotateJapanese>()
    work.forEach(job => annotator.mockImplementationOnce(() => job.promise))
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), vi.fn(), vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    for (const text of ['first', 'second', 'third']) queue.add(text, 'system')
    await settle()
    expect(annotator).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000)
    work[0].resolve(annotation())
    await settle()
    expect(annotator).toHaveBeenCalledTimes(3)
    expect(queue.captions[2].furiganaStatus).toBe('pending')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(queue.captions.map(c => c.furiganaStatus)).toEqual(['ready', 'error', 'error'])
    expect(queue.captions.every(c => c.status === 'ready' && c.ja === '日本語')).toBe(true)
    expect(annotator.mock.calls.slice(1).every(([, , , signal]) => signal?.aborted)).toBe(true)
    work[1].resolve(annotation('おそい'))
    work[2].reject(new Error('late failure'))
    await settle()
    expect(queue.captions.map(c => c.furiganaStatus)).toEqual(['ready', 'error', 'error'])
    expect(vi.getTimerCount()).toBe(0)
    queue.close()
  })

  it('retains pending annotation beyond the history limit and publishes its terminal state before eviction', async () => {
    const work = deferredAnnotation()
    const observed: Array<Caption['furiganaStatus']> = []
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }),
      () => { const caption = queue.captions.find(c => c.original === 'pending'); if (caption) observed.push(caption.furiganaStatus) },
      vi.fn(), vi.fn<typeof translateCaption>().mockImplementation(async text => selectedTranslation(text === 'pending' ? { ja: '日本語' } : { en: text })),
      () => work.promise)
    queue.add('pending', 'system')
    await settle()
    for (let i = 0; i < 152; i++) { queue.add(`ready ${i}`, 'system'); await settle() }
    expect(queue.captions).toHaveLength(151)
    expect(queue.captions[0]).toMatchObject({ original: 'pending', furiganaStatus: 'pending' })
    work.resolve(annotation())
    await settle()
    expect(observed.at(-1)).toBe('ready')
    queue.add('final', 'system')
    await settle()
    expect(queue.captions).toHaveLength(150)
    expect(queue.captions.some(c => c.original === 'pending')).toBe(false)
    queue.close()
  })

  it('aborts annotation on close and ignores late output', async () => {
    const work = deferredAnnotation()
    const annotator = vi.fn<typeof annotateJapanese>().mockImplementation(() => work.promise)
    const changed = vi.fn()
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), changed, vi.fn(),
      vi.fn<typeof translateCaption>().mockResolvedValue(selectedTranslation({ ja: '日本語' })), annotator)
    queue.add('Japanese', 'system')
    await settle()
    queue.close()
    changed.mockClear()
    expect(annotator.mock.calls[0][3]?.aborted).toBe(true)
    work.resolve(annotation())
    await settle()
    expect(changed).not.toHaveBeenCalled()
    expect(queue.captions[0].reading).toBe('')
    expect(queue.captions[0].furiganaStatus).toBe('error')
  })
})
