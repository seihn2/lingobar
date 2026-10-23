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
      const session = { callbacks, start: vi.fn(async () => {}), stop: vi.fn(), push: vi.fn() }
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
})
