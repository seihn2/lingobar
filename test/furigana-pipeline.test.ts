import { afterEach, expect, it, vi } from 'vitest'
import { CaptionQueue } from '../src/main/captions'

vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it('shows the first ruby in the caption snapshot while the LLM stream is still open', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
  const changed = vi.fn()
  const queue = new CaptionQueue([], () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'test-key', model: 'deepseek-flash', targetLanguages: ['ja'] }), changed, vi.fn(), async () => ({
    language: '日语', ja: '今日は学校へ行く。', zh: '', en: '', reading: '', translations: { ja: '今日は学校へ行く。' }
  }))
  const send = (content: string, finish_reason: string | null = null) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`))
  try {
    queue.add('今日は学校へ行く。', 'system')
    await vi.waitFor(() => expect(queue.captions[0].furiganaStatus).toBe('pending'))
    changed.mockClear()
    send('{"readings":[{"id":"h0","reading":"きょう"},')
    await vi.waitFor(() => expect(queue.captions[0].jaSegments?.[0]).toEqual({ text: '今日', reading: 'きょう' }))
    expect(queue.captions[0].furiganaStatus).toBe('pending')
    expect(queue.captions[0].jaSegments?.map(s => s.text).join('')).toBe('今日は学校へ行く。')
    expect(changed).toHaveBeenCalled()
    send('{"id":"h1","reading":"がっこう"},{"id":"h2","reading":"い"}]}', 'stop')
    stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
    await vi.waitFor(() => expect(queue.captions[0].furiganaStatus).toBe('ready'))
    expect(queue.captions[0].reading).toBe('きょうはがっこうへいく。')
  } finally { queue.close() }
})
