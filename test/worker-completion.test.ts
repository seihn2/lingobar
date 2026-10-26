import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCompletion, MAX_COMPLETION_REQUESTS, TRANSLATION_ENDPOINT } from '../src/worker/completion'
import type { RelayConfig, WorkerFetch } from '../src/worker/types'

const config: RelayConfig = { asrKey: 'synthetic-worker-asr', translationKey: 'synthetic-worker-translation', model: 'qwen-audio-3.1-asr-flash-streaming' }
const controller = () => new AbortController()
const reply = (value: unknown = { language: '英语', translations: { zh: '合成译文', ja: '天気' } }) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }))
afterEach(() => { vi.useRealTimers() })
describe('fixed DeepSeek completion transport, synthetic HTTP only', () => {
  it('reuses the existing selected-language/partial protocol and keeps the key only in the server header', async () => {
    const fetch = vi.fn<WorkerFetch>(async () => reply()), service = createCompletion(config, fetch)
    const result = await service.translate('Synthetic unfinished source', ['zh', 'ja'], true, controller().signal)
    expect(result.translations).toEqual({ zh: '合成译文', ja: '天気' })
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe(TRANSLATION_ENDPOINT)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer synthetic-worker-translation' } })
    const body = JSON.parse(init!.body as string); expect(body.model).toBe('deepseek-flash'); expect(body.stream).toBe(false)
    expect(body.messages[0].content).toContain('unfinished speech fragment'); expect(body.messages[1].content).toBe('{"source_text":"Synthetic unfinished source"}')
    expect(JSON.stringify(result)).not.toContain('synthetic-worker')
  })
  it('uses the original kanji-slot annotation contract without changing the Japanese text', async () => {
    const fetch = vi.fn<WorkerFetch>(async () => reply({ readings: [{ id: 'h0', reading: 'てんき' }] })), service = createCompletion(config, fetch)
    const result = await service.annotate('Synthetic weather', '天気', controller().signal)
    expect(result.jaSegments).toEqual([{ text: '天気', reading: 'てんき' }]); expect(fetch.mock.calls[0][0]).toBe(TRANSLATION_ENDPOINT)
  })
  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [429, 'quota'], [503, 'upstream'], [302, 'upstream']] as const)('classifies status %s without exposing a provider error', async (status, code) => {
    const fetch = vi.fn<WorkerFetch>(async () => new Response('synthetic provider secret text', { status, headers: { Location: 'https://arbitrary.example' } })), service = createCompletion(config, fetch)
    await expect(service.translate('Synthetic source', ['zh', 'ja'], false, controller().signal)).rejects.toMatchObject({ code, message: code })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('enforces the per-connection request budget before another paid request can be attempted', async () => {
    const fetch = vi.fn<WorkerFetch>(async () => reply()), service = createCompletion(config, fetch)
    for (let i = 0; i < MAX_COMPLETION_REQUESTS; i++) await service.translate('Synthetic source', ['zh', 'ja'], false, controller().signal)
    await expect(service.translate('Synthetic source', ['zh', 'ja'], false, controller().signal)).rejects.toMatchObject({ code: 'quota' })
    expect(fetch).toHaveBeenCalledTimes(MAX_COMPLETION_REQUESTS)
  })
  it('cancels and times out even a synthetic transport that ignores AbortSignal; late results do not revive the operation', async () => {
    vi.useFakeTimers(); let complete!: (response: Response) => void
    const fetch = vi.fn<WorkerFetch>(() => new Promise(resolve => { complete = resolve })), service = createCompletion(config, fetch)
    const abort = controller(), pending = service.translate('Synthetic source', ['zh', 'ja'], false, abort.signal)
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'unavailable' }); abort.abort(); await cancelled
    complete(reply()); await Promise.resolve()
    const timed = service.translate('Synthetic source', ['zh', 'ja'], false, controller().signal)
    const timeout = expect(timed).rejects.toMatchObject({ code: 'upstream' }); await vi.advanceTimersByTimeAsync(25001); await timeout
    complete(reply()); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects malformed or oversized translations and makes no request after an already-cancelled start', async () => {
    const fetch = vi.fn<WorkerFetch>(async () => reply({ language: '英语', translations: { zh: '长'.repeat(8001), ja: '天気' } })), service = createCompletion(config, fetch)
    await expect(service.translate('Synthetic source', ['zh', 'ja'], false, controller().signal)).rejects.toMatchObject({ code: 'upstream' })
    const abort = controller(); abort.abort()
    await expect(service.translate('Synthetic source', ['zh', 'ja'], false, abort.signal)).rejects.toMatchObject({ code: 'unavailable' })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
