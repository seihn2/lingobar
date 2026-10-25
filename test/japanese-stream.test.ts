import { afterEach, describe, expect, it, vi } from 'vitest'
import { annotateJapanese } from '../src/main/japanese'
import { requestJsonCompletion } from '../src/main/translation'

vi.mock('../src/main/translation', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/translation')>(),
  requestJsonCompletion: vi.fn()
}))

const config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test-key', model: 'deepseek-flash' }
const text = '今日、学校へ行く。'
const readings = [{ id: 'h0', reading: 'きょう' }, { id: 'h1', reading: 'がっこう' }, { id: 'h2', reading: 'い' }]
const completion = vi.mocked(requestJsonCompletion)
afterEach(() => vi.resetAllMocks())

describe('incremental LLM furigana', () => {
  it('publishes each complete, validated slot before the remaining readings finish', async () => {
    let finish!: (value: unknown) => void
    let push!: (content: string) => void
    completion.mockImplementation((_prompt, _data, _config, _signal, onContent) => {
      push = onContent!
      return new Promise(resolve => { finish = resolve })
    })
    const progress = vi.fn()
    const pending = annotateJapanese('Today, go to school.', text, config, undefined, progress)
    expect(push).toBeTypeOf('function')
    push('{"readings":[{"id":"h0","reading":"きょ')
    expect(progress).not.toHaveBeenCalled()
    push('{"readings":[{"id":"h0","reading":"きょう"},')
    expect(progress).toHaveBeenCalledTimes(1)
    expect(progress.mock.lastCall![0].jaSegments.filter((s: { reading?: string }) => s.reading)).toEqual([{ text: '今日', reading: 'きょう' }])
    push('{"readings":[{"id":"h0","reading":"きょう"},{"id":"h1","reading":"がっこう"}')
    expect(progress).toHaveBeenCalledTimes(2)
    expect(progress.mock.lastCall![0].jaSegments.map((s: { text: string }) => s.text).join('')).toBe(text)
    finish({ readings })
    await expect(pending).resolves.toMatchObject({ reading: 'きょう、がっこうへいく。' })
  })

  it.each([
    '{"readings":[{"id":"unknown","reading":"きょう"}',
    '{"readings":[{"id":"h0","reading":"kyou"}',
    '{"readings":[{"id":"h0","reading":"きょう","text":"rewrite"}',
    '{"other":[{"id":"h0","reading":"きょう"}',
    '{"readings":[{"id":"h0","reading":"きょう"},{"id":"h0","reading":"こんにち"}',
    '{"readings":[{"id":"h0","reading":"きょう}\\\""}'
  ])('does not publish malformed or misaligned partial readings: %s', async partial => {
    completion.mockImplementation(async (_p, _d, _c, _s, onContent) => {
      onContent!(partial)
      return { readings }
    })
    const progress = vi.fn()
    await annotateJapanese('Today', text, config, undefined, progress)
    expect(progress).not.toHaveBeenCalled()
  })

  it('clears provisional readings before retrying a malformed final response', async () => {
    completion.mockImplementationOnce(async (_p, _d, _c, _s, onContent) => {
      onContent!('{"readings":[{"id":"h0","reading":"きょう"},')
      return { readings: [readings[0]] }
    }).mockResolvedValueOnce({ readings })
    const progress = vi.fn()
    await annotateJapanese('Today', text, config, undefined, progress)
    expect(progress).toHaveBeenCalledTimes(2)
    expect(progress.mock.lastCall![0]).toEqual({ reading: text, jaSegments: [{ text }] })
    expect(completion).toHaveBeenCalledTimes(2)
  })

  it('immediately clears a provisional reading when a later closed slot invalidates the reply', async () => {
    const progress = vi.fn()
    completion.mockImplementation(async (_p, _d, _c, _s, onContent) => {
      const first = '{"readings":[{"id":"h0","reading":"きょう"},'
      onContent!(first)
      expect(progress).toHaveBeenCalledTimes(1)
      onContent!(first + '{"id":"h0","reading":"こんにち"},')
      expect(progress.mock.lastCall![0]).toEqual({ reading: text, jaSegments: [{ text }] })
      expect(progress).toHaveBeenCalledTimes(2)
      onContent!(first + '{"id":"h0","reading":"こんにち"},{"id":"h1","reading":"がっこう"}')
      expect(progress).toHaveBeenCalledTimes(2)
      return { readings }
    })
    await annotateJapanese('Today', text, config, undefined, progress)
  })

  it('does not publish stream output after cancellation', async () => {
    const controller = new AbortController()
    completion.mockImplementation(async (_p, _d, _c, _s, onContent) => {
      controller.abort()
      onContent!('{"readings":[{"id":"h0","reading":"きょう"},')
      return { readings }
    })
    const progress = vi.fn()
    await expect(annotateJapanese('Today', text, config, controller.signal, progress)).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).not.toHaveBeenCalled()
  })
})
