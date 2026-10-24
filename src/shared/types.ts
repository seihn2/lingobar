export type AudioSource = 'system' | 'microphone'
export type CaptureMode = AudioSource | 'both'
export type ListeningState = 'idle' | 'starting' | 'listening' | 'error'
export type PauseResult = 'finished' | 'timeout' | 'cancelled'
export interface Preferences {
  targetLanguages: TargetLanguage[]
  showOriginal: boolean
  showFurigana: boolean
  captureMode: CaptureMode
  microphoneDeviceId: string
  alwaysOnTop: boolean
  opacity: number
  fontSize: number
  launchAtLogin: boolean
  asrModel: string
  asrEndpoint: string
  translationBaseUrl: string
  translationModel: string
}
export interface Settings extends Preferences { hasAsrKey: boolean; hasTranslationKey: boolean }
export interface SettingsInput extends Partial<Preferences> { asrApiKey?: string; translationApiKey?: string }
export interface Caption {
  id: string
  source: AudioSource | 'text'
  original: string
  /** ASR may still revise this utterance; completed translation prefixes stay readable. */
  live?: boolean
  /** A newer revision is debouncing, queued, or being translated. */
  translationPending?: boolean
  /** Exact source snapshot associated with the currently published translations. */
  translatedOriginal?: string
  language: string
  zh: string
  en: string
  ja: string
  reading: string
  jaSegments?: Array<{ text: string; reading?: string }>
  furiganaStatus?: 'pending' | 'ready' | 'error'
  translations?: Partial<Record<TargetLanguage, string>>
  targetLanguages?: TargetLanguage[]
  createdAt: number
  status: 'translating' | 'ready' | 'error'
  error?: string
  saved: boolean
}
export interface Snapshot {
  settings: Settings
  state: ListeningState
  message: string
  captions: Caption[]
  partial: Partial<Record<AudioSource, string>>
  collapsed: boolean
}
export interface LingoAPI {
  readonly platform: import('./platform').DesktopPlatform
  getSnapshot(): Promise<Snapshot>
  saveSettings(input: SettingsInput): Promise<Settings>
  start(): Promise<void>
  /** Explicit pause stops devices immediately, then allows a bounded final response. */
  stop(): Promise<PauseResult | void>
  pushMicrophone(chunk: ArrayBuffer, run: number): void
  microphoneFailed(message: string, run: number): void
  microphoneReady(run: number): void
  translateText(text: string): Promise<void>
  retry(id: string): Promise<void>
  toggleSaved(id: string): Promise<void>
  exportSaved(): Promise<boolean>
  copyText(text: string): Promise<void>
  importLocalKey(): Promise<Settings>
  setCollapsed(value: boolean): Promise<void>
  setCompactHeight(height: number): Promise<void>
  hide(): Promise<void>
  quit(): Promise<void>
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void
  onMicrophone(callback: (enabled: boolean, run: number, deviceId: string) => void): () => void
}
declare global { interface Window { lingo: LingoAPI } }
import type { TargetLanguage } from './languages'
