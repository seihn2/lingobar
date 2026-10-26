import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkerAsr } from '../src/worker/asr'
import type { FinalizedLimits } from '../src/shared/finalized-utterances'
import { RelayError, type AsrModel, type RelayConfig, type UpgradeResponse, type WorkerAsr, type WorkerFetch, type WorkerSocket } from '../src/worker/types'

vi.mock('electron', () => { throw new Error('Workers ASR must not load Electron') })
vi.mock('ws', () => { throw new Error('Workers ASR must not load Node ws') })
vi.mock('../src/main/diagnostics', () => { throw new Error('Workers ASR must not load desktop diagnostics') })

class Socket extends EventTarget implements WorkerSocket {
  readyState = 0
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  listenerTypes = new Set<string>()
  onAccept?: () => void
  onSend?: () => void
  accept = vi.fn(() => {
    expect([...this.listenerTypes].sort()).toEqual(['close', 'error', 'message'])
    this.readyState = 1; this.onAccept?.()
  })
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.dispatchEvent(new Event('close')) })
  send = vi.fn((data: string | ArrayBuffer | ArrayBufferView) => {
    if (this.readyState !== 1) throw new Error('Synthetic transport is closed')
    this.sent.push(data); this.onSend?.()
  })
  override addEventListener(type: string, callback: (event: Event) => void) { this.listenerTypes.add(type); super.addEventListener(type, callback) }
  override removeEventListener(type: string, callback: (event: Event) => void) { this.listenerTypes.delete(type); super.removeEventListener(type, callback) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })) }
  json(): any[] { return this.sent.filter((value): value is string => typeof value === 'string').map(value => JSON.parse(value)) }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve() }
const instances = new Set<WorkerAsr>()
const key = 'SYNTHETIC-ASR-SERVER-SECRET'
const translationKey = 'SYNTHETIC-TRANSLATION-SERVER-SECRET'
function fixture(model: AsrModel = 'qwen-audio-3.1-asr-flash-streaming', finalizedLimits?: FinalizedLimits) {
  const sockets: Socket[] = [], ids: string[] = []
  const controller = new AbortController()
  const callbacks = { onTranscript: vi.fn(), onError: vi.fn() }
  const fetch = vi.fn<WorkerFetch>(async () => {
    const socket = new Socket(); sockets.push(socket)
    return { status: 101, webSocket: socket } as unknown as UpgradeResponse
  })
  const asr = createWorkerAsr({ asrKey: key, translationKey, model }, callbacks, {
    fetch, signal: controller.signal, startupMs: 1000, finalizedLimits, id: () => { const id = `synthetic-task-${ids.length + 1}`; ids.push(id); return id }
  })
  instances.add(asr)
  const streaming = model !== 'qwen3-asr-flash-realtime'
  const event = (socket: Socket, kind: string, sentence?: Record<string, unknown>) => streaming
    ? { header: { event: kind, task_id: socket.json()[0].header.task_id }, payload: sentence ? { output: { sentence } } : {} }
    : { type: kind, ...sentence }
  const transcript = (socket: Socket, text: string, partial = true, id: string | number = streaming ? 1 : 'one') => socket.message(streaming
    ? event(socket, 'result-generated', { sentence_id: id, text, sentence_end: !partial })
    : event(socket, partial ? 'conversation.item.input_audio_transcription.text' : 'conversation.item.input_audio_transcription.completed',
      { item_id: id, ...(partial ? { text } : { transcript: text }) }))
  const ack = (socket: Socket) => socket.message(event(socket, streaming ? 'task-started' : 'session.updated'))
  const ready = async () => { const promise = asr.start(); await settle(); const socket = sockets.at(-1)!; ack(socket); await promise; return socket }
  return { asr, sockets, callbacks, controller, fetch, ids, streaming, event, transcript, ack, ready }
}
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  for (const asr of instances) asr.stop()
  instances.clear(); await settle()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

describe('Workers ASR fixed upstream and synthetic lifecycle', () => {
  it.each(['qwen-audio-3.1-asr-flash-streaming', 'qwen3-asr-flash-realtime'] as const)('fails closed on finalized ID count/size exhaustion for %s and requires an explicit new owner', async model => {
    for (const budget of ['count', 'units']) {
      const streaming = model !== 'qwen3-asr-flash-realtime'
      const f = fixture(model, budget === 'count' ? { maxIds: 2, maxUnits: 100 } : { maxIds: 100, maxUnits: streaming ? 2 : 12 }), socket = await f.ready()
      const item = (id: number) => f.streaming ? id : `item-${id}`
      f.transcript(socket, 'Synthetic first', false, item(1)); f.transcript(socket, 'Synthetic second', false, item(2))
      f.transcript(socket, 'Synthetic duplicate', false, item(1))
      expect(f.callbacks.onTranscript).toHaveBeenCalledTimes(2); expect(f.callbacks.onError).not.toHaveBeenCalled()
      const oldId = f.callbacks.onTranscript.mock.calls[0][0].id
      f.transcript(socket, 'Over budget', false, item(3)); f.transcript(socket, 'Late old', true, item(1)); f.asr.stop()
      expect(f.callbacks.onTranscript).toHaveBeenCalledTimes(2); expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('quota'))
      expect(socket.close).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce()
      const next = await f.ready()
      f.transcript(socket, 'Late old owner', false, item(4)); f.transcript(next, 'Synthetic fresh', false, item(1))
      expect(f.callbacks.onTranscript).toHaveBeenCalledTimes(3); expect(f.callbacks.onTranscript.mock.calls[2][0].id).not.toBe(oldId)
      f.asr.stop()
    }
  })
  it.each(['qwen-audio-3.1-asr-flash-streaming', 'qwen3-asr-flash-realtime'] as const)('retains early finalized %s IDs after 257 finals', async model => {
    const f = fixture(model), socket = await f.ready()
    for (let id = 1; id <= 257; id++) f.transcript(socket, `Synthetic final ${id}`, false, f.streaming ? id : `item-${id}`)
    f.callbacks.onTranscript.mockClear()
    f.transcript(socket, 'Late synthetic partial', true, f.streaming ? 1 : 'item-1')
    f.transcript(socket, 'Duplicate synthetic final', false, f.streaming ? 1 : 'item-1')
    expect(f.callbacks.onTranscript).not.toHaveBeenCalled()
    f.transcript(socket, 'Synthetic current final', false, f.streaming ? 258 : 'item-258')
    expect(f.callbacks.onTranscript).toHaveBeenCalledOnce()
  })
  it.each(['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'qwen3-asr-flash-realtime'] as const)('uses only the fixed %s route and server-side authorization', async model => {
    const f = fixture(model)
    expect(f.fetch).not.toHaveBeenCalled()
    const socket = await f.ready()
    const [url, request] = f.fetch.mock.calls[0]
    expect(url).toBe(f.streaming ? 'https://dashscope.aliyuncs.com/api-ws/v1/inference' : 'https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
    expect(request).toMatchObject({ redirect: 'error', headers: { Upgrade: 'websocket', Authorization: `Bearer ${key}` } })
    expect(request!.signal).toBeInstanceOf(AbortSignal)
    expect(socket.accept).toHaveBeenCalledOnce()
    expect(JSON.stringify(socket.json())).not.toContain(key)
    expect(JSON.stringify(f.fetch.mock.calls)).not.toContain(translationKey)
    expect(socket.json()[0]).toMatchObject(f.streaming
      ? { header: { action: 'run-task', task_id: f.ids[0], streaming: 'duplex' }, payload: { model, parameters: { format: 'pcm', sample_rate: 16000, heartbeat: true }, input: {} } }
      : { type: 'session.update', event_id: expect.any(String), session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { type: 'server_vad' } } })
  })

  it('only the matching configuration acknowledgement enables streaming binary PCM', async () => {
    const f = fixture(); let resolved = false
    const starting = f.asr.start().then(() => { resolved = true }); await settle()
    const socket = f.sockets[0], pcm = new Uint8Array([0, 127, 255, 1]).buffer
    f.asr.push(pcm)
    socket.message({ header: { event: 'task-started', task_id: 'other-task' } })
    socket.message({ type: 'session.updated' }); await settle()
    expect(resolved).toBe(false); expect(socket.sent).toHaveLength(1)
    f.ack(socket); await starting
    f.asr.push(pcm)
    expect(socket.sent.at(-1)).toBe(pcm)
    expect('bufferedAmount' in socket).toBe(false)
  })

  it('encodes realtime PCM with standard base64 after session.updated, without Node Buffer', async () => {
    const f = fixture('qwen3-asr-flash-realtime'), starting = f.asr.start(); await settle()
    const socket = f.sockets[0]
    socket.message({ type: 'session.created' }); f.asr.push(new ArrayBuffer(2))
    expect(socket.sent).toHaveLength(1)
    f.ack(socket); await starting
    const bytes = Uint8Array.from({ length: 64_000 }, (_, index) => index % 256)
    f.asr.push(bytes.buffer)
    const audio = socket.json()[1]
    expect(audio.type).toBe('input_audio_buffer.append')
    expect(Uint8Array.from(atob(audio.audio), character => character.charCodeAt(0))).toEqual(bytes)
    expect(typeof audio.event_id).toBe('string')
  })

  it('preserves streaming final/stash order, next-sentence growth and completed-item deduplication', async () => {
    const f = fixture(), socket = await f.ready(), prefix = f.ids[0]
    f.transcript(socket, 'Synthetic prefix')
    for (const text of ['今日は', '今日は晴れ']) socket.message(f.event(socket, 'result-generated', {
      sentence_id: 1, text: 'Synthetic final 👩‍💻', sentence_end: true, stash: { sentence_id: 2, text }
    }))
    socket.message(f.event(socket, 'result-generated', { sentence_id: 2, text: '今日は晴れ。', sentence_end: true }))
    socket.message(f.event(socket, 'result-generated', { sentence_id: 1, text: 'duplicate', sentence_end: true, stash: { sentence_id: 2, text: 'late' } }))
    expect(f.callbacks.onTranscript.mock.calls.map(([value]) => value)).toEqual([
      { partial: true, text: 'Synthetic prefix', id: `${prefix}:1` },
      { partial: false, text: 'Synthetic final 👩‍💻', id: `${prefix}:1` },
      { partial: true, text: '今日は', id: `${prefix}:2` },
      { partial: true, text: '今日は晴れ', id: `${prefix}:2` },
      { partial: false, text: '今日は晴れ。', id: `${prefix}:2` }
    ])
  })

  it('keeps realtime confirmed text plus stash together and forwards an empty final exactly once', async () => {
    const f = fixture('qwen3-asr-flash-realtime'), socket = await f.ready(), id = `${f.ids[0]}:one`
    socket.message({ type: 'conversation.item.input_audio_transcription.text', item_id: 'one', text: '今日', stash: 'は𠮷' })
    f.transcript(socket, '', false); f.transcript(socket, 'late', true); f.transcript(socket, 'duplicate', false)
    expect(f.callbacks.onTranscript.mock.calls.map(([value]) => value)).toEqual([
      { partial: true, text: '今日は𠮷', id }, { partial: false, text: '', id }
    ])
  })

  it('ignores streaming heartbeats, wrong tasks and unlabelled stash without inventing a reading', async () => {
    const f = fixture(), socket = await f.ready()
    socket.message(f.event(socket, 'result-generated', { sentence_id: 0, text: 'Synthetic heartbeat', heartbeat: true }))
    socket.message({ header: { event: 'result-generated', task_id: 'wrong-task' }, payload: { output: { sentence: { text: 'Wrong task' } } } })
    socket.message(f.event(socket, 'result-generated', { sentence_id: 1, text: 'Only this text', stash: { text: 'not a documented suffix' } }))
    expect(f.callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith({ partial: true, text: 'Only this text', id: `${f.ids[0]}:1` })
  })

  it('stopping inside a final callback prevents the same envelope stash from escaping', async () => {
    const f = fixture(), socket = await f.ready()
    f.callbacks.onTranscript.mockImplementation(value => { if (!value.partial) f.asr.stop() })
    socket.message(f.event(socket, 'result-generated', { sentence_id: 1, text: 'Final', sentence_end: true, stash: { sentence_id: 2, text: 'Must not escape' } }))
    expect(f.callbacks.onTranscript).toHaveBeenCalledOnce()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(f.callbacks.onError).not.toHaveBeenCalled()
  })

  it('handles a synchronous configuration acknowledgement only after listeners and acceptance', async () => {
    const f = fixture(), socket = new Socket()
    socket.onSend = () => { f.ack(socket) }
    f.fetch.mockResolvedValueOnce({ status: 101, webSocket: socket } as unknown as UpgradeResponse)
    await f.asr.start()
    expect(socket.accept).toHaveBeenCalledOnce()
    expect(socket.send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('consumes provider failures after readiness without leaking provider text (streaming=%s)', async streaming => {
    const f = fixture(streaming ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'), socket = await f.ready()
    socket.message(streaming ? {
      ...f.event(socket, 'task-failed'), header: { ...f.event(socket, 'task-failed').header, error_message: key }
    } : { type: 'conversation.item.input_audio_transcription.failed', error: { message: key } })
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('upstream'))
    expect(f.callbacks.onTranscript).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 429, 400, 500, 200])('classifies HTTP %s without disclosing a response or server key', async status => {
    const f = fixture(), cancel = vi.fn(async () => {})
    f.fetch.mockResolvedValueOnce({ status, body: { cancel } } as unknown as UpgradeResponse)
    await expect(f.asr.start()).rejects.toMatchObject({ name: 'RelayError', code: status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'quota' : 'upstream' })
    expect(cancel).toHaveBeenCalledOnce(); expect(f.callbacks.onError).not.toHaveBeenCalled()
  })

  it('rejects a non-upgraded response even if an unexpected socket is attached, and closes it', async () => {
    const f = fixture(), socket = new Socket()
    f.fetch.mockResolvedValueOnce({ status: 200, webSocket: socket } as unknown as UpgradeResponse)
    await expect(f.asr.start()).rejects.toMatchObject({ code: 'upstream' })
    expect(socket.close).toHaveBeenCalledOnce(); expect(socket.accept).not.toHaveBeenCalled()
  })

  it.each(['stop', 'abort', 'timeout'] as const)('hard-cancels a pending upgrade on %s and closes the late socket without accepting it', async reason => {
    const f = fixture(), upgrade = deferred<UpgradeResponse>(), socket = new Socket()
    f.fetch.mockReturnValueOnce(upgrade.promise)
    const start = f.asr.start(), rejection = expect(start).rejects.toMatchObject({ code: reason === 'timeout' ? 'upstream' : 'unavailable' })
    if (reason === 'stop') f.asr.stop()
    else if (reason === 'abort') f.controller.abort()
    else await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(f.fetch.mock.calls[0][1]!.signal!.aborted).toBe(true)
    upgrade.resolve({ status: 101, webSocket: socket } as unknown as UpgradeResponse); await settle()
    expect(socket.close).toHaveBeenCalledOnce(); expect(socket.accept).not.toHaveBeenCalled()
    expect(socket.sent).toHaveLength(0); expect(f.callbacks.onError).not.toHaveBeenCalled()
  })

  it.each([false, true])('clears startup acknowledgement timeout and ignores every post-stop event (streaming=%s)', async streaming => {
    const f = fixture(streaming ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime')
    const starting = f.asr.start(), rejection = expect(starting).rejects.toMatchObject({ code: 'upstream' }); await settle()
    const socket = f.sockets[0]
    await vi.advanceTimersByTimeAsync(1000); await rejection
    f.ack(socket); f.transcript(socket, 'Late secret', false); socket.dispatchEvent(new Event('error')); socket.dispatchEvent(new Event('close'))
    f.asr.push(new ArrayBuffer(2))
    expect(f.callbacks.onTranscript).not.toHaveBeenCalled(); expect(f.callbacks.onError).not.toHaveBeenCalled()
    expect(socket.sent).toHaveLength(1); expect(socket.listenerTypes.size).toBe(0)
  })

  it.each([false, true])('abort releases an active socket and suppresses all late events (streaming=%s)', async streaming => {
    const f = fixture(streaming ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'), socket = await f.ready()
    f.controller.abort(); f.controller.abort(); f.asr.stop()
    f.transcript(socket, 'Late speech', false); socket.dispatchEvent(new Event('error'))
    expect(socket.close).toHaveBeenCalledOnce(); expect(f.callbacks.onTranscript).not.toHaveBeenCalled(); expect(f.callbacks.onError).not.toHaveBeenCalled()
    await expect(f.asr.start()).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it.each([false, true])('restarts with isolated owner/utterance IDs and ignores old transport errors (streaming=%s)', async streaming => {
    const f = fixture(streaming ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'), old = await f.ready()
    f.transcript(old, 'First run', false)
    const current = await f.ready()
    f.transcript(old, 'Must not return', false); old.dispatchEvent(new Event('error')); old.dispatchEvent(new Event('close'))
    f.transcript(current, 'New run', false)
    const values = f.callbacks.onTranscript.mock.calls.map(([value]) => value)
    expect(values.map(value => value.text)).toEqual(['First run', 'New run'])
    expect(values[0].id).not.toBe(values[1].id); expect(f.callbacks.onError).not.toHaveBeenCalled()
    expect(old.close).toHaveBeenCalledOnce()
  })

  it.each([0, 1, 64_002, 'not audio', new Uint8Array(2)])('fails an invalid current PCM frame as protocol without sending it (%s)', async value => {
    const f = fixture(), socket = await f.ready(), before = socket.sent.length
    f.asr.push((typeof value === 'number' ? new ArrayBuffer(value) : value) as ArrayBuffer)
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('protocol'))
    expect(socket.sent).toHaveLength(before); expect(socket.close).toHaveBeenCalledOnce()
  })

  it.each(['close', 'error', 'provider', 'send', 'accept', 'fetch'] as const)('releases transport failure %s once with a fixed public classification', async failure => {
    const f = fixture()
    if (failure === 'fetch') {
      f.fetch.mockRejectedValueOnce(new Error(`Private ${key} ${translationKey}`))
      await expect(f.asr.start()).rejects.toMatchObject({ code: 'upstream', message: 'upstream' }); return
    }
    if (failure === 'accept') {
      const socket = new Socket(); socket.accept.mockImplementation(() => { throw new Error(key) })
      f.fetch.mockResolvedValueOnce({ status: 101, webSocket: socket } as unknown as UpgradeResponse)
      await expect(f.asr.start()).rejects.toMatchObject({ code: 'upstream', message: 'upstream' })
      expect(socket.close).toHaveBeenCalledOnce(); return
    }
    const socket = await f.ready()
    if (failure === 'provider') socket.message({ ...f.event(socket, 'task-failed'), header: { ...f.event(socket, 'task-failed').header, error_message: `Private ${key}` } })
    else if (failure === 'send') { socket.send.mockImplementation(() => { throw new Error(key) }); f.asr.push(new ArrayBuffer(2)) }
    else socket.dispatchEvent(new Event(failure))
    socket.dispatchEvent(new Event('error')); f.asr.stop()
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('upstream'))
    expect(JSON.stringify(f.callbacks.onError.mock.calls)).not.toContain(key)
    expect(socket.close).toHaveBeenCalledOnce()
  })

  it.each([false, true])('rejects invalid/oversized packets and text before exposing transcripts (streaming=%s)', async streaming => {
    for (const value of ['{bad JSON', '[]', '語'.repeat(50_000), new ArrayBuffer(2)]) {
      const f = fixture(streaming ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'), socket = await f.ready()
      if (typeof value === 'string') socket.message(value)
      else socket.dispatchEvent(new MessageEvent('message', { data: value }))
      expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('protocol'))
      expect(f.callbacks.onTranscript).not.toHaveBeenCalled()
    }
    for (const text of ['x'.repeat(8001), '\ud800', 'bad\u0000speech']) {
      const f = fixture(streaming ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime'), socket = await f.ready()
      f.transcript(socket, text)
      expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('protocol'))
      expect(f.callbacks.onTranscript).not.toHaveBeenCalled()
    }
  })

  it('validates the entire final/stash envelope before dispatching a valid-looking prefix', async () => {
    const f = fixture(), socket = await f.ready()
    socket.message(f.event(socket, 'result-generated', { sentence_id: 1, text: 'Valid final', sentence_end: true, stash: { sentence_id: 2, text: 'x'.repeat(8001) } }))
    expect(f.callbacks.onTranscript).not.toHaveBeenCalled()
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(new RelayError('protocol'))
  })

  it('never fetches for missing secrets, unsupported models, invalid IDs or an already-aborted owner', async () => {
    for (const config of [{ asrKey: '', model: 'qwen3-asr-flash-realtime' }, { asrKey: 'secret\ninvalid', model: 'qwen3-asr-flash-realtime' },
      { asrKey: key, model: 'untrusted-provider' }]) {
      const fetch = vi.fn<WorkerFetch>(), controller = new AbortController()
      const asr = createWorkerAsr({ ...config, translationKey } as RelayConfig, { onTranscript: vi.fn(), onError: vi.fn() }, { fetch, signal: controller.signal, id: () => 'synthetic' })
      await expect(asr.start()).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' }); expect(fetch).not.toHaveBeenCalled()
    }
    const f = fixture(); f.controller.abort(); await expect(f.asr.start()).rejects.toMatchObject({ code: 'unavailable' }); expect(f.fetch).not.toHaveBeenCalled()
    const fetch = vi.fn<WorkerFetch>(), asr = createWorkerAsr({ asrKey: key, translationKey, model: 'qwen3-asr-flash-realtime' }, { onTranscript: vi.fn(), onError: vi.fn() }, { fetch, signal: new AbortController().signal, id: () => '' })
    await expect(asr.start()).rejects.toMatchObject({ code: 'unavailable' }); expect(fetch).not.toHaveBeenCalled()
  })
})
