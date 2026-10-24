import { randomUUID } from 'node:crypto'
import type { AudioSource, CaptureMode, ListeningState } from '../../shared/types'
import { NativeSystemAudioCapture, type NativeSystemAudioCallbacks } from './native-capture'
import { QwenAsrSession, type AsrCallbacks, type AsrOptions, type AsrSession } from './qwen'
import { desktopPlatform, platformLabels } from '../../shared/platform'

export interface AudioCallbacks {
  onPartial(source: AudioSource, text: string, utteranceId?: string): void
  onSentence(source: AudioSource, text: string, utteranceId?: string): void
  onState(state: ListeningState, message: string): void
  onError(message: string): void
}
export interface AudioOptions extends AsrOptions { mode: CaptureMode }
interface Capture {
  start(id: string, callbacks: NativeSystemAudioCallbacks): Promise<void>
  activate(id: string): boolean
  stop(): void
}
interface Dependencies {
  createAsr(callbacks: AsrCallbacks): AsrSession
  capture: Capture
}
interface Run { id: string; sessions: Partial<Record<AudioSource, AsrSession>> }

const platform = desktopPlatform(process.platform)
const labels = platformLabels(platform)
const nativeErrors: Record<string, string> = {
  unsupported: labels.unsupportedAudio,
  'permission-denied': labels.systemPermission,
  'device-unavailable': '声音输出设备发生变化或不可用，请重新开始。',
  'format-unsupported': '当前声音设备的音频格式不受支持。',
  'helper-missing': '系统声音组件缺失，请重新安装 LingoBar。',
  'startup-timeout': '系统声音启动超时，请检查系统授权后重新开始。',
  'buffer-overflow': '声音缓冲已满，请重新开始。',
  busy: '上一次声音采集仍在退出，请稍后重新开始。',
  cancelled: '已取消启动。'
}

/** All callbacks belong to a single run; stopping invalidates both audio sources immediately. */
export class AudioEngine {
  private owner: Run | null = null
  private dependencies: Dependencies

  constructor(private callbacks: AudioCallbacks, dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      createAsr: (callbacks) => new QwenAsrSession(callbacks),
      capture: new NativeSystemAudioCapture(),
      ...dependencies
    }
  }

  async start(options: AudioOptions): Promise<void> {
    this.release()
    const owner: Run = { id: randomUUID(), sessions: {} }
    this.owner = owner
    this.callbacks.onState('starting', '正在连接语音识别…')
    try {
      if (!['system', 'microphone', 'both'].includes(options.mode)) throw new Error('请选择声音来源。')
      if (!options.apiKey.trim()) throw new Error('请先在设置中填写语音识别 API Key。')
      const sources: AudioSource[] = options.mode === 'both' ? ['system', 'microphone'] : [options.mode]
      for (const source of sources) {
        owner.sessions[source] = this.dependencies.createAsr({
          onPartial: (text, utteranceId) => { if (this.owns(owner)) this.callbacks.onPartial(source, text, utteranceId) },
          onSentence: (text, utteranceId) => { if (this.owns(owner)) this.callbacks.onSentence(source, text, utteranceId) },
          onError: (message) => this.fail(owner, message)
        })
      }
      await Promise.all(sources.map((source) => owner.sessions[source]!.start(options)))
      if (!this.owns(owner)) throw new Error('已取消启动。')
      if (sources.includes('system')) {
        this.callbacks.onState('starting', platform === 'win32' ? '正在启动电脑声音（WASAPI）…' : '正在启动电脑声音，请允许系统音频录制…')
        await this.dependencies.capture.start(owner.id, {
          onAudio: (chunk) => { if (this.owns(owner)) owner.sessions.system?.push(chunk) },
          onError: (code) => this.fail(owner, nativeErrors[code] || '系统声音采集已中断，请重新开始。')
        })
        if (!this.owns(owner)) throw new Error('已取消启动。')
        if (!this.dependencies.capture.activate(owner.id)) throw new Error('系统声音启动失败，请重新开始。')
      }
      if (!this.owns(owner)) throw new Error('已取消启动。')
      this.callbacks.onState('listening', options.mode === 'both' ? '正在听电脑声音和麦克风' : options.mode === 'system' ? '正在听电脑声音' : '正在听麦克风')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const message = nativeErrors[code] || (error instanceof Error ? error.message : '声音启动失败，请重试。')
      if (this.owns(owner)) this.fail(owner, message)
      throw new Error(message)
    }
  }

  stop(): void {
    this.release()
    this.callbacks.onState('idle', '已暂停')
  }

  pushMicrophone(chunk: ArrayBuffer): void { this.owner?.sessions.microphone?.push(chunk) }

  private owns(owner: Run): boolean { return this.owner === owner }
  private fail(owner: Run, message: string): void {
    if (!this.owns(owner)) return
    this.release()
    this.callbacks.onState('error', message)
    this.callbacks.onError(message)
  }
  private release(): void {
    const owner = this.owner
    this.owner = null
    this.dependencies.capture.stop()
    if (owner) for (const session of Object.values(owner.sessions)) session.stop()
  }
}
