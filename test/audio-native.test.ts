import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/synthetic-app' } }))
import { NativeSystemAudioCapture } from '../src/main/audio/native-capture'

class Child extends EventEmitter {
  pid = 12345
  exitCode: number | null = null
  signalCode: string | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  close(): void { this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0) }
  ready(): void { this.stderr.write(JSON.stringify({ type: 'ready', protocol: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' }) + '\n') }
}
function fixture() {
  const children: Child[] = []
  const capture = new NativeSystemAudioCapture({
    platform: 'darwin', systemVersion: () => '14.2', helperPath: () => '/synthetic/helper', exists: () => true,
    spawn: vi.fn(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcessWithoutNullStreams }) as never
  })
  const callbacks = { onAudio: vi.fn(), onError: vi.fn() }
  return { capture, children, callbacks }
}
afterEach(() => vi.useRealTimers())
describe('native capture lifecycle without devices', () => {
  it('buffers valid PCM until ready and activation, then forwards once', async () => {
    const f = fixture()
    const id = randomUUID()
    const start = f.capture.start(id, f.callbacks)
    const header = Buffer.alloc(8); header.write('PCM1'); header.writeUInt32LE(4, 4)
    f.children[0].stdout.write(Buffer.concat([header, Buffer.from([1, 0, 2, 0])]))
    expect(f.callbacks.onAudio).not.toHaveBeenCalled()
    expect(f.capture.activate(id)).toBe(false)
    f.children[0].ready(); await start
    expect(f.capture.activate(id)).toBe(true)
    expect([...new Int16Array(f.callbacks.onAudio.mock.calls[0][0])]).toEqual([1, 2])
    f.capture.activate(id)
    expect(f.callbacks.onAudio).toHaveBeenCalledOnce()
    f.capture.stop(); f.children[0].close()
  })
  it('cancels immediately and waits for the old helper to exit before spawning another', async () => {
    const f = fixture()
    const oldId = randomUUID()
    const cancelled = expect(f.capture.start(oldId, f.callbacks)).rejects.toThrow('cancelled')
    f.capture.stop()
    await cancelled
    f.children[0].ready()
    expect(f.capture.activate(oldId)).toBe(false)
    const id = randomUUID()
    const restarted = f.capture.start(id, f.callbacks)
    expect(f.children).toHaveLength(1)
    f.children[0].close()
    await Promise.resolve(); await Promise.resolve()
    expect(f.children).toHaveLength(2)
    f.children[1].ready(); await restarted
    f.capture.stop(); f.children[1].close()
    expect(f.callbacks.onError).not.toHaveBeenCalled()
  })
  it('times out a stalled helper and escalates process cleanup', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const timeout = expect(f.capture.start(randomUUID(), f.callbacks)).rejects.toThrow('startup-timeout')
    await vi.advanceTimersByTimeAsync(30_000)
    await timeout
    expect(f.children[0].stdin.writableEnded).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.children[0].kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    f.children[0].close()
  })
})
