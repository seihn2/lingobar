import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/synthetic-app' } }))
import { AudioEngine } from '../src/main/audio'
import type { AsrCallbacks, AsrSession } from '../src/main/audio/qwen'
import type { NativeSystemAudioCallbacks } from '../src/main/audio/native-capture'

const options = { mode: 'both' as const, apiKey: 'test', model: 'test', endpoint: 'wss://example.invalid' }
function fixture() {
  const callbacks = { onPartial: vi.fn(), onSentence: vi.fn(), onState: vi.fn(), onError: vi.fn() }
  const sessions: (AsrSession & { callbacks: AsrCallbacks })[] = []
  let nativeCallbacks: NativeSystemAudioCallbacks | undefined
  const capture = {
    start: vi.fn(async (_id: string, callbacks: NativeSystemAudioCallbacks) => { nativeCallbacks = callbacks }),
    activate: vi.fn(() => true), stop: vi.fn()
  }
  const engine = new AudioEngine(callbacks, {
    capture,
    createAsr: (callbacks) => {
      const session = { callbacks, start: vi.fn(async () => {}), stop: vi.fn(), push: vi.fn(), finish: vi.fn(async () => 'finished' as const) }
      sessions.push(session)
      return session
    }
  })
  return { engine, callbacks, capture, sessions, getNativeCallbacks: () => nativeCallbacks! }
}
describe('audio engine', () => {
  it('keeps system and microphone recognition and PCM routing separate', async () => {
    const f = fixture()
    await f.engine.start(options)
    const pcm = new Int16Array([1, 2]).buffer
    f.engine.pushMicrophone(pcm)
    f.getNativeCallbacks().onAudio(pcm)
    expect(f.sessions[0].push).toHaveBeenCalledExactlyOnceWith(pcm)
    expect(f.sessions[1].push).toHaveBeenCalledExactlyOnceWith(pcm)
    f.sessions[0].callbacks.onPartial('system draft', 'system-session:1')
    f.sessions[0].callbacks.onSentence('system words', 'system-session:1')
    f.sessions[1].callbacks.onSentence('microphone words', 'microphone-session:1')
    expect(f.callbacks.onPartial.mock.calls).toEqual([['system', 'system draft', 'system-session:1']])
    expect(f.callbacks.onSentence.mock.calls).toEqual([['system', 'system words', 'system-session:1'], ['microphone', 'microphone words', 'microphone-session:1']])
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('listening', expect.any(String))
    f.engine.stop()
  })
  it('releases all sources on failure and rejects stale callbacks after a new start', async () => {
    const f = fixture()
    await f.engine.start(options)
    const old = f.sessions.slice()
    const native = f.getNativeCallbacks()
    old[0].callbacks.onError('Disconnected')
    expect(old.every((session) => vi.mocked(session.stop).mock.calls.length === 1)).toBe(true)
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('error', 'Disconnected')
    await f.engine.start({ ...options, mode: 'microphone' })
    old[0].callbacks.onSentence('stale'); old[1].callbacks.onPartial('stale')
    native.onError('device-unavailable')
    expect(f.callbacks.onSentence).not.toHaveBeenCalled()
    expect(f.callbacks.onPartial).not.toHaveBeenCalled()
    expect(f.callbacks.onError).toHaveBeenCalledTimes(1)
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('listening', expect.any(String))
    f.engine.stop()
  })
  it('microphone-only mode never starts native system capture', async () => {
    const f = fixture()
    await f.engine.start({ ...options, mode: 'microphone' })
    expect(f.capture.start).not.toHaveBeenCalled()
    expect(f.sessions).toHaveLength(1)
    f.engine.stop()
    f.engine.pushMicrophone(new ArrayBuffer(2))
    expect(f.sessions[0].push).not.toHaveBeenCalled()
  })
  it('forwards empty final boundaries and supports providers without utterance IDs', async () => {
    const f = fixture()
    await f.engine.start({ ...options, mode: 'microphone' })
    f.sessions[0].callbacks.onSentence('', 'microphone-session:1')
    f.sessions[0].callbacks.onPartial('legacy draft')
    f.sessions[0].callbacks.onSentence('legacy final')
    expect(f.callbacks.onPartial).toHaveBeenCalledExactlyOnceWith('microphone', 'legacy draft', undefined)
    expect(f.callbacks.onSentence.mock.calls).toEqual([
      ['microphone', '', 'microphone-session:1'], ['microphone', 'legacy final', undefined]
    ])
    f.engine.stop()
  })
  it('cannot become listening when stopped during native startup', async () => {
    const f = fixture()
    let finish!: () => void
    f.capture.start.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const starting = f.engine.start(options)
    const cancelled = expect(starting).rejects.toThrow('取消')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    f.engine.stop()
    finish()
    await cancelled
    expect(f.capture.activate).not.toHaveBeenCalled()
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('idle', expect.any(String))
  })
  it('does not create capture or model sessions without a key', async () => {
    const f = fixture()
    await expect(f.engine.start({ ...options, apiKey: '' })).rejects.toThrow('API Key')
    expect(f.sessions).toHaveLength(0)
    expect(f.capture.start).not.toHaveBeenCalled()
  })
  it('stops both device inputs immediately while allowing their already-sent tail results', async () => {
    const f = fixture()
    await f.engine.start(options)
    let finishSystem!: (value: 'finished') => void
    let finishMic!: (value: 'finished') => void
    vi.mocked(f.sessions[0].finish).mockImplementation(() => new Promise(resolve => { finishSystem = resolve }))
    vi.mocked(f.sessions[1].finish).mockImplementation(() => new Promise(resolve => { finishMic = resolve }))
    const stopping = f.engine.pause()
    expect(f.engine.pause()).toBe(stopping)
    expect(f.capture.stop).toHaveBeenCalledTimes(2) // Initial cleanup, then pause.
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('idle', expect.stringContaining('最后一句'))
    const pcm = new Int16Array([1, 2]).buffer
    f.engine.pushMicrophone(pcm); f.getNativeCallbacks().onAudio(pcm)
    expect(f.sessions.every(session => vi.mocked(session.push).mock.calls.length === 0)).toBe(true)
    await Promise.resolve()
    f.sessions[0].callbacks.onSentence('Synthetic system tail', 'system:1')
    f.sessions[1].callbacks.onSentence('Synthetic microphone tail', 'microphone:1')
    expect(f.callbacks.onSentence.mock.calls).toEqual([
      ['system', 'Synthetic system tail', 'system:1'], ['microphone', 'Synthetic microphone tail', 'microphone:1']
    ])
    finishSystem('finished'); finishMic('finished')
    await expect(stopping).resolves.toBe('finished')
    f.sessions[0].callbacks.onPartial('late')
    expect(f.callbacks.onPartial).not.toHaveBeenCalled()
    expect(f.callbacks.onError).not.toHaveBeenCalled()
  })
  it('returns timeout without restarting audio or discarding the last received partial', async () => {
    const f = fixture()
    await f.engine.start({ ...options, mode: 'microphone' })
    vi.mocked(f.sessions[0].finish).mockResolvedValue('timeout')
    f.sessions[0].callbacks.onPartial('Synthetic last partial', 'mic:1')
    await expect(f.engine.pause()).resolves.toBe('timeout')
    expect(f.callbacks.onPartial).toHaveBeenCalledExactlyOnceWith('microphone', 'Synthetic last partial', 'mic:1')
    expect(f.callbacks.onError).not.toHaveBeenCalled()
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('idle', expect.stringContaining('超时'))
    expect(f.sessions[0].start).toHaveBeenCalledOnce()
  })
  it('hard-cancels an in-progress pause before a new owner starts and ignores its late completion', async () => {
    const f = fixture()
    await f.engine.start({ ...options, mode: 'microphone' })
    let finish!: (value: 'finished') => void
    vi.mocked(f.sessions[0].finish).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const stopping = f.engine.pause(); await Promise.resolve()
    await f.engine.start({ ...options, mode: 'microphone' })
    f.sessions[0].callbacks.onSentence('old tail', 'old:1')
    finish('finished')
    await expect(stopping).resolves.toBe('cancelled')
    expect(f.callbacks.onSentence).not.toHaveBeenCalled()
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('listening', expect.any(String))
    expect(f.sessions[1].stop).not.toHaveBeenCalled()
    f.engine.stop()
  })
  it('still fails both sources when either recognition service fails while finishing', async () => {
    const f = fixture()
    await f.engine.start(options)
    let finish!: (value: 'cancelled') => void
    vi.mocked(f.sessions[0].finish).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const stopping = f.engine.pause(); await Promise.resolve()
    f.sessions[1].callbacks.onError('Synthetic service error')
    finish('cancelled')
    await expect(stopping).resolves.toBe('cancelled')
    expect(f.sessions.every(session => vi.mocked(session.stop).mock.calls.length === 1)).toBe(true)
    expect(f.callbacks.onState).toHaveBeenLastCalledWith('error', 'Synthetic service error')
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith('Synthetic service error')
  })
  it('cancels startup without sending a finish request', async () => {
    const f = fixture()
    let ready!: () => void
    f.capture.start.mockImplementationOnce(() => new Promise(resolve => { ready = resolve }))
    const starting = f.engine.start(options)
    const cancelled = expect(starting).rejects.toThrow('取消')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    await expect(f.engine.pause()).resolves.toBe('cancelled')
    ready(); await cancelled
    expect(f.sessions.every(session => vi.mocked(session.finish).mock.calls.length === 0)).toBe(true)
    expect(f.capture.activate).not.toHaveBeenCalled()
  })
})
