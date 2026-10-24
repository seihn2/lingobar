import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const application = vi.hoisted(() => ({ packaged: false, root: 'C:\\Synthetic LingoBar' }))
vi.mock('electron', () => ({ app: {
  get isPackaged() { return application.packaged },
  getAppPath: () => application.root
} }))
// A Linux/macOS CI worker must exercise the same path rules as a Windows host.
// Merely injecting dependencies.platform does not change node:path semantics.
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual, join: actual.win32.join, dirname: actual.win32.dirname, isAbsolute: actual.win32.isAbsolute }
})

import { NativeSystemAudioCapture, nativeSystemAudioHelperPath } from '../src/main/audio/native-capture'

class WindowsChild extends EventEmitter {
  pid: number | undefined = 12345
  exitCode: number | null = null
  signalCode: string | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)

  control(value: unknown): void { this.stderr.write(JSON.stringify(value) + '\r\n') }
  ready(): void { this.control({ type: 'ready', protocol: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' }) }
  close(code = 0): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code)
    this.emit('close', code)
  }
}

const cleanups: Array<() => void> = []
function fixture(options: { helper?: string; exists?: boolean } = {}) {
  const children: WindowsChild[] = []
  const spawn = vi.fn(() => {
    const child = new WindowsChild()
    children.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  })
  const capture = new NativeSystemAudioCapture({
    platform: 'win32', systemVersion: () => '10.0.26100',
    helperPath: () => options.helper ?? 'C:\\Synthetic LingoBar\\resources\\native\\system-audio-capture.exe',
    exists: () => options.exists !== false, spawn: spawn as never
  })
  const callbacks = { onAudio: vi.fn(), onError: vi.fn(), onFirstAudio: vi.fn() }
  cleanups.push(() => { capture.stop(); children.forEach(child => child.close()) })
  return { capture, children, callbacks, spawn }
}

function pcm(bytes = 4): Buffer {
  const packet = Buffer.alloc(bytes + 8)
  packet.write('PCM1')
  packet.writeUInt32LE(bytes, 4)
  return packet
}

function withWindowsProcess<T>(callback: () => T): T {
  const properties = ['platform', 'arch', 'resourcesPath'] as const
  const originals = new Map(properties.map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })
  Object.defineProperty(process, 'resourcesPath', { value: 'C:\\Program Files\\LingoBar\\resources', configurable: true })
  try { return callback() } finally {
    for (const key of properties) {
      const descriptor = originals.get(key)
      if (descriptor) Object.defineProperty(process, key, descriptor)
      else Reflect.deleteProperty(process, key)
    }
  }
}

afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  application.packaged = false
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('Windows helper boundary without devices or providers', () => {
  it('resolves only the development or packaged x64 helper, including paths with spaces', () => {
    vi.stubEnv('PATH', 'C:\\Untrusted Executables')
    vi.stubEnv('LINGOBAR_HELPER', 'https://example.invalid/capture.exe')
    withWindowsProcess(() => {
      expect(nativeSystemAudioHelperPath()).toBe('C:\\Synthetic LingoBar\\resources\\native\\win-x64\\system-audio-capture.exe')
      application.packaged = true
      expect(nativeSystemAudioHelperPath()).toBe('C:\\Program Files\\LingoBar\\resources\\native\\system-audio-capture.exe')
    })
  })

  it('launches a hidden process with its parent lifetime and no inherited service credentials', async () => {
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) vi.stubEnv(key, `C:\\Synthetic\\${key}`)
    vi.stubEnv('DASHSCOPE_API_KEY', 'synthetic-not-a-real-key')
    vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-not-a-real-key')
    vi.stubEnv('GH_TOKEN', 'synthetic-not-a-real-token')
    const f = fixture()
    const id = randomUUID()
    const starting = f.capture.start(id, f.callbacks)
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
      'C:\\Synthetic LingoBar\\resources\\native\\system-audio-capture.exe',
      ['--capture', '--parent-pid', String(process.pid)],
      {
        cwd: 'C:\\Synthetic LingoBar\\resources\\native', windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].map(key => [key, `C:\\Synthetic\\${key}`]))
      }
    )
    f.children[0].ready()
    await starting
    expect(f.callbacks.onAudio).not.toHaveBeenCalled()
    f.capture.stop()
    expect(f.children[0].stdin.writableEnded).toBe(true)
  })

  it.each([
    { helper: 'system-audio-capture.exe', exists: true },
    { helper: 'https://example.invalid/system-audio-capture.exe', exists: true },
    { helper: 'C:\\LingoBar\\missing.exe', exists: false }
  ])('rejects an absent or nonlocal helper without searching PATH: $helper', async options => {
    const f = fixture(options)
    await expect(f.capture.start(randomUUID(), f.callbacks)).rejects.toThrow('helper-missing')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('does not launch for an invalid request identifier', async () => {
    const f = fixture()
    await expect(f.capture.start('not-a-request', f.callbacks)).rejects.toThrow('invalid-request')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it.each(['device-unavailable', 'permission-denied', 'format-unsupported'] as const)(
    'preserves the startup error %s, then allows a fresh request after retirement', async code => {
      const f = fixture()
      const id = randomUUID()
      const rejected = expect(f.capture.start(id, f.callbacks)).rejects.toThrow(code)
      f.children[0].control({ type: 'stage', stage: 'reading-output' })
      f.children[0].control({ type: 'error', code })
      await rejected
      expect(f.capture.activate(id)).toBe(false)
      expect(f.children[0].stdin.writableEnded).toBe(true)
      expect(f.callbacks.onError).not.toHaveBeenCalled()
      f.children[0].close(1)
      const next = f.capture.start(randomUUID(), f.callbacks)
      f.children[1].ready()
      await next
    }
  )

  it('stops both forwarding and stale helper callbacks when a ready capture is switched', async () => {
    const f = fixture()
    const oldId = randomUUID()
    const first = f.capture.start(oldId, f.callbacks)
    f.children[0].ready()
    await first
    expect(f.capture.activate(oldId)).toBe(true)
    f.children[0].stdout.write(pcm())
    expect(f.callbacks.onAudio).toHaveBeenCalledTimes(1)
    const currentId = randomUUID()
    const next = f.capture.start(currentId, f.callbacks)
    expect(f.children).toHaveLength(1)
    expect(f.children[0].stdin.writableEnded).toBe(true)
    f.children[0].stdout.write(pcm())
    f.children[0].control({ type: 'error', code: 'device-unavailable' })
    expect(f.callbacks.onAudio).toHaveBeenCalledTimes(1)
    expect(f.callbacks.onError).not.toHaveBeenCalled()
    f.children[0].close()
    await Promise.resolve(); await Promise.resolve()
    f.children[1].stdout.write(pcm())
    f.children[1].ready()
    await next
    expect(f.capture.activate(oldId)).toBe(false)
    expect(f.capture.activate(currentId)).toBe(true)
    expect(f.callbacks.onAudio).toHaveBeenCalledTimes(2)
    // A delayed UI stop belonging to the old request cannot stop the new one.
    f.capture.stop(oldId)
    expect(f.capture.isCurrent(currentId)).toBe(true)
  })

  it('refuses overlapping capture when a retired helper ignores EOF and termination', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const first = f.capture.start(randomUUID(), f.callbacks)
    f.children[0].ready()
    await first
    f.capture.stop()
    const busy = expect(f.capture.start(randomUUID(), f.callbacks)).rejects.toThrow('busy')
    await vi.advanceTimersByTimeAsync(2000)
    await busy
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.children[0].kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    f.children[0].close()
    const next = f.capture.start(randomUUID(), f.callbacks)
    f.children[1].ready()
    await next
    expect(f.spawn).toHaveBeenCalledTimes(2)
  })

  it('bounds queued PCM before activation and does not forward a later stale frame', async () => {
    const f = fixture()
    const id = randomUUID()
    const first = f.capture.start(id, f.callbacks)
    f.children[0].ready()
    await first
    for (let index = 0; index < 7; index++) f.children[0].stdout.write(pcm(8192))
    f.children[0].stdout.write(pcm(6656))
    expect(f.callbacks.onAudio).not.toHaveBeenCalled()
    expect(f.capture.isCurrent(id)).toBe(true)
    f.children[0].stdout.write(pcm(2))
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith('buffer-overflow')
    expect(f.capture.activate(id)).toBe(false)
    f.children[0].stdout.write(pcm())
    expect(f.callbacks.onAudio).not.toHaveBeenCalled()
  })

  it.each([false, true])('reports one terminal error after an unexpected helper exit (truncated=%s)', async truncated => {
    const f = fixture()
    const id = randomUUID()
    const first = f.capture.start(id, f.callbacks)
    f.children[0].ready()
    await first
    expect(f.capture.activate(id)).toBe(true)
    if (truncated) f.children[0].stdout.write(pcm().subarray(0, 9))
    f.children[0].close(1)
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(truncated ? 'protocol-error' : 'transport-error')
    expect(f.capture.isCurrent(id)).toBe(false)
    f.children[0].control({ type: 'error', code: 'device-unavailable' })
    expect(f.callbacks.onError).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate ready messages rather than silently restarting a live stream', async () => {
    const f = fixture()
    const first = f.capture.start(randomUUID(), f.callbacks)
    f.children[0].ready()
    await first
    f.children[0].ready()
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith('protocol-error')
    expect(f.children[0].stdin.writableEnded).toBe(true)
  })

  it('releases a failed spawn and permits another start without waiting on a nonexistent PID', async () => {
    const f = fixture()
    const rejected = expect(f.capture.start(randomUUID(), f.callbacks)).rejects.toThrow('transport-error')
    f.children[0].pid = undefined
    f.children[0].emit('error', new Error('synthetic spawn failure'))
    await rejected
    const next = f.capture.start(randomUUID(), f.callbacks)
    expect(f.children).toHaveLength(2)
    f.children[1].ready()
    await next
  })
})
