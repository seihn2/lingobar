import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MICROPHONE_WORKLET, startMicrophone } from '../src/renderer/microphone'

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
})
