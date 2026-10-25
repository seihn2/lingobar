import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestJsonCompletion } from '../src/main/translation'

const config = { baseUrl: 'https://api.deepseek.com', apiKey: 'test-private-key', model: 'deepseek-flash' }
const encoder = new TextEncoder()
const chunk = (content: string | null, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\r\n\r\n`

function controlledResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancelled = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value }, cancel: cancelled }), {
    headers: { 'content-type': 'text/event-stream' }
  })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
  return { controller, cancelled, send: (text: string) => controller.enqueue(encoder.encode(text)) }
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve() }

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('streaming JSON completion', () => {
  it('publishes complete content fragments while the response body remains open', async () => {
    const stream = controlledResponse()
    const progress = vi.fn()
    const task = requestJsonCompletion('JSON only', {}, config, undefined, progress)
    const first = '{"readings":[{"id":"h0","reading":"きょう"}'
    stream.send(chunk(first))
    await flush()
    expect(progress).toHaveBeenLastCalledWith(first)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).stream).toBe(true)
    stream.send(chunk(']}') + chunk(null, 'stop') + 'data: [DONE]\r\n\r\n')
    await expect(task).resolves.toEqual({ readings: [{ id: 'h0', reading: 'きょう' }] })
    expect(progress).toHaveBeenLastCalledWith(first + ']}')
    expect(stream.cancelled).toHaveBeenCalled()
  })

  it('handles split UTF-8, CRLF, comments and multiple events per network chunk', async () => {
    const stream = controlledResponse()
    const progress = vi.fn()
    const task = requestJsonCompletion('JSON only', {}, config, undefined, progress)
    const bytes = encoder.encode(': keepalive\r\n\r\n' + chunk('{"reading":"きょう"}') + chunk(null, 'stop') + 'data: [DONE]\r\n\r\n')
    for (let index = 0; index < bytes.length; index += 2) stream.controller.enqueue(bytes.slice(index, index + 2))
    await expect(task).resolves.toEqual({ reading: 'きょう' })
    expect(progress).toHaveBeenCalledWith('{"reading":"きょう"}')
  })

  it('accepts a complete JSON envelope when a provider ignores stream', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"reading":"きょう"}' } }]
    }), { headers: { 'content-type': 'application/json' } })))
    const progress = vi.fn()
    await expect(requestJsonCompletion('JSON only', {}, config, undefined, progress)).resolves.toEqual({ reading: 'きょう' })
    expect(progress).toHaveBeenCalledWith('{"reading":"きょう"}')
  })

  it.each([
    chunk('{"ok":true}'),
    chunk('{"ok":true}') + 'data: [DONE]\n\n',
    chunk('{"ok":true}', 'length') + 'data: [DONE]\n\n',
    chunk('{"ok":true}', 'content_filter') + 'data: [DONE]\n\n',
    'data: {"error":{"message":"test-private-key and private speech"}}\n\n',
    'data: not-json-test-private-key\n\n'
  ])('rejects unfinished, refused or malformed streams without exposing provider content', async body => {
    const stream = controlledResponse()
    const task = requestJsonCompletion('JSON only', {}, config, undefined, vi.fn())
    stream.send(body)
    stream.controller.close()
    await expect(task).rejects.toThrow('格式不完整')
    await expect(task).rejects.not.toThrow('test-private-key')
  })

  it('bounds content independently of event overhead', async () => {
    const stream = controlledResponse()
    const progress = vi.fn()
    const task = requestJsonCompletion('JSON only', {}, config, undefined, progress)
    stream.send(chunk('あ'.repeat(44_000)))
    await expect(task).rejects.toThrow('过长')
    expect(progress).not.toHaveBeenCalled()
    expect(stream.cancelled).toHaveBeenCalled()
  })

  it('bounds SSE framing even if it contains no content', async () => {
    const stream = controlledResponse()
    const task = requestJsonCompletion('JSON only', {}, config, undefined, vi.fn())
    stream.send(': ' + 'x'.repeat(1024 * 1024))
    await expect(task).rejects.toThrow('过长')
    expect(stream.cancelled).toHaveBeenCalled()
  })

  it('cancels an open reader promptly without publishing late content', async () => {
    const stream = controlledResponse()
    const abort = new AbortController()
    const progress = vi.fn()
    const task = requestJsonCompletion('JSON only', {}, config, abort.signal, progress)
    await flush()
    abort.abort()
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(stream.cancelled).toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })

  it('honors cancellation during a progress callback even when DONE is already buffered', async () => {
    const stream = controlledResponse()
    const abort = new AbortController()
    const task = requestJsonCompletion('JSON only', {}, config, abort.signal, () => abort.abort())
    stream.send(chunk('{"ok":true}') + chunk(null, 'stop') + 'data: [DONE]\n\n')
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(stream.cancelled).toHaveBeenCalled()
  })

  it('applies the existing deadline to an open stream', async () => {
    vi.useFakeTimers()
    const stream = controlledResponse()
    const task = requestJsonCompletion('JSON only', {}, config, undefined, vi.fn())
    const rejected = expect(task).rejects.toMatchObject({ name: 'TimeoutError' })
    await flush()
    await vi.advanceTimersByTimeAsync(25_000)
    await rejected
    expect(stream.cancelled).toHaveBeenCalled()
  })
})
