import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QwenAsrSession, realtimeSessionConfig, transcriptionEvent, asrConnection, streamingTranscriptionEvent, streamingTranscriptionEvents, DEFAULT_ASR_MODEL } from '../src/main/audio/qwen'
import { trace } from '../src/main/diagnostics'

vi.mock('../src/main/diagnostics', () => ({ trace: vi.fn() }))

class FakeSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING as number
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  binary: Buffer[] = []
  terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED })
  send(value: string | Buffer, callback?: (error?: Error) => void): void {
    if (Buffer.isBuffer(value)) this.binary.push(Buffer.from(value))
    else this.sent.push(JSON.parse(value))
    callback?.()
  }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open') }
  message(value: unknown): void { this.emit('message', Buffer.from(JSON.stringify(value))) }
}
const options = { apiKey: 'synthetic-test-key', model: 'qwen3-asr-flash-realtime', endpoint: 'wss://example.invalid/realtime' }
function fixture(finishTimeoutMs?: number) {
  const sockets: FakeSocket[] = []
  const callbacks = { onPartial: vi.fn(), onSentence: vi.fn(), onError: vi.fn() }
  const session = new QwenAsrSession(callbacks, {
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket },
    startupTimeoutMs: 1000,
    ...(finishTimeoutMs === undefined ? {} : { finishTimeoutMs })
  })
  return { session, sockets, callbacks }
}
afterEach(() => vi.useRealTimers())

async function readySession(streaming: boolean, finishTimeoutMs?: number) {
  const result = fixture(finishTimeoutMs)
  const start = result.session.start(streaming ? streamingOptions : options)
  const socket = result.sockets[0]
  socket.open(); socket.message(streaming ? taskEvent(socket, 'task-started') : { type: 'session.updated' })
  await start
  return { ...result, socket }
}

function finalEvent(socket: FakeSocket, streaming: boolean, text = 'Synthetic final tail') {
  return streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text, sentence_end: true }) :
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: text }
}

function finishedEvent(socket: FakeSocket, streaming: boolean) {
  return streaming ? taskEvent(socket, 'task-finished') : { type: 'session.finished' }
}

describe('Qwen protocol and session ownership', () => {
  it('combines confirmed prefix with draft suffix and retains final Unicode text', () => {
    expect(transcriptionEvent({ type: 'conversation.item.input_audio_transcription.text', text: '今日は', stash: 'いい天気' }))
      .toEqual({ partial: true, text: '今日はいい天気', id: undefined })
    expect(transcriptionEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '  Hello 你好  ' }))
      .toEqual({ partial: false, text: 'Hello 你好', id: undefined })
    expect(transcriptionEvent({ type: 'conversation.item.input_audio_transcription.text', text: 42, stash: {} })?.text).toBe('')
    expect(realtimeSessionConfig()).not.toHaveProperty('input_audio_transcription')
  })
  it('waits for configuration acknowledgement and flushes bounded PCM only afterward', async () => {
    const { session, sockets } = fixture()
    let resolved = false
    const start = session.start(options).then(() => { resolved = true })
    const socket = sockets[0]
    socket.open()
    session.push(new Int16Array([100, -100]).buffer)
    socket.message({ type: 'session.created' })
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(socket.sent.map((event) => event.type)).toEqual(['session.update'])
    socket.message({ type: 'session.updated' })
    await start
    expect(socket.sent[1].type).toBe('input_audio_buffer.append')
    expect(Buffer.from(socket.sent[1].audio as string, 'base64')).toEqual(Buffer.from(new Int16Array([100, -100]).buffer))
    expect(socket.sent.every((event) => typeof event.event_id === 'string')).toBe(true)
    session.stop()
  })
  it('cancels startup and ignores every late callback from a previous socket', async () => {
    const { session, sockets, callbacks } = fixture()
    const first = session.start(options)
    const cancelled = expect(first).rejects.toThrow('取消')
    const old = sockets[0]
    session.stop()
    await cancelled
    const second = session.start(options)
    sockets[1].open()
    old.message({ type: 'session.updated' })
    old.message({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'stale' })
    old.emit('error', new Error('stale'))
    old.emit('close')
    sockets[1].message({ type: 'session.updated' })
    await second
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    session.stop()
  })
  it.each([false, true])('hard stop discards a late provider final and sends no finish command (streaming=%s)', async streaming => {
    const { session, sockets, callbacks } = fixture()
    const start = session.start(streaming ? streamingOptions : options)
    const socket = sockets[0]
    socket.open(); socket.message(streaming ? taskEvent(socket, 'task-started') : { type: 'session.updated' }); await start
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'Synthetic partial', sentence_end: false }) :
      { type: 'conversation.item.input_audio_transcription.text', item_id: 'one', text: 'Synthetic partial' })
    session.stop()
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'Synthetic partial plus final tail', sentence_end: true }) :
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Synthetic partial plus final tail' })
    session.push(new ArrayBuffer(2))
    expect(callbacks.onPartial.mock.calls.map(([text]) => text)).toEqual(['Synthetic partial'])
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(socket.sent).toHaveLength(1)
    expect(socket.binary).toHaveLength(0)
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it.each([false, true])('finishes the existing task, keeps its final tail, and blocks new PCM (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, sockets, callbacks } = fixture()
    const start = session.start(streaming ? streamingOptions : options)
    const socket = sockets[0]
    socket.open(); socket.message(streaming ? taskEvent(socket, 'task-started') : { type: 'session.updated' }); await start
    session.push(new Int16Array([0, 1, -1, 0]).buffer)
    const finish = session.finish()
    expect(session.finish()).toBe(finish)
    expect(socket.sent).toHaveLength(streaming ? 2 : 3)
    expect(socket.sent.at(-1)).toEqual(streaming ? {
      header: { action: 'finish-task', task_id: (socket.sent[0].header as Record<string, unknown>).task_id, streaming: 'duplex' },
      payload: { input: {} }
    } : { type: 'session.finish', event_id: expect.any(String) })
    expect(socket.sent.some(event => event.type === 'input_audio_buffer.commit')).toBe(false)
    const sent = socket.sent.length, binary = socket.binary.length
    session.push(new ArrayBuffer(2)); session.push(new ArrayBuffer(1))
    expect(socket.sent).toHaveLength(sent)
    expect(socket.binary).toHaveLength(binary)
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'Synthetic partial', sentence_end: false }) :
      { type: 'conversation.item.input_audio_transcription.text', item_id: 'one', text: 'Synthetic partial' })
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'Synthetic partial plus final tail', sentence_end: true }) :
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Synthetic partial plus final tail' })
    expect(callbacks.onSentence).toHaveBeenCalledWith('Synthetic partial plus final tail', expect.any(String))
    expect(socket.terminate).not.toHaveBeenCalled()
    socket.message(streaming ? taskEvent(socket, 'task-finished') : { type: 'session.finished' })
    await expect(finish).resolves.toBe('finished')
    expect(session.finish()).toBe(finish)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    socket.emit('close'); socket.emit('error', new Error('late close'))
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 2, text: 'late', sentence_end: true }) :
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'late' })
    expect(callbacks.onSentence).toHaveBeenCalledOnce()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
  it('fails bounded startup and consumes malformed protocol messages without escaping', async () => {
    vi.useFakeTimers()
    const { session, sockets } = fixture()
    const timedOut = expect(session.start(options)).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(1001)
    await timedOut
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
    const invalid = expect(session.start(options)).rejects.toThrow('无效数据')
    sockets[1].emit('message', Buffer.from('not-json'))
    await invalid
  })
  it('stops a stalled transport instead of retaining unlimited audio', async () => {
    const { session, sockets, callbacks } = fixture()
    const start = session.start(options)
    sockets[0].open(); sockets[0].message({ type: 'session.updated' }); await start
    sockets[0].bufferedAmount = 512_001
    session.push(new Int16Array([1]).buffer)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('发送速度不足'))
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
  })
  it('deduplicates completed items and hides keys in service errors', async () => {
    const { session, sockets, callbacks } = fixture()
    const start = session.start(options)
    sockets[0].open(); sockets[0].message({ type: 'session.updated' }); await start
    const event = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Hello' }
    sockets[0].message(event); sockets[0].message(event)
    sockets[0].message({ type: 'conversation.item.input_audio_transcription.text', item_id: 'one', stash: 'late' })
    expect(callbacks.onSentence).toHaveBeenCalledExactlyOnceWith('Hello', expect.stringMatching(/^[a-f0-9-]+:one$/))
    expect(callbacks.onPartial).toHaveBeenCalledExactlyOnceWith('', callbacks.onSentence.mock.calls[0][1])
    sockets[0].message({ type: 'error', error: { message: 'Rejected synthetic-test-key and sk-anotherkey' } })
    expect(callbacks.onError.mock.calls[0][0]).not.toMatch(/synthetic-test-key|sk-anotherkey/)
  })
  it('rejects insecure or credential-bearing endpoints before creating a socket', async () => {
    const { session, sockets } = fixture()
    await expect(session.start({ ...options, endpoint: 'ws://example.invalid' })).rejects.toThrow('wss://')
    await expect(session.start({ ...options, endpoint: 'wss://user:secret@example.invalid' })).rejects.toThrow('wss://')
    expect(sockets).toHaveLength(0)
  })
})


const streamingOptions = { ...options, model: 'qwen-audio-3.1-asr-flash-streaming', endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference' }
function taskEvent(socket: FakeSocket, event: string, sentence?: Record<string, unknown>) {
  const taskId = (socket.sent[0].header as Record<string, unknown>).task_id
  return { header: { event, task_id: taskId }, payload: sentence ? { output: { sentence } } : {} }
}
describe('Qwen Audio 3.1 streaming protocol', () => {
  it('keeps the documented final and next-sentence stash separate', () => {
    // Official server-event example: final sentence 1 includes empty stash 2.
    // The nonempty variant below is a protocol regression case, not a live capture.
    const sentence = { sentence_id: 1, text: '欢迎使用阿里云。', sentence_end: true,
      stash: { sentence_id: 2, text: '', begin_time: 1640, current_time: 1640, words: [] } }
    const event = { payload: { output: { sentence, text: '欢迎使用阿里云。' } } }
    expect(streamingTranscriptionEvents(event)).toEqual([{ partial: false, text: '欢迎使用阿里云。', id: '1' }])
    sentence.stash.text = '今日は'
    expect(streamingTranscriptionEvents(event)).toEqual([
      { partial: false, text: '欢迎使用阿里云。', id: '1' },
      { partial: true, text: '今日は', id: '2' }
    ])
  })

  it('does not invent merge rules for unlabelled or same-sentence stash content', () => {
    for (const stash of ['suffix', { text: 'suffix' }, { sentence_id: 0, text: 'suffix' },
      { sentence_id: 1, text: 'suffix' }, { sentence_id: '2', text: 'suffix' },
      { sentence_id: 2, text: {} }, { sentence_id: 2, text: ' ', heartbeat: true }]) {
      const event = { payload: { output: { sentence: { sentence_id: 1, text: 'prefix', sentence_end: false, stash } } } }
      expect(streamingTranscriptionEvents(event)).toEqual([{ partial: true, text: 'prefix', id: '1' }])
    }
    expect(streamingTranscriptionEvents({ payload: { output: { sentence: {
      sentence_id: 0, text: '', heartbeat: true, stash: { sentence_id: 2, text: 'ignored' }
    } } } })).toEqual([])
  })

  it('delivers growing next-sentence drafts even when each envelope repeats a completed sentence', async () => {
    const { session, sockets, callbacks } = fixture()
    const events: unknown[][] = []
    callbacks.onPartial.mockImplementation((text, id) => events.push(['partial', text, id]))
    callbacks.onSentence.mockImplementation((text, id) => events.push(['final', text, id]))
    const start = session.start(streamingOptions)
    const socket = sockets[0]
    socket.open(); socket.message(taskEvent(socket, 'task-started')); await start
    const prefix = (socket.sent[0].header as Record<string, unknown>).task_id
    const first = `${prefix}:1`, second = `${prefix}:2`
    for (const text of ['今日は', '今日は晴れ']) socket.message(taskEvent(socket, 'result-generated', {
      sentence_id: 1, text: '前の文。', sentence_end: true, stash: { sentence_id: 2, text }
    }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 2, text: '今日は晴れ。', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', {
      sentence_id: 1, text: '前の文。', sentence_end: true, stash: { sentence_id: 2, text: 'late draft' }
    }))
    expect(events).toEqual([
      ['partial', '', first], ['final', '前の文。', first],
      ['partial', '今日は', second], ['partial', '今日は晴れ', second],
      ['partial', '', second], ['final', '今日は晴れ。', second]
    ])
    session.stop()
  })

  it('stops dispatching the remaining stash when a final callback stops capture', async () => {
    const { session, sockets, callbacks } = fixture()
    callbacks.onSentence.mockImplementation(() => session.stop())
    const start = session.start(streamingOptions)
    const socket = sockets[0]
    socket.open(); socket.message(taskEvent(socket, 'task-started')); await start
    socket.message(taskEvent(socket, 'result-generated', {
      sentence_id: 1, text: 'final', sentence_end: true, stash: { sentence_id: 2, text: 'stale' }
    }))
    expect(callbacks.onSentence).toHaveBeenCalledOnce()
    expect(callbacks.onPartial).toHaveBeenCalledExactlyOnceWith('', expect.stringMatching(/:1$/))
  })

  it('sends run-task and binary PCM only after matching task-started', async () => {
    const { session, sockets } = fixture()
    let ready = false
    const start = session.start(streamingOptions).then(() => { ready = true })
    const socket = sockets[0]
    socket.open()
    expect(socket.sent[0]).toMatchObject({
      header: { action: 'run-task', streaming: 'duplex' },
      payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: DEFAULT_ASR_MODEL,
        parameters: { format: 'pcm', sample_rate: 16000, heartbeat: true }, input: {} }
    })
    expect((socket.sent[0].payload as Record<string, unknown>).parameters).not.toHaveProperty('language_hints')
    const pcm = new Int16Array([7, -9]).buffer
    session.push(pcm)
    socket.message({ header: { event: 'task-started', task_id: 'wrong-task' }, payload: {} })
    socket.message({ type: 'session.updated' })
    await Promise.resolve()
    expect(ready).toBe(false)
    expect(socket.binary).toHaveLength(0)
    socket.message(taskEvent(socket, 'task-started'))
    await start
    expect(socket.binary).toEqual([Buffer.from(pcm)])
    session.push(pcm)
    expect(socket.binary).toHaveLength(2)
    expect(socket.sent).toHaveLength(1)
    session.stop()
  })

  it('maps intermediate/final results, skips heartbeat, and suppresses wrong or duplicate sentences', async () => {
    const { session, sockets, callbacks } = fixture()
    const start = session.start(streamingOptions)
    const socket = sockets[0]
    socket.open(); socket.message(taskEvent(socket, 'task-started')); await start
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 0, text: 'heartbeat', heartbeat: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: '今日', sentence_end: false }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: '今日は晴れ。', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: '今日は晴れ。', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'late partial', sentence_end: false }))
    socket.message({ header: { event: 'result-generated', task_id: 'another-task' }, payload: { output: { sentence: { text: 'wrong', sentence_end: true } } } })
    const utteranceId = `${(socket.sent[0].header as Record<string, unknown>).task_id}:1`
    expect(callbacks.onPartial.mock.calls).toEqual([['今日', utteranceId], ['', utteranceId]])
    expect(callbacks.onSentence).toHaveBeenCalledExactlyOnceWith('今日は晴れ。', utteranceId)
    expect(streamingTranscriptionEvent({ payload: { output: { sentence: { text: {}, sentence_end: true } } } })).toBeNull()
    session.stop()
  })

  it('retains utterance identity through interleaved partials, older finals, and late events', async () => {
    const { session, sockets, callbacks } = fixture()
    const events: unknown[][] = []
    callbacks.onPartial.mockImplementation((text, id) => events.push(['partial', text, id]))
    callbacks.onSentence.mockImplementation((text, id) => events.push(['final', text, id]))
    const start = session.start(streamingOptions)
    const socket = sockets[0]
    socket.open(); socket.message(taskEvent(socket, 'task-started')); await start
    const prefix = (socket.sent[0].header as Record<string, unknown>).task_id
    const first = `${prefix}:1`, second = `${prefix}:2`
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'first draft', sentence_end: false }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 2, text: 'second draft', sentence_end: false }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'first final', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'stale first', sentence_end: false }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'duplicate first', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 2, text: 'second final', sentence_end: true }))
    expect(events).toEqual([
      ['partial', 'first draft', first], ['partial', 'second draft', second],
      ['partial', '', first], ['final', 'first final', first],
      ['partial', '', second], ['final', 'second final', second]
    ])
    session.stop()
  })

  it('delivers an empty final boundary exactly once after a draft', async () => {
    const { session, sockets, callbacks } = fixture()
    const start = session.start(streamingOptions)
    const socket = sockets[0]
    socket.open(); socket.message(taskEvent(socket, 'task-started')); await start
    const utteranceId = `${(socket.sent[0].header as Record<string, unknown>).task_id}:1`
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: '', sentence_begin: true, sentence_end: false }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'last known draft', sentence_end: false }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: '', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: '', sentence_end: true }))
    socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'late draft', sentence_end: false }))
    expect(callbacks.onSentence).toHaveBeenCalledExactlyOnceWith('', utteranceId)
    expect(callbacks.onPartial.mock.calls).toEqual([
      ['', utteranceId], ['last known draft', utteranceId], ['', utteranceId]
    ])
    session.stop()
  })

  it('namespaces reused provider sentence IDs by session and ignores events after stop', async () => {
    const { session, sockets, callbacks } = fixture()
    for (let index = 0; index < 2; index++) {
      const start = session.start(streamingOptions)
      const socket = sockets[index]
      socket.open(); socket.message(taskEvent(socket, 'task-started')); await start
      socket.message(taskEvent(socket, 'result-generated', { sentence_id: 1, text: `run ${index}`, sentence_end: true }))
      session.stop()
      socket.message(taskEvent(socket, 'result-generated', { sentence_id: 2, text: 'stale', sentence_end: true }))
    }
    expect(callbacks.onSentence.mock.calls).toEqual(sockets.map((socket, index) => [
      `run ${index}`, `${(socket.sent[0].header as Record<string, unknown>).task_id}:1`
    ]))
    expect(callbacks.onSentence.mock.calls[0][1]).not.toBe(callbacks.onSentence.mock.calls[1][1])
  })

  it('bounds startup buffering and cancels every late event from the old task', async () => {
    const { session, sockets, callbacks } = fixture()
    const failed = expect(session.start(streamingOptions)).rejects.toThrow('缓冲已满')
    const old = sockets[0]; old.open()
    for (let i = 0; i < 4; i++) session.push(new ArrayBuffer(16_384))
    await failed
    expect(old.terminate).toHaveBeenCalledOnce()
    const restarted = session.start(streamingOptions)
    old.message(taskEvent(old, 'task-started'))
    old.message(taskEvent(old, 'result-generated', { text: 'stale', sentence_end: true }))
    sockets[1].open(); sockets[1].message(taskEvent(sockets[1], 'task-started')); await restarted
    session.stop()
    sockets[1].message(taskEvent(sockets[1], 'result-generated', { text: 'stopped', sentence_end: true }))
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('rejects streaming startup failures and sanitizes runtime task failures', async () => {
    const { session, sockets, callbacks } = fixture()
    const fail = expect(session.start(streamingOptions)).rejects.toThrow('Rejected [已隐藏]')
    sockets[0].open()
    const failure = taskEvent(sockets[0], 'task-failed')
    sockets[0].message({ ...failure, header: { ...failure.header, error_message: `Rejected ${options.apiKey}` } })
    await fail
    const start = session.start(streamingOptions)
    sockets[1].open(); sockets[1].message(taskEvent(sockets[1], 'task-started')); await start
    const runtime = taskEvent(sockets[1], 'task-failed')
    sockets[1].message({ ...runtime, header: { ...runtime.header, error_message: 'Invalid sk-hidden-key' } })
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith('Invalid [已隐藏]')
    expect(sockets[1].terminate).toHaveBeenCalledOnce()
  })

  it('routes known service defaults and preserves custom endpoint paths', () => {
    expect(asrConnection({ model: '', endpoint: '' })).toEqual({ url: streamingOptions.endpoint, model: DEFAULT_ASR_MODEL, streaming: true })
    expect(asrConnection({ ...streamingOptions, endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime' }).url).toBe(streamingOptions.endpoint)
    expect(asrConnection({ model: 'qwen3-asr-flash-realtime', endpoint: streamingOptions.endpoint }).url)
      .toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
    expect(asrConnection({ ...streamingOptions, endpoint: 'wss://custom.example/api-ws/v1/realtime' }).url)
      .toBe('wss://custom.example/api-ws/v1/realtime')
    expect(asrConnection({ ...streamingOptions, endpoint: 'wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime' }).url)
      .toBe('wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')
  })
})

describe('bounded Qwen finalization', () => {
  it.each([false, true].flatMap(streaming => (['finished', 'timeout', 'cancelled', 'failed'] as const).map(result => ({ streaming, result }))))('records only bounded numeric finish diagnostics ($result, streaming=$streaming)', async ({ streaming, result }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(1000)
    const { session, socket } = await readySession(streaming)
    vi.mocked(trace).mockClear()
    const speech = 'Private synthetic speech must stay out of diagnostics'
    const providerError = `Private provider failure ${options.apiKey} ${options.endpoint}`
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text: speech, sentence_end: false }) :
      { type: 'conversation.item.input_audio_transcription.text', item_id: 'one', text: speech })
    const finish = session.finish()
    expect(session.finish()).toBe(finish)
    await vi.advanceTimersByTimeAsync(result === 'timeout' ? 2000 : 137)
    if (result === 'finished') {
      socket.message(finalEvent(socket, streaming, speech))
      socket.message(finishedEvent(socket, streaming))
    } else if (result === 'cancelled') session.stop()
    else if (result === 'failed') socket.message(streaming ? {
      ...taskEvent(socket, 'task-failed'), header: { ...taskEvent(socket, 'task-failed').header, error_message: providerError }
    } : { type: 'error', error: { message: providerError } })
    await expect(finish).resolves.toBe(result)
    socket.message(finishedEvent(socket, streaming)); socket.emit('close'); socket.emit('error', new Error(providerError)); session.stop()
    const diagnostics = vi.mocked(trace).mock.calls.filter(([event]) => event.startsWith('asr.finish-'))
    expect(diagnostics).toEqual([
      ['asr.finish-start', { streaming, timeoutMs: 2000 }],
      ['asr.finish-end', { streaming, ms: result === 'timeout' ? 2000 : 137, result }]
    ])
    const serialized = JSON.stringify(vi.mocked(trace).mock.calls)
    for (const privateValue of [speech, providerError, options.apiKey, options.endpoint]) expect(serialized).not.toContain(privateValue)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('times out at the original two-second deadline without losing received partials (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, socket, sockets, callbacks } = await readySession(streaming)
    socket.message(streaming ? taskEvent(socket, 'result-generated', { sentence_id: 1, text: 'Synthetic retained partial', sentence_end: false }) :
      { type: 'conversation.item.input_audio_transcription.text', item_id: 'one', text: 'Synthetic retained partial' })
    const owner = (session as unknown as { owner: { apiKey: string; buffered: Buffer[]; bytes: number; timer?: unknown; finishing?: unknown } }).owner
    let result: unknown
    const finish = session.finish()
    void finish.then(value => { result = value })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(session.finish()).toBe(finish)
    await vi.advanceTimersByTimeAsync(499)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await expect(finish).resolves.toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
    expect(owner).toMatchObject({ apiKey: '', buffered: [], bytes: 0, timer: undefined, finishing: undefined })
    expect(socket.terminate).toHaveBeenCalledOnce()
    socket.message(finalEvent(socket, streaming)); socket.message(finishedEvent(socket, streaming))
    socket.emit('close'); socket.emit('error', new Error('late after timeout'))
    expect(callbacks.onPartial.mock.calls.map(([text]) => text)).toEqual(['Synthetic retained partial'])
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('uses an injected finish deadline without changing startup timing', async () => {
    vi.useFakeTimers()
    const { session, socket } = await readySession(true, 25)
    const finish = session.finish()
    await vi.advanceTimersByTimeAsync(25)
    await expect(finish).resolves.toBe('timeout')
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('hard stop cancels finalization immediately and consumes every late event (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, socket, callbacks } = await readySession(streaming)
    const finish = session.finish()
    session.stop(); session.stop()
    await expect(finish).resolves.toBe('cancelled')
    expect(session.finish()).toBe(finish)
    expect(vi.getTimerCount()).toBe(0)
    socket.message(finalEvent(socket, streaming)); socket.message(finishedEvent(socket, streaming))
    socket.emit('error', new Error('late')); socket.emit('close')
    session.push(new ArrayBuffer(2))
    expect(socket.binary).toHaveLength(0)
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it.each([false, true])('a replacement start cancels the old finish and cannot be revived by it (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, socket: old, sockets, callbacks } = await readySession(streaming)
    const firstFinish = session.finish()
    const nextStart = session.start(streaming ? streamingOptions : options)
    await expect(firstFinish).resolves.toBe('cancelled')
    old.message(finalEvent(old, streaming)); old.message(finishedEvent(old, streaming))
    old.emit('close'); old.emit('error', new Error('old task error'))
    const next = sockets[1]
    next.open(); next.message(streaming ? taskEvent(next, 'task-started') : { type: 'session.updated' }); await nextStart
    expect(vi.getTimerCount()).toBe(0)
    const nextFinish = session.finish()
    expect(nextFinish).not.toBe(firstFinish)
    next.message(finalEvent(next, streaming, 'Only the new final'))
    next.message(finishedEvent(next, streaming))
    await expect(nextFinish).resolves.toBe('finished')
    await vi.advanceTimersByTimeAsync(2000)
    expect(callbacks.onSentence).toHaveBeenCalledExactlyOnceWith('Only the new final', expect.any(String))
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(old.terminate).toHaveBeenCalledOnce()
    expect(next.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('finishing before configuration acknowledgement cancels startup and its buffered audio (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, sockets, callbacks } = fixture()
    const start = session.start(streaming ? streamingOptions : options)
    const cancelled = expect(start).rejects.toThrow('取消')
    const socket = sockets[0]
    socket.open()
    session.push(new ArrayBuffer(2))
    const finish = session.finish()
    await cancelled
    await expect(finish).resolves.toBe('cancelled')
    expect(session.finish()).toBe(finish)
    socket.message(streaming ? taskEvent(socket, 'task-started') : { type: 'session.updated' })
    socket.message(finalEvent(socket, streaming))
    expect(socket.sent).toHaveLength(1)
    expect(socket.binary).toHaveLength(0)
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finishing an unopened or inactive session never opens a transport', async () => {
    vi.useFakeTimers()
    const { session, sockets } = fixture()
    const idle = session.finish()
    expect(session.finish()).toBe(idle)
    await expect(idle).resolves.toBe('cancelled')
    expect(sockets).toHaveLength(0)
    const start = session.start(options)
    const cancelled = expect(start).rejects.toThrow('取消')
    await expect(session.finish()).resolves.toBe('cancelled')
    await cancelled
    sockets[0].open()
    expect(sockets[0].sent).toHaveLength(0)
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('only the matching protocol completion can finish a task (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, socket, callbacks } = await readySession(streaming)
    let result: unknown
    const finish = session.finish()
    void finish.then(value => { result = value })
    if (streaming) {
      socket.message({ header: { event: 'task-finished', task_id: 'another-task' }, payload: {} })
      socket.message({ type: 'session.finished' })
      socket.message(taskEvent(socket, 'session.finished'))
    } else socket.message({ type: 'task-finished' })
    await Promise.resolve()
    expect(result).toBeUndefined()
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    socket.message(finishedEvent(socket, streaming))
    await expect(finish).resolves.toBe('finished')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('successful completion releases ownership before a synchronous close/error (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, socket, callbacks } = await readySession(streaming)
    const send = socket.send.bind(socket)
    vi.spyOn(socket, 'send').mockImplementation((value, callback) => {
      send(value, callback)
      socket.message(finishedEvent(socket, streaming))
    })
    socket.terminate.mockImplementation(() => {
      socket.readyState = WebSocket.CLOSED
      socket.emit('close'); socket.emit('error', new Error('synchronous teardown'))
    })
    await expect(session.finish()).resolves.toBe('finished')
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('runtime failure settles finish once, clears its timer and still notifies the owner (streaming=%s)', async streaming => {
    vi.useFakeTimers()
    const { session, socket, callbacks } = await readySession(streaming)
    const finish = session.finish()
    const failure = streaming ? taskEvent(socket, 'task-failed') : { type: 'error', error: { message: `Rejected ${options.apiKey}` } }
    if (streaming) (failure as { header: Record<string, unknown> }).header.error_message = `Rejected ${options.apiKey}`
    socket.message(failure)
    await expect(finish).resolves.toBe('failed')
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith('Rejected [已隐藏]')
    socket.emit('close'); socket.message(finishedEvent(socket, streaming)); socket.message(finalEvent(socket, streaming))
    expect(callbacks.onError).toHaveBeenCalledOnce()
    expect(callbacks.onSentence).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['close', 'error', 'send-throw', 'send-callback', 'not-open', 'backpressure'] as const)('settles failed rather than leaking a finish wait on %s', async failure => {
    vi.useFakeTimers()
    const { session, socket, callbacks } = await readySession(true)
    if (failure === 'send-throw') vi.spyOn(socket, 'send').mockImplementation(() => { throw new Error('send failed') })
    if (failure === 'send-callback') vi.spyOn(socket, 'send').mockImplementation((_value, callback) => callback?.(new Error('send failed')))
    if (failure === 'not-open') socket.readyState = WebSocket.CLOSED
    if (failure === 'backpressure') socket.bufferedAmount = 512_001
    const finish = session.finish()
    if (failure === 'close') socket.emit('close')
    if (failure === 'error') socket.emit('error', new Error('socket failed'))
    await expect(finish).resolves.toBe('failed')
    expect(callbacks.onError).toHaveBeenCalledOnce()
    socket.message(finishedEvent(socket, true))
    expect(callbacks.onError).toHaveBeenCalledOnce()
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a hard stop inside the final callback cancels the drain before dispatching its stash', async () => {
    vi.useFakeTimers()
    const { session, socket, callbacks } = await readySession(true)
    callbacks.onSentence.mockImplementation(() => session.stop())
    const finish = session.finish()
    socket.message(taskEvent(socket, 'result-generated', {
      sentence_id: 1, text: 'final', sentence_end: true, stash: { sentence_id: 2, text: 'must not dispatch' }
    }))
    await expect(finish).resolves.toBe('cancelled')
    expect(callbacks.onSentence).toHaveBeenCalledOnce()
    expect(callbacks.onPartial.mock.calls.map(([text]) => text)).toEqual([''])
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
