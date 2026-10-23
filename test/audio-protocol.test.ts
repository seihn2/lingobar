import { describe, expect, it } from 'vitest'
import { NativeSystemAudioFrameParser, parseNativeSystemAudioMessage } from '../src/main/audio/native-protocol'
function packet(samples: number[]): Buffer {
  const payload = Buffer.from(new Int16Array(samples).buffer)
  const header = Buffer.alloc(8)
  header.write('PCM1'); header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}
describe('native PCM protocol', () => {
  it('reassembles multiple packets fragmented across every header and payload boundary', () => {
    const parser = new NativeSystemAudioFrameParser()
    const bytes = Buffer.concat([packet([123, -456]), packet([789])])
    const frames: Uint8Array[] = []
    for (const byte of bytes) frames.push(...parser.push(Uint8Array.of(byte)))
    expect(frames.map((frame) => [...new Int16Array(frame.buffer)])).toEqual([[123, -456], [789]])
    expect(() => parser.finish()).not.toThrow()
  })
  it('rejects corrupt headers, unbounded lengths, and truncated final frames', () => {
    const bad = packet([1]); bad.writeUInt32LE(0xffffffff, 4)
    expect(() => new NativeSystemAudioFrameParser().push(bad)).toThrow('protocol-error')
    expect(() => new NativeSystemAudioFrameParser().push(Buffer.from('NOTPCM00'))).toThrow('protocol-error')
    const parser = new NativeSystemAudioFrameParser()
    parser.push(packet([1]).subarray(0, 9))
    expect(() => parser.finish()).toThrow('protocol-error')
  })
  it('only accepts the exact known sample rate and bounded control schema', () => {
    const ready = { type: 'ready', protocol: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' }
    expect(parseNativeSystemAudioMessage(JSON.stringify(ready))).toEqual(ready)
    expect(() => parseNativeSystemAudioMessage(JSON.stringify({ ...ready, sampleRate: 48000 }))).toThrow()
    expect(() => parseNativeSystemAudioMessage(JSON.stringify({ ...ready, arbitrary: 'data' }))).toThrow()
    expect(() => parseNativeSystemAudioMessage('x'.repeat(4097))).toThrow()
  })
})
