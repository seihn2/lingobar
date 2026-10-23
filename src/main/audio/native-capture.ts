import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  NativeSystemAudioError,
  NativeSystemAudioFrameParser,
  NATIVE_AUDIO_PRE_ACTIVATE_BYTES,
  parseNativeSystemAudioMessage,
  parseNativeSystemAudioRequestId,
  type NativeAudioStartupStage,
  type NativeSystemAudioDiagnostics,
  type NativeSystemAudioErrorCode
} from './native-protocol'

export interface NativeSystemAudioCallbacks {
  onAudio: (chunk: ArrayBuffer) => void
  /** First valid PCM is already held in the pre-activation buffer. */
  onFirstAudio?: () => void
  onError: (code: NativeSystemAudioErrorCode) => void
  onDiagnostics?: (payload: NativeSystemAudioDiagnostics) => void
  onStage?: (stage: NativeAudioStartupStage) => void
}

interface CaptureDependencies {
  platform: NodeJS.Platform
  systemVersion: () => string
  helperPath: () => string
  exists: (path: string) => boolean
  spawn: typeof spawn
}

interface CaptureOwner {
  requestId: string
  callbacks: NativeSystemAudioCallbacks
  promise: Promise<void>
  resolve: () => void
  reject: (error: NativeSystemAudioError) => void
  settled: boolean
  ready: boolean
  active: boolean
  firstAudio: boolean
  terminal: boolean
  child?: ChildProcessWithoutNullStreams
  startupTimer?: ReturnType<typeof setTimeout>
  parser: NativeSystemAudioFrameParser
  stderr: string
  buffered: Uint8Array[]
  bufferedBytes: number
  chunks: number
  lastDiagnosticsAt: number | null
  seenStages: Set<NativeAudioStartupStage>
}

interface Retirement {
  promise: Promise<boolean>
  finish: () => void
}

/** Resolve the bundled executable for this platform/architecture, never search PATH. */
export function nativeSystemAudioHelperPath(): string {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? join(process.resourcesPath, 'native', 'system-audio-capture.exe')
      : join(
          app.getAppPath(),
          'resources',
          'native',
          `win-${process.arch}`,
          'system-audio-capture.exe'
        )
  }
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'system-audio-capture')
    : join(app.getAppPath(), 'resources', 'native', 'system-audio-capture')
}

function supportsAudioTap(version: string): boolean {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) return false
  const [major, minor] = version.split('.').map(Number)
  return major > 14 || (major === 14 && minor >= 2)
}

/** Request-owned, audio-only macOS/Windows helper transport. No capture before start(). */
export class NativeSystemAudioCapture {
  private readonly dependencies: CaptureDependencies
  private owner: CaptureOwner | null = null
  private readonly retiring = new Map<ChildProcessWithoutNullStreams, Retirement>()
  private readonly closedRequests = new Set<string>()

  constructor(dependencies: Partial<CaptureDependencies> = {}) {
    this.dependencies = {
      platform: process.platform,
      systemVersion: () => process.getSystemVersion?.() ?? '',
      helperPath: nativeSystemAudioHelperPath,
      exists: existsSync,
      spawn,
      ...dependencies
    }
  }

  start(requestId: string, callbacks: NativeSystemAudioCallbacks): Promise<void> {
    const id = parseNativeSystemAudioRequestId(requestId)
    if (!id) return Promise.reject(new NativeSystemAudioError('invalid-request'))
    if (
      this.dependencies.platform !== 'win32' &&
      (this.dependencies.platform !== 'darwin' ||
        !supportsAudioTap(this.dependencies.systemVersion()))
    )
      return Promise.reject(new NativeSystemAudioError('unsupported'))
    if (this.owner?.requestId === id && !this.owner.terminal) return this.owner.promise
    if (this.closedRequests.has(id)) return Promise.reject(new NativeSystemAudioError('cancelled'))
    this.stop()
    let resolve!: () => void
    let reject!: (error: NativeSystemAudioError) => void
    const promise = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    const owner: CaptureOwner = {
      requestId: id,
      callbacks,
      promise,
      resolve,
      reject,
      settled: false,
      ready: false,
      active: false,
      firstAudio: false,
      terminal: false,
      parser: new NativeSystemAudioFrameParser(),
      stderr: '',
      buffered: [],
      bufferedBytes: 0,
      chunks: 0,
      lastDiagnosticsAt: null,
      seenStages: new Set()
    }
    this.owner = owner
    void this.launch(owner).catch(() => this.fail(owner, 'transport-error'))
    return promise
  }

  isCurrent(requestId: string): boolean {
    return (
      this.owner?.requestId === parseNativeSystemAudioRequestId(requestId) && !this.owner?.terminal
    )
  }

  activate(requestId: string): boolean {
    const owner = this.owner
    if (!owner || !owner.ready || !this.isCurrent(requestId)) return false
    if (owner.active) return true
    owner.active = true
    const buffered = owner.buffered
    owner.buffered = []
    owner.bufferedBytes = 0
    for (const frame of buffered) {
      if (!this.owns(owner)) return false
      this.forward(owner, frame)
    }
    return this.owns(owner)
  }

  /** Invalidates immediately. Independent retirement never delays cancellation. */
  stop(requestId?: string): void {
    const owner = this.owner
    if (!owner || (requestId !== undefined && !this.isCurrent(requestId))) return
    this.fail(owner, 'cancelled', false)
  }

  private owns(owner: CaptureOwner): boolean {
    return this.owner === owner && !owner.terminal
  }

  private async launch(owner: CaptureOwner): Promise<void> {
    if (this.retiring.size) {
      const reaped = await Promise.all([...this.retiring.values()].map((entry) => entry.promise))
      if (!this.owns(owner)) return
      if (reaped.some((value) => !value) || this.retiring.size) {
        this.fail(owner, 'busy')
        return
      }
    }
    if (!this.owns(owner)) return
    const path = this.dependencies.helperPath()
    if (!isAbsolute(path) || !this.dependencies.exists(path)) {
      this.fail(owner, 'helper-missing')
      return
    }
    const child = this.dependencies.spawn(
      path,
      ['--capture', '--parent-pid', String(process.pid)],
      {
        cwd: dirname(path),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.dependencies.platform === 'win32' ? { windowsHide: true } : {}),
        env:
          this.dependencies.platform === 'win32'
            ? Object.fromEntries(
                ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
                  .filter((key) => process.env[key] !== undefined)
                  .map((key) => [key, process.env[key]])
              )
            : process.env.LANG
              ? { LANG: process.env.LANG }
              : {}
      }
    ) as ChildProcessWithoutNullStreams
    owner.child = child
    owner.startupTimer = setTimeout(() => this.fail(owner, 'startup-timeout'), 30000)
    owner.startupTimer.unref()
    child.stdout.on('data', (chunk: Buffer) => this.receiveAudio(owner, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.receiveControl(owner, chunk))
    child.stdin.on('error', () => this.fail(owner, 'transport-error'))
    child.stdout.on('error', () => this.fail(owner, 'transport-error'))
    child.stderr.on('error', () => this.fail(owner, 'transport-error'))
    child.once('error', () => {
      this.fail(owner, 'transport-error')
      if (!child.pid) this.retiring.get(child)?.finish()
    })
    const exited = (): void => {
      if (this.owns(owner)) {
        let code: NativeSystemAudioErrorCode = 'transport-error'
        try {
          owner.parser.finish()
        } catch {
          code = 'protocol-error'
        }
        this.fail(owner, code)
      }
      this.retiring.get(child)?.finish()
    }
    child.once('exit', exited)
    child.once('close', exited)
    child.stdout.once('end', () => {
      if (!this.owns(owner)) return
      try {
        owner.parser.finish()
      } catch {
        this.fail(owner, 'protocol-error')
        return
      }
      this.fail(owner, 'transport-error')
    })
  }

  private receiveControl(owner: CaptureOwner, chunk: string): void {
    if (!this.owns(owner)) return
    if (chunk.length > 8192 || owner.stderr.length + chunk.length > 8192) {
      this.fail(owner, 'protocol-error')
      return
    }
    owner.stderr += chunk
    let newline: number
    while ((newline = owner.stderr.indexOf('\n')) >= 0) {
      const line = owner.stderr.slice(0, newline).replace(/\r$/, '')
      owner.stderr = owner.stderr.slice(newline + 1)
      if (!line) continue
      try {
        const message = parseNativeSystemAudioMessage(line)
        if (message.type === 'error') {
          this.fail(owner, message.code)
          return
        }
        if (owner.ready) throw new NativeSystemAudioError('protocol-error')
        if (message.type === 'stage') {
          if (owner.seenStages.has(message.stage))
            throw new NativeSystemAudioError('protocol-error')
          owner.seenStages.add(message.stage)
          // Stages are diagnostics only. They never resolve start or extend its deadline.
          try {
            owner.callbacks.onStage?.(message.stage)
          } catch {
            /* Diagnostic observer only. */
          }
          if (!this.owns(owner)) return
          continue
        }
        owner.ready = true
        owner.settled = true
        if (owner.startupTimer) clearTimeout(owner.startupTimer)
        owner.startupTimer = undefined
        owner.resolve()
      } catch {
        this.fail(owner, 'protocol-error')
        return
      }
      if (!this.owns(owner)) return
    }
    if (owner.stderr.length > 4096) this.fail(owner, 'protocol-error')
  }

  private receiveAudio(owner: CaptureOwner, chunk: Uint8Array): void {
    if (!this.owns(owner)) return
    try {
      for (const frame of owner.parser.push(chunk)) {
        if (!this.owns(owner)) return
        if (owner.active) this.forward(owner, frame)
        else {
          if (owner.bufferedBytes + frame.byteLength > NATIVE_AUDIO_PRE_ACTIVATE_BYTES)
            throw new NativeSystemAudioError('buffer-overflow')
          owner.buffered.push(frame)
          owner.bufferedBytes += frame.byteLength
        }
        if (!this.owns(owner)) return
        if (!owner.firstAudio) {
          owner.firstAudio = true
          try {
            owner.callbacks.onFirstAudio?.()
          } catch {
            this.fail(owner, 'asr-start-failed')
            return
          }
        }
      }
    } catch (error) {
      this.fail(owner, error instanceof NativeSystemAudioError ? error.code : 'transport-error')
    }
  }

  private forward(owner: CaptureOwner, frame: Uint8Array): void {
    if (!this.owns(owner)) return
    try {
      owner.callbacks.onAudio(frame.slice().buffer)
    } catch {
      this.fail(owner, 'asr-start-failed')
      return
    }
    if (!this.owns(owner)) return
    owner.chunks += 1
    const now = Date.now()
    if (
      !owner.callbacks.onDiagnostics ||
      (owner.lastDiagnosticsAt !== null && now - owner.lastDiagnosticsAt < 250)
    )
      return
    owner.lastDiagnosticsAt = now
    const pcm = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    let peak = 0
    let squares = 0
    for (let index = 0; index < frame.byteLength; index += 2) {
      const sample = pcm.getInt16(index, true) / 32768
      peak = Math.max(peak, Math.abs(sample))
      squares += sample * sample
    }
    try {
      owner.callbacks.onDiagnostics({
        requestId: owner.requestId,
        chunks: owner.chunks,
        level: peak,
        rms: Math.sqrt(squares / (frame.byteLength / 2))
      })
    } catch {
      /* Diagnostic observers cannot keep or kill an audio capture. */
    }
  }

  private fail(owner: CaptureOwner, code: NativeSystemAudioErrorCode, notify = true): void {
    if (!this.owns(owner)) return
    owner.terminal = true
    this.owner = null
    this.closedRequests.add(owner.requestId)
    while (this.closedRequests.size > 128)
      this.closedRequests.delete(this.closedRequests.values().next().value!)
    if (owner.startupTimer) clearTimeout(owner.startupTimer)
    owner.startupTimer = undefined
    owner.buffered = []
    owner.bufferedBytes = 0
    owner.stderr = ''
    if (owner.child) this.retire(owner.child)
    if (!owner.settled) {
      owner.settled = true
      owner.reject(new NativeSystemAudioError(code))
    } else if (notify) {
      try {
        owner.callbacks.onError(code)
      } catch {
        /* Terminal cleanup is already complete. */
      }
    }
  }

  private retire(child: ChildProcessWithoutNullStreams): void {
    if (this.retiring.has(child)) return
    let resolve!: (reaped: boolean) => void
    const promise = new Promise<boolean>((done) => {
      resolve = done
    })
    const timers: ReturnType<typeof setTimeout>[] = []
    const entry: Retirement = {
      promise,
      finish: () => {
        for (const timer of timers) clearTimeout(timer)
        this.retiring.delete(child)
        resolve(true)
      }
    }
    this.retiring.set(child, entry)
    if (child.exitCode !== null || child.signalCode !== null) {
      entry.finish()
      return
    }
    const kill = (signal: NodeJS.Signals): void => {
      if (!this.retiring.has(child)) return
      try {
        child.kill(signal)
      } catch {
        /* Reap deadline remains authoritative. */
      }
    }
    // End the lifetime channel now; escalation runs independently of parser/output work.
    try {
      child.stdin.end()
    } catch {
      kill('SIGTERM')
    }
    timers.push(setTimeout(() => kill('SIGTERM'), 250))
    timers.push(setTimeout(() => kill('SIGKILL'), 1000))
    timers.push(setTimeout(() => resolve(false), 2000))
    for (const timer of timers) timer.unref()
  }
}
