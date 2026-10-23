import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionQueue } from '../src/main/captions'
import type { CaptionTranslation, TranslationConfig, translateCaption } from '../src/main/translation'
import type { annotateJapanese } from '../src/main/japanese'
import { trace } from '../src/main/diagnostics'

vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))

const config = { baseUrl: 'https://example.test/v1', model: 'test', apiKey: 'test-key', generateFurigana: false }
const translated = (text: string): CaptionTranslation => ({ language: '英语', translations: { en: text, zh: `中文 ${text}` }, en: text, zh: `中文 ${text}`, ja: '', reading: '' })
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred() {
  let resolve!: (value: CaptionTranslation) => void
  let reject!: (error: Error) => void
  const promise = new Promise<CaptionTranslation>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function timedQueue(translator = vi.fn<typeof translateCaption>().mockImplementation(async text => translated(text))) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(0)
  const queue = new CaptionQueue([], () => config, vi.fn(), vi.fn(), translator)
  return { queue, translator }
}

afterEach(() => vi.useRealTimers())

describe('incremental ASR caption translation', () => {
  it('starts before sentence_end, coalesces the first 650ms, and updates one caption id', async () => {
    const { queue, translator } = timedQueue()
    queue.updatePartial('Hello', 'system', 'utterance-1')
    const id = queue.captions[0].id
    await vi.advanceTimersByTimeAsync(300)
    queue.updatePartial('Hello world', 'system', 'utterance-1')
    await vi.advanceTimersByTimeAsync(349)
    expect(translator).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(translator).toHaveBeenCalledTimes(1)
    expect(translator.mock.calls[0][0]).toBe('Hello world')
    expect(translator.mock.calls[0][1].partial).toBe(true)
    expect(queue.captions).toHaveLength(1)
    expect(queue.captions[0]).toMatchObject({ id, live: true, status: 'ready', original: 'Hello world', translatedOriginal: 'Hello world', translationPending: false })
    queue.close()
  })

  it('throttles later requests to 1.1 seconds and sends only the newest accumulated text', async () => {
    const { queue, translator } = timedQueue()
    queue.updatePartial('Hello', 'system')
    await vi.advanceTimersByTimeAsync(650)
    await vi.advanceTimersByTimeAsync(50)
    queue.updatePartial('Hello one', 'system')
    await vi.advanceTimersByTimeAsync(400)
    queue.updatePartial('Hello one two', 'system')
    await vi.advanceTimersByTimeAsync(649)
    queue.updatePartial('Hello one two three', 'system')
    expect(translator).toHaveBeenCalledTimes(1)
    expect(queue.captions[0]).toMatchObject({ status: 'ready', translatedOriginal: 'Hello', translationPending: true })
    await vi.advanceTimersByTimeAsync(1)
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls[1][0]).toBe('Hello one two three')
    expect(queue.captions[0]).toMatchObject({ status: 'ready', live: true, translationPending: false, translatedOriginal: 'Hello one two three' })
    queue.close()
  })

  it('publishes a slow completed prefix while coalescing newer ASR without parallel calls for that caption', async () => {
    const first = deferred(), second = deferred()
    const translator = vi.fn<typeof translateCaption>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const { queue } = timedQueue(translator)
    queue.updatePartial('A short prefix', 'system')
    await vi.advanceTimersByTimeAsync(650)
    queue.updatePartial('A short prefix and more', 'system')
    await vi.advanceTimersByTimeAsync(1100)
    queue.updatePartial('A short prefix and more words', 'system')
    await vi.advanceTimersByTimeAsync(1)
    expect(translator).toHaveBeenCalledTimes(1)
    first.resolve(translated('A short prefix'))
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls[1][0]).toBe('A short prefix and more words')
    expect(queue.captions[0]).toMatchObject({ status: 'ready', live: true, translationPending: true,
      original: 'A short prefix and more words', translatedOriginal: 'A short prefix', en: 'A short prefix' })
    second.resolve(translated('A short prefix and more words'))
    await settle()
    expect(queue.captions[0]).toMatchObject({ translatedOriginal: 'A short prefix and more words', translationPending: false })
    queue.close()
  })

  it('flushes a corrected final in place and prevents a late partial from overwriting it', async () => {
    const partial = deferred(), final = deferred()
    const translator = vi.fn<typeof translateCaption>().mockImplementationOnce(() => partial.promise).mockImplementationOnce(() => final.promise)
    const { queue } = timedQueue(translator)
    queue.updatePartial('I scream', 'system', 'one')
    await vi.advanceTimersByTimeAsync(650)
    const id = queue.captions[0].id
    queue.finishSentence('Ice cream.', 'system', 'one')
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls[0][2]?.aborted).toBe(true)
    expect(translator.mock.calls[1][0]).toBe('Ice cream.')
    expect(translator.mock.calls[1][1].partial).toBe(false)
    final.resolve(translated('Ice cream.'))
    await settle()
    partial.resolve(translated('I scream'))
    await settle()
    expect(queue.captions).toHaveLength(1)
    expect(queue.captions[0]).toMatchObject({ id, live: false, translationPending: false, original: 'Ice cream.', translatedOriginal: 'Ice cream.', en: 'Ice cream.', status: 'ready' })
    queue.close()
  })

  it('keeps a useful in-flight prefix after finalization, then completes the final text', async () => {
    const partial = deferred(), final = deferred()
    const translator = vi.fn<typeof translateCaption>().mockImplementationOnce(() => partial.promise).mockImplementationOnce(() => final.promise)
    const { queue } = timedQueue(translator)
    queue.updatePartial('The news', 'system', 'one')
    await vi.advanceTimersByTimeAsync(650)
    queue.finishSentence('The news continues.', 'system', 'one')
    await settle()
    expect(translator).toHaveBeenCalledTimes(1)
    expect(translator.mock.calls[0][2]?.aborted).toBe(false)
    partial.resolve(translated('The news'))
    await settle()
    expect(queue.captions[0]).toMatchObject({ live: false, status: 'ready', translatedOriginal: 'The news', translationPending: true })
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls[1][0]).toBe('The news continues.')
    expect(translator.mock.calls[1][1].partial).toBe(false)
    final.resolve(translated('The news continues.'))
    await settle()
    expect(queue.captions[0]).toMatchObject({ translatedOriginal: 'The news continues.', translationPending: false })
    queue.close()
  })

  it.each([false, true])('reuses identical final text instead of repeating an existing draft request (complete=%s)', async complete => {
    const work = deferred()
    const translator = vi.fn<typeof translateCaption>().mockImplementation(() => work.promise)
    const { queue } = timedQueue(translator)
    queue.updatePartial('Same words.', 'system')
    await vi.advanceTimersByTimeAsync(650)
    if (complete) { work.resolve(translated('Same words.')); await settle() }
    queue.finishSentence('Same words.', 'system')
    await settle()
    expect(translator).toHaveBeenCalledTimes(1)
    expect(translator.mock.calls[0][2]?.aborted).toBe(false)
    if (!complete) { work.resolve(translated('Same words.')); await settle() }
    expect(queue.captions[0]).toMatchObject({ live: false, status: 'ready', translatedOriginal: 'Same words.', translationPending: false })
    queue.close()
  })

  it('retranslates an identical final when target settings changed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let current: TranslationConfig = { ...config, targetLanguages: ['en'] }
    const translator = vi.fn<typeof translateCaption>().mockResolvedValueOnce(translated('Same words.'))
      .mockResolvedValueOnce({ language: '英语', translations: { fr: 'Les mêmes mots.' }, zh: '', en: '', ja: '', reading: '' })
    const queue = new CaptionQueue([], () => current, vi.fn(), vi.fn(), translator)
    queue.updatePartial('Same words.', 'system')
    await vi.advanceTimersByTimeAsync(650)
    current = { ...config, targetLanguages: ['fr'] }
    queue.finishSentence('Same words.', 'system')
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls[1][1].targetLanguages).toEqual(['fr'])
    expect(queue.captions[0].translations?.fr).toBe('Les mêmes mots.')
    queue.close()
  })

  it('serves a fresh draft at the next free slot ahead of a long final/history backlog', async () => {
    const starts: Array<[number, string]> = []
    const translator = vi.fn<typeof translateCaption>().mockImplementation(text => new Promise(resolve => {
      starts.push([Date.now(), text])
      setTimeout(() => resolve(translated(text)), 2000)
    }))
    const { queue } = timedQueue(translator)
    for (let index = 0; index < 22; index++) queue.add(`older ${index}`, 'text')
    queue.updatePartial('current live', 'system', 'current')
    await vi.advanceTimersByTimeAsync(4000)
    expect(starts.find(([, text]) => text === 'current live')?.[0]).toBe(2000)
    expect(queue.captions.find(caption => caption.original === 'current live')).toMatchObject({ status: 'ready', translatedOriginal: 'current live' })
    expect(starts.filter(([time, text]) => time === 2000 && text.startsWith('older'))).toHaveLength(1)
    queue.close()
  })

  it('reserves a final/history opportunity when live drafts continuously occupy both slots', async () => {
    const work = new Map(['first', 'second', 'third', 'final'].map(text => [text, deferred()]))
    const translator = vi.fn<typeof translateCaption>().mockImplementation(text => work.get(text)!.promise)
    const { queue } = timedQueue(translator)
    for (const text of ['first', 'second', 'third']) queue.updatePartial(text, 'system', text)
    await vi.advanceTimersByTimeAsync(650)
    expect(translator.mock.calls.map(([text]) => text)).toEqual(['first', 'second'])
    queue.add('final', 'text')
    work.get('first')!.resolve(translated('first'))
    await settle()
    expect(translator.mock.calls.map(([text]) => text)).toEqual(['first', 'second', 'final'])
    work.get('second')!.resolve(translated('second'))
    await settle()
    expect(translator.mock.calls.map(([text]) => text)).toEqual(['first', 'second', 'final', 'third'])
    queue.close()
    work.get('third')!.resolve(translated('third')); work.get('final')!.resolve(translated('final'))
    await settle()
  })

  it('retains a readable prefix if a newer draft fails and recovers on the final revision', async () => {
    const translator = vi.fn<typeof translateCaption>().mockResolvedValueOnce(translated('Hello'))
      .mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(translated('Hello world.'))
    const { queue } = timedQueue(translator)
    queue.updatePartial('Hello', 'system')
    await vi.advanceTimersByTimeAsync(650)
    queue.updatePartial('Hello wor', 'system')
    await vi.advanceTimersByTimeAsync(1100)
    expect(queue.captions[0]).toMatchObject({ status: 'ready', en: 'Hello', translatedOriginal: 'Hello', original: 'Hello wor', translationPending: false, error: 'temporary failure' })
    queue.finishSentence('Hello world.', 'system')
    await settle()
    expect(queue.captions[0]).toMatchObject({ status: 'ready', live: false, en: 'Hello world.', translatedOriginal: 'Hello world.' })
    expect(queue.captions[0].error).toBeUndefined()
    queue.close()
  })

  it('exposes a failed final as retryable while preserving its readable earlier prefix', async () => {
    const translator = vi.fn<typeof translateCaption>().mockResolvedValueOnce(translated('Hello'))
      .mockRejectedValueOnce(new Error('Final translation failed')).mockResolvedValueOnce(translated('Hello world.'))
    const { queue } = timedQueue(translator)
    queue.updatePartial('Hello', 'system')
    await vi.advanceTimersByTimeAsync(650)
    queue.finishSentence('Hello world.', 'system')
    await settle()
    const caption = queue.captions[0]
    expect(caption).toMatchObject({ status: 'error', live: false, translationPending: false,
      original: 'Hello world.', translatedOriginal: 'Hello', en: 'Hello', error: 'Final translation failed' })
    queue.retry(caption.id)
    await settle()
    expect(caption).toMatchObject({ status: 'ready', translatedOriginal: 'Hello world.', en: 'Hello world.', translationPending: false })
    expect(caption.error).toBeUndefined()
    queue.close()
  })

  it('does not attach languages from an older prefix to a newer source after target settings change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let current: TranslationConfig = { ...config, targetLanguages: ['ja'] }
    const translator = vi.fn<typeof translateCaption>()
      .mockResolvedValueOnce({ language: '英语', translations: { ja: '日本語' }, zh: '', en: '', ja: '日本語', reading: 'にほんご', jaSegments: [{ text: '日本語', reading: 'にほんご' }] })
      .mockResolvedValueOnce({ language: '英语', translations: { fr: 'La langue japonaise' }, zh: '', en: '', ja: '', reading: '' })
    const queue = new CaptionQueue([], () => current, vi.fn(), vi.fn(), translator)
    queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(650)
    expect(queue.captions[0].ja).toBe('日本語')
    current = { ...config, targetLanguages: ['fr'] }
    queue.finishSentence('The Japanese language.', 'system')
    await settle()
    expect(queue.captions[0]).toMatchObject({ translatedOriginal: 'The Japanese language.', translations: { fr: 'La langue japonaise' }, targetLanguages: ['fr'], zh: '', en: '', ja: '', reading: '' })
    expect(queue.captions[0].jaSegments).toBeUndefined()
    expect(queue.captions[0].furiganaStatus).toBeUndefined()
    queue.close()
  })

  it('keeps independent sources and interleaved utterance ids separate', async () => {
    const { queue, translator } = timedQueue()
    queue.updatePartial('first system phrase', 'system', 'one')
    queue.updatePartial('microphone phrase', 'microphone', 'one')
    queue.updatePartial('next system phrase', 'system', 'two')
    await vi.advanceTimersByTimeAsync(650)
    expect(queue.captions).toHaveLength(3)
    expect(translator).toHaveBeenCalledTimes(3)
    const firstId = queue.captions[0].id
    queue.finishSentence('first system corrected.', 'system', 'one')
    await settle()
    expect(queue.captions).toHaveLength(3)
    expect(queue.captions[0]).toMatchObject({ id: firstId, original: 'first system corrected.', live: false })
    expect(queue.captions.slice(1).map(c => [c.source, c.original, c.live])).toEqual([
      ['microphone', 'microphone phrase', true], ['system', 'next system phrase', true]
    ])
    queue.close()
  })

  it('finalizes every pending draft immediately when listening stops and handles an empty provider final', async () => {
    const { queue, translator } = timedQueue()
    queue.updatePartial('Last heard system words', 'system', 'one')
    queue.updatePartial('Last microphone words', 'microphone', 'two')
    queue.finishSentence('', 'system', 'one')
    queue.finishPartials()
    await settle()
    expect(translator).toHaveBeenCalledTimes(2)
    expect(translator.mock.calls.every(([, options]) => options.partial === false)).toBe(true)
    expect(queue.captions.map(c => [c.original, c.live, c.status])).toEqual([
      ['Last heard system words', false, 'ready'], ['Last microphone words', false, 'ready']
    ])
    queue.finishPartials()
    await vi.advanceTimersByTimeAsync(2000)
    expect(translator).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    queue.close()
  })

  it('splits oversized ASR finals without losing text or splitting a supplementary character', async () => {
    const { queue, translator } = timedQueue()
    const text = 'a'.repeat(5999) + '𠮷' + 'b'.repeat(6003)
    queue.updatePartial(text.slice(0, 6003), 'system', 'long')
    const firstId = queue.captions[0].id
    queue.finishSentence(text, 'system', 'long')
    await settle()
    expect(queue.captions).toHaveLength(3)
    expect(queue.captions[0].id).toBe(firstId)
    expect(queue.captions.map(c => c.original).join('')).toBe(text)
    expect(queue.captions.every(c => c.original.length <= 6000 && !/[\uD800-\uDFFF]/u.test(c.original) && c.live === false)).toBe(true)
    expect(translator.mock.calls.map(([source]) => source).join('')).toBe(text)
    queue.close()
  })

  it('protects the live reading prefix from retention and blocks saving or retrying a changing draft', async () => {
    const { queue, translator } = timedQueue()
    queue.updatePartial('Live source', 'system')
    await vi.advanceTimersByTimeAsync(650)
    const live = queue.captions[0]
    const calls = translator.mock.calls.length
    queue.toggleSaved(live.id)
    queue.retry(live.id)
    expect(live.saved).toBe(false)
    expect(translator).toHaveBeenCalledTimes(calls)
    queue.updatePartial('Live source keeps growing', 'system')
    for (let index = 0; index < 152; index++) { queue.add(`text ${index}`, 'text'); await settle() }
    expect(queue.captions).toHaveLength(151)
    expect(queue.captions[0]).toMatchObject({ id: live.id, live: true, translationPending: true, status: 'ready', translatedOriginal: 'Live source' })
    queue.close()
  })

  it('publishes a late final completion before retention evicts the finished caption', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const final = deferred()
    const observed: Array<{ pending?: boolean; original?: string }> = []
    const translator = vi.fn<typeof translateCaption>().mockImplementation(text => text === 'Old final' ? final.promise : Promise.resolve(translated(text)))
    const queue = new CaptionQueue([], () => config, () => {
      const caption = queue.captions.find(c => c.original === 'Old final')
      if (caption) observed.push({ pending: caption.translationPending, original: caption.translatedOriginal })
    }, vi.fn(), translator)
    queue.updatePartial('Old', 'system')
    await vi.advanceTimersByTimeAsync(650)
    queue.finishSentence('Old final', 'system')
    for (let index = 0; index < 152; index++) { queue.add(`new ${index}`, 'text'); await settle() }
    expect(queue.captions[0]).toMatchObject({ original: 'Old final', translationPending: true })
    final.resolve(translated('Old final'))
    await settle()
    expect(observed).toContainEqual({ pending: false, original: 'Old final' })
    expect(queue.captions.some(c => c.original === 'Old final')).toBe(false)
    expect(queue.captions).toHaveLength(150)
    queue.close()
  })

  it('annotates the published source snapshot rather than the newer unfinished ASR text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const work = deferred()
    const annotator = vi.fn<typeof annotateJapanese>().mockResolvedValue({ reading: 'にほんご', jaSegments: [{ text: '日本語', reading: 'にほんご' }] })
    const queue = new CaptionQueue([], () => ({ ...config, generateFurigana: true }), vi.fn(), vi.fn(), () => work.promise, annotator)
    queue.updatePartial('Japanese', 'system')
    await vi.advanceTimersByTimeAsync(650)
    queue.updatePartial('Japanese language is interesting', 'system')
    work.resolve({ ...translated('Japanese'), ja: '日本語', translations: { ja: '日本語' } })
    await settle()
    expect(annotator.mock.calls[0].slice(0, 2)).toEqual(['Japanese', '日本語'])
    expect(queue.captions[0]).toMatchObject({ original: 'Japanese language is interesting', translatedOriginal: 'Japanese', furiganaStatus: 'ready' })
    queue.close()
  })

  it('emits timing/count diagnostics without source text, translations, endpoint or key', async () => {
    vi.mocked(trace).mockClear()
    const { queue } = timedQueue()
    queue.updatePartial('private source words', 'system')
    await vi.advanceTimersByTimeAsync(650)
    const calls = vi.mocked(trace).mock.calls
    expect(calls.some(([event]) => event === 'translation.start')).toBe(true)
    expect(calls.some(([event]) => event === 'translation.ready')).toBe(true)
    const serialized = JSON.stringify(calls)
    for (const privateValue of ['private source words', config.apiKey, config.baseUrl, '中文']) expect(serialized).not.toContain(privateValue)
    const start = calls.find(([event]) => event === 'translation.start')![1]
    expect(start).toMatchObject({ revision: 1, chars: 20, partial: true, queueMs: 0, waiting: 0, running: 1 })
    queue.close()
  })
})
