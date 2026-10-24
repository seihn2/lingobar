import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listMicrophones, MICROPHONE_WORKLET, startMicrophone } from '../src/renderer/microphone'

describe('microphone worklet', () => {
  it.each([16000, 44100, 48000])('preserves sample count and amplitude across quantum boundaries at %i Hz', (rate) => {
    let Processor: new () => { process(inputs: Float32Array[][]): boolean }
    const chunks: ArrayBuffer[] = []
    runInNewContext(MICROPHONE_WORKLET, {
      AudioWorkletProcessor: class { port = { postMessage: (buffer: ArrayBuffer) => chunks.push(buffer) } },
      sampleRate: rate,
      registerProcessor: (_name: string, value: typeof Processor) => { Processor = value }
    })
    const processor = new Processor!()
    // Exactly three seconds of synthetic stereo PCM. No device APIs are used.
    const sampleCount = rate * 3
    for (let offset = 0; offset < sampleCount; offset += 128) {
      const length = Math.min(128, sampleCount - offset)
      processor.process([[new Float32Array(length).fill(0.75), new Float32Array(length).fill(0.25)]])
    }
    const produced = chunks.reduce((total, buffer) => total + buffer.byteLength / 2, 0)
    expect(produced).toBeGreaterThanOrEqual(46_400)
    expect(produced).toBeLessThanOrEqual(48_000)
    for (const chunk of chunks) expect([...new Int16Array(chunk)].every((sample) => Math.abs(sample - 16384) <= 1)).toBe(true)
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('microphone permission lifecycle', () => {
  it('stops a late permission grant after startup timeout', async () => {
    vi.useFakeTimers()
    let resolve!: (stream: MediaStream) => void
    const track = { stop: vi.fn() }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>((done) => { resolve = done }) } })
    const result = expect(startMicrophone(vi.fn(), vi.fn())).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(30_001)
    await result
    resolve({ getTracks: () => [track] } as unknown as MediaStream)
    await Promise.resolve(); await Promise.resolve()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('cancels a pending permission request immediately and releases a late stream', async () => {
    let resolve!: (stream: MediaStream) => void
    const track = { stop: vi.fn() }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(done => { resolve = done }) } })
    const controller = new AbortController()
    const result = expect(startMicrophone(vi.fn(), vi.fn(), { signal: controller.signal })).rejects.toThrow('已取消')
    controller.abort()
    await result
    resolve({ getTracks: () => [track] } as unknown as MediaStream)
    await Promise.resolve(); await Promise.resolve()
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('passes an exact selected device and never falls back silently when that device is missing', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('synthetic unavailable device', 'OverconstrainedError'))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    await expect(startMicrophone(vi.fn(), vi.fn(), { deviceId: 'fixture-microphone', platform: 'win32' })).rejects.toThrow('所选麦克风')
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: false, audio: expect.objectContaining({ deviceId: { exact: 'fixture-microphone' } }) })
  })

  it('shows Windows desktop microphone permission guidance and preserves macOS guidance', async () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new DOMException('synthetic rejection', 'NotAllowedError')) } })
    await expect(startMicrophone(vi.fn(), vi.fn(), { platform: 'win32' })).rejects.toThrow('允许桌面应用访问麦克风')
    await expect(startMicrophone(vi.fn(), vi.fn(), { platform: 'darwin' })).rejects.toThrow('隐私与安全性 → 麦克风')
  })

  it('lists metadata without prompting for microphone access', async () => {
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications' },
      { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
      { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
      { kind: 'audioinput', deviceId: 'fixture-a', label: 'Synthetic microphone' },
      { kind: 'audioinput', deviceId: 'fixture-b', label: '' }
    ]) } })
    expect(await listMicrophones()).toEqual([
      { deviceId: 'fixture-a', label: 'Synthetic microphone' },
      { deviceId: 'fixture-b', label: '麦克风 2（授权后显示名称）' }
    ])
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

function activeFixture(deviceId = 'fixture-a') {
  const track = { stop: vi.fn(), onended: null as (() => void) | null }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  const events = new Map<string, () => void>()
  const mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue(stream),
    enumerateDevices: vi.fn().mockResolvedValue([{ kind: 'audioinput', deviceId }]),
    addEventListener: vi.fn((name: string, listener: () => void) => { events.set(name, listener) }),
    removeEventListener: vi.fn((name: string) => { events.delete(name) })
  }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const muted = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } }
  const context = { audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) }, createMediaStreamSource: () => source, createGain: () => muted,
    destination: {}, state: 'running', resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), onstatechange: null }
  const worklet = { port: { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null }, onprocessorerror: null, connect: vi.fn(), disconnect: vi.fn() }
  vi.stubGlobal('navigator', { mediaDevices })
  vi.stubGlobal('AudioContext', vi.fn(function () { return context }))
  vi.stubGlobal('AudioWorkletNode', vi.fn(function () { return worklet }))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-worklet')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { track, mediaDevices, events, context, worklet, source, muted }
}

describe('active microphone device lifecycle', () => {
  afterEach(() => vi.restoreAllMocks())
  it('stops every resource on unplug, rejects subsequent PCM and permits a fresh device start', async () => {
    const f = activeFixture()
    const onChunk = vi.fn(), onError = vi.fn()
    const stop = await startMicrophone(onChunk, onError, { deviceId: 'fixture-a' })
    const latePcm = f.worklet.port.onmessage!
    latePcm({ data: new ArrayBuffer(3200) })
    expect(onChunk).toHaveBeenCalledOnce()
    f.mediaDevices.enumerateDevices.mockResolvedValueOnce([])
    f.events.get('devicechange')!()
    await Promise.resolve(); await Promise.resolve()
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('所选麦克风已断开'))
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.context.close).toHaveBeenCalledOnce()
    expect(f.source.disconnect).toHaveBeenCalledOnce()
    expect(f.worklet.disconnect).toHaveBeenCalledOnce()
    expect(f.muted.disconnect).toHaveBeenCalledOnce()
    expect(f.events.has('devicechange')).toBe(false)
    latePcm({ data: new ArrayBuffer(3200) })
    expect(onChunk).toHaveBeenCalledOnce()
    stop()
    expect(f.track.stop).toHaveBeenCalledOnce()
    const next = activeFixture('fixture-b')
    const stopNext = await startMicrophone(onChunk, onError, { deviceId: 'fixture-b' })
    expect(next.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: 'fixture-b' } }) }))
    stopNext()
    expect(next.track.stop).toHaveBeenCalledOnce()
  })

  it('pauses a default microphone when devices change rather than silently rerouting', async () => {
    const f = activeFixture()
    const onError = vi.fn()
    await startMicrophone(vi.fn(), onError, { deviceId: 'default' })
    expect(f.mediaDevices.getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.not.objectContaining({ deviceId: expect.anything() }) }))
    f.events.get('devicechange')!()
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('当前默认麦克风'))
    expect(f.track.stop).toHaveBeenCalledOnce()
  })

  it('keeps an explicitly selected device active when an unrelated device is added', async () => {
    const f = activeFixture()
    const onError = vi.fn()
    const stop = await startMicrophone(vi.fn(), onError, { deviceId: 'fixture-a' })
    f.mediaDevices.enumerateDevices.mockResolvedValueOnce([{ kind: 'audioinput', deviceId: 'fixture-a' }, { kind: 'audioinput', deviceId: 'fixture-b' }])
    f.events.get('devicechange')!()
    await Promise.resolve(); await Promise.resolve()
    expect(onError).not.toHaveBeenCalled()
    expect(f.track.stop).not.toHaveBeenCalled()
    stop()
  })
})
