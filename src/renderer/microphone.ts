import { platformLabels, validMicrophoneDeviceId, type DesktopPlatform } from '../shared/platform'

/** PCM16 mono capture, with stateful resampling when a device ignores 16 kHz. */
export const MICROPHONE_WORKLET = `
class LingoMicrophone extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = []
    this.position = 0
    this.step = sampleRate / 16000
    this.pcm = new Int16Array(1600)
    this.fill = 0
  }
  process(inputs) {
    const channels = inputs[0]
    if (!channels || !channels[0]) return true
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0
      for (const channel of channels) sample += channel[index] || 0
      this.samples.push(sample / channels.length)
    }
    while (this.position + 1 < this.samples.length) {
      const index = Math.floor(this.position)
      const fraction = this.position - index
      const value = Math.max(-1, Math.min(1,
        this.samples[index] * (1 - fraction) + this.samples[index + 1] * fraction))
      this.pcm[this.fill++] = Math.round(value < 0 ? value * 32768 : value * 32767)
      this.position += this.step
      if (this.fill === this.pcm.length) {
        const buffer = this.pcm.buffer
        this.port.postMessage(buffer, [buffer])
        this.pcm = new Int16Array(1600)
        this.fill = 0
      }
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length)
    this.samples.splice(0, consumed)
    this.position -= consumed
    return true
  }
}
registerProcessor('lingobar-microphone', LingoMicrophone)
`

function captureMessage(error: unknown, platform: DesktopPlatform): string {
  if (error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name))
    return platformLabels(platform).microphonePermission
  if (error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) return '没有找到所选麦克风，请连接设备或改选默认麦克风。'
  if (error instanceof DOMException && ['NotReadableError', 'AbortError'].includes(error.name)) return '麦克风不可用，可能被其他应用占用或已断开，请检查后重新开始。'
  return error instanceof Error ? error.message : '麦克风启动失败，请检查设备和权限。'
}

export interface MicrophoneOptions { deviceId?: string; platform?: DesktopPlatform; signal?: AbortSignal }
export interface MicrophoneDevice { deviceId: string; label: string }

/** Lists metadata only; this never asks for access or starts recording. */
export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) throw new Error('当前环境无法列出麦克风设备。')
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(device => device.kind === 'audioinput' && !['default', 'communications'].includes(device.deviceId))
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `麦克风 ${index + 1}（授权后显示名称）` }))
    .filter(device => validMicrophoneDeviceId(device.deviceId))
}

export async function startMicrophone(
  onChunk: (chunk: ArrayBuffer) => void,
  onError: (message: string) => void,
  options: MicrophoneOptions = {}
): Promise<() => void> {
  const deviceId = options.deviceId || 'default'
  if (!validMicrophoneDeviceId(deviceId)) throw new Error('请选择有效的麦克风设备。')
  const platform = options.platform || 'other'
  if (options.signal?.aborted) throw new Error('已取消麦克风启动。')
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风，请在 LingoBar 应用中使用。')
  let stream: MediaStream | undefined
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let worklet: AudioWorkletNode | undefined
  let muted: GainNode | undefined
  let url: string | undefined
  let stopped = false
  let started = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let deviceChange: (() => void) | undefined
  let abort: (() => void) | undefined
  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    if (deviceChange) navigator.mediaDevices.removeEventListener?.('devicechange', deviceChange)
    if (abort) options.signal?.removeEventListener('abort', abort)
    for (const track of stream?.getTracks() || []) { track.onended = null; track.stop() }
    if (worklet) { worklet.port.onmessage = null; worklet.onprocessorerror = null; worklet.disconnect() }
    source?.disconnect()
    muted?.disconnect()
    if (context) { context.onstatechange = null; void context.close().catch(() => {}) }
    if (url) URL.revokeObjectURL(url)
  }
  const fail = (message: string): void => { if (stopped) return; stop(); onError(message) }
  let rejectTimeout!: (error: Error) => void
  const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject })
  abort = () => { stop(); rejectTimeout(new Error('已取消麦克风启动。')) }
  options.signal?.addEventListener('abort', abort, { once: true })
  timer = setTimeout(() => { stop(); rejectTimeout(new Error('麦克风启动超时，请检查权限后重新开始。')) }, 30_000)

  const startup = async (): Promise<void> => {
    // getUserMedia cannot be aborted; late permission grants still release their tracks.
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { ...(deviceId === 'default' ? {} : { deviceId: { exact: deviceId } }), channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    if (stopped) { acquired.getTracks().forEach((track) => track.stop()); throw new Error('已取消麦克风启动。') }
    stream = acquired
    context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    url = URL.createObjectURL(new Blob([MICROPHONE_WORKLET], { type: 'application/javascript' }))
    await context.audioWorklet.addModule(url)
    if (stopped) throw new Error('已取消麦克风启动。')
    URL.revokeObjectURL(url); url = undefined
    source = context.createMediaStreamSource(stream)
    worklet = new AudioWorkletNode(context, 'lingobar-microphone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    muted = context.createGain()
    muted.gain.value = 0
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (stopped || !(event.data instanceof ArrayBuffer)) return
      try { onChunk(event.data) } catch { fail('麦克风音频发送失败，请重新开始。') }
    }
    worklet.onprocessorerror = () => fail('麦克风音频处理失败，请重新开始。')
    for (const track of stream.getAudioTracks()) track.onended = () => fail('麦克风连接已断开，请重新开始。')
    context.onstatechange = () => {
      if (started && context?.state !== 'running') fail('麦克风被系统暂停，请重新开始。')
    }
    source.connect(worklet)
    worklet.connect(muted)
    muted.connect(context.destination)
    await context.resume()
    if (stopped) throw new Error('已取消麦克风启动。')
    if (context.state !== 'running') throw new Error('麦克风未能启动，请重新开始。')
    started = true
    deviceChange = () => {
      if (stopped) return
      // A default stream can be rerouted by Chromium without ending its track.
      // Stop explicitly so the user chooses when a new physical device is used.
      if (deviceId === 'default') { fail('系统音频设备发生变化，请重新开始以使用当前默认麦克风。'); return }
      void navigator.mediaDevices.enumerateDevices().then(devices => {
        if (!stopped && !devices.some(device => device.kind === 'audioinput' && device.deviceId === deviceId))
          fail('所选麦克风已断开，请连接设备或选择其他麦克风后重新开始。')
      }).catch(() => { if (!stopped) fail('无法检查麦克风设备，请重新开始。') })
    }
    navigator.mediaDevices.addEventListener?.('devicechange', deviceChange)
  }
  try {
    await Promise.race([startup(), deadline])
    if (timer) clearTimeout(timer)
    return stop
  } catch (error) {
    stop()
    throw new Error(captureMessage(error, platform))
  }
}
