import { safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Caption, Preferences, Settings, SettingsInput } from '../shared/types'
import { DEFAULT_TRANSLATION_BASE_URL, DEFAULT_TRANSLATION_MODEL, validateJapaneseSegments } from './translation'
import { DEFAULT_LANGUAGES, LANGUAGES, isTargetLanguage, validTargetLanguages, type TargetLanguage } from '../shared/languages'
import { validMicrophoneDeviceId } from '../shared/platform'

export const defaults: Preferences = {
  targetLanguages: [...DEFAULT_LANGUAGES], showOriginal: true, showFurigana: true,
  captureMode: 'system', microphoneDeviceId: 'default', alwaysOnTop: true, opacity: 0.94, fontSize: 16,
  launchAtLogin: false, asrModel: 'qwen-audio-3.1-asr-flash-streaming',
  asrEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationBaseUrl: DEFAULT_TRANSLATION_BASE_URL,
  translationModel: DEFAULT_TRANSLATION_MODEL
}
interface Stored { preferences: Preferences; asrKey?: string; translationKey?: string }

const booleanKeys = ['alwaysOnTop', 'launchAtLogin', 'showOriginal', 'showFurigana'] as const
const numberKeys = ['opacity', 'fontSize'] as const
const serviceKeys = ['asrModel', 'asrEndpoint', 'translationBaseUrl', 'translationModel'] as const
const legacyLanguages = ['zh', 'en', 'ja'] as const

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= limit &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}
function bounded(key: typeof numberKeys[number], value: number): number {
  return Math.max(key === 'opacity' ? 0.45 : 12, Math.min(key === 'opacity' ? 1 : 24, value))
}
function validService(key: typeof serviceKeys[number], value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/u.test(value)) return false
  if (key === 'asrModel' || key === 'translationModel') return value.length <= 200
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) return false
    if (key === 'asrEndpoint') return url.protocol === 'wss:'
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch { return false }
}
function storedPreferences(value: unknown): Preferences {
  const result = { ...defaults, targetLanguages: [...defaults.targetLanguages] }
  if (!record(value)) return result
  if (validTargetLanguages(value.targetLanguages)) result.targetLanguages = [...value.targetLanguages]
  if (value.captureMode === 'system' || value.captureMode === 'microphone' || value.captureMode === 'both') result.captureMode = value.captureMode
  if (validMicrophoneDeviceId(value.microphoneDeviceId)) result.microphoneDeviceId = value.microphoneDeviceId
  for (const key of booleanKeys) if (typeof value[key] === 'boolean') result[key] = value[key]
  // Startup is prohibited, including a legacy stored true. Reading preferences
  // must not write or register/unregister anything with the operating system.
  result.launchAtLogin = false
  for (const key of numberKeys) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = bounded(key, value[key])
  }
  for (const key of serviceKeys) if (validService(key, value[key])) result[key] = value[key].trim()
  return result
}
function storedKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 16_384 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ? value : undefined
}
function savedCaption(value: unknown): Caption | null {
  if (!record(value) || !validText(value.id, 200) || value.saved !== true || value.status !== 'ready') return null
  if (value.source !== 'system' && value.source !== 'microphone' && value.source !== 'text') return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 || value.createdAt > 8.64e15) return null
  if (!validText(value.original, 8000) || !validText(value.language, 80)) return null
  const translations: Partial<Record<TargetLanguage, string>> = {}
  if (record(value.translations)) {
    for (const { code } of LANGUAGES) {
      const text = value.translations[code]
      if (validText(text, 16_000)) translations[code] = text
    }
  }
  // Old records used three fixed fields. Keep valid text even if another field is damaged.
  for (const code of legacyLanguages) {
    if (!translations[code] && validText(value[code], 16_000)) translations[code] = value[code]
  }
  const available = LANGUAGES.map(language => language.code).filter(code => Boolean(translations[code]))
  if (!available.length) return null
  const targetLanguages: TargetLanguage[] = []
  if (Array.isArray(value.targetLanguages)) {
    for (const code of value.targetLanguages) {
      if (isTargetLanguage(code) && translations[code] && !targetLanguages.includes(code)) targetLanguages.push(code)
    }
  }
  for (const code of available) if (!targetLanguages.includes(code)) targetLanguages.push(code)
  const ja = translations.ja || ''
  const reading = ja && validText(value.reading, 16_000) ? value.reading : ''
  const segments = ja ? validateJapaneseSegments(value.jaSegments, ja) : null
  // Reconstruct the allowlisted shape so unrelated disk fields cannot enter the renderer.
  return {
    id: value.id, source: value.source as Caption['source'], original: value.original,
    language: value.language, zh: translations.zh || '', en: translations.en || '',
    ja, reading, translations, targetLanguages, createdAt: value.createdAt,
    status: 'ready', saved: true, ...(segments ? { jaSegments: segments } : {})
  }
}
function savedCaptions(value: unknown): Caption[] {
  if (!Array.isArray(value)) return []
  const unique = new Map<string, Caption>()
  for (const item of value) {
    const caption = savedCaption(item)
    if (caption) { unique.delete(caption.id); unique.set(caption.id, caption) }
  }
  return Array.from(unique.values()).slice(-1000)
}

export class Storage {
  private data: Stored
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const value = this.read('settings.json')
    const stored = record(value) ? value : {}
    const preferences = record(stored.preferences) ? stored.preferences : {}
    this.data = { preferences: storedPreferences(preferences) }
    // An invalid explicitly saved endpoint must not silently send its existing key to a fallback service.
    const validContainer = stored.preferences === undefined || record(stored.preferences)
    if (validContainer && (preferences.asrEndpoint === undefined || validService('asrEndpoint', preferences.asrEndpoint))) this.data.asrKey = storedKey(stored.asrKey)
    // Translation defaults may change provider; a stored key requires its original explicit endpoint.
    if (validContainer && validService('translationBaseUrl', preferences.translationBaseUrl)) this.data.translationKey = storedKey(stored.translationKey)
  }
  private read(name: string): unknown {
    try { return JSON.parse(readFileSync(join(this.directory, name), 'utf8')) } catch { return null }
  }
  private write(name: string, data: unknown): void {
    const path = join(this.directory, name)
    writeFileSync(path + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(path + '.tmp', path)
  }
  settings(): Settings {
    return { ...this.data.preferences, targetLanguages: [...this.data.preferences.targetLanguages], hasAsrKey: Boolean(this.data.asrKey), hasTranslationKey: Boolean(this.data.translationKey) }
  }
  key(kind: 'asr' | 'translation'): string {
    const value = kind === 'asr' ? this.data.asrKey : this.data.translationKey
    if (!value) return ''
    if (!this.encryptionAvailable()) throw new Error('系统密钥加密服务当前不可用，无法解锁密钥。请检查系统账户后重试。')
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')) }
    catch { throw new Error('无法解锁已保存的密钥，请在设置中重新输入。') }
  }
  save(input: SettingsInput): Settings {
    if (!record(input)) throw new Error('设置格式不正确。')
    if (input.launchAtLogin !== undefined && input.launchAtLogin !== false) throw new Error('语伴不允许开机启动，不能启用登录项。')
    const next: Stored = { ...this.data, preferences: { ...this.data.preferences, targetLanguages: [...this.data.preferences.targetLanguages] } }
    const p = next.preferences
    if (input.targetLanguages !== undefined) {
      if (!validTargetLanguages(input.targetLanguages)) throw new Error('请选择 1 至 8 种不重复的目标语言。')
      p.targetLanguages = [...input.targetLanguages]
    }
    if (input.captureMode !== undefined) {
      if (input.captureMode !== 'system' && input.captureMode !== 'microphone' && input.captureMode !== 'both') throw new Error('请选择有效的声音来源。')
      p.captureMode = input.captureMode
    }
    if (input.microphoneDeviceId !== undefined) {
      if (!validMicrophoneDeviceId(input.microphoneDeviceId)) throw new Error('请选择有效的麦克风设备。')
      p.microphoneDeviceId = input.microphoneDeviceId
    }
    for (const key of booleanKeys) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== 'boolean') throw new Error('设置格式不正确。')
        p[key] = input[key]
      }
    }
    for (const key of numberKeys) {
      if (input[key] !== undefined) {
        const value = input[key]
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('请输入有效数值。')
        p[key] = bounded(key, value)
      }
    }
    for (const key of serviceKeys) {
      if (input[key] !== undefined) {
        if (!validService(key, input[key])) throw new Error(key === 'asrEndpoint' ? '语音识别地址须使用 WSS，且不能含账号、密码或查询参数。' : key === 'translationBaseUrl' ? '翻译服务地址须使用 HTTPS（本机服务可用 HTTP），且不能含账号、密码或查询参数。' : '模型名称不能为空，且须在 200 字以内。')
        p[key] = input[key].trim()
      }
    }
    for (const [inputKey, storedKey] of [['asrApiKey', 'asrKey'], ['translationApiKey', 'translationKey']] as const) {
      const value = input[inputKey]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.trim())) throw new Error('密钥格式不正确。')
      if (!value.trim()) continue
      if (!this.encryptionAvailable()) throw new Error('系统密钥加密服务当前不可用，密钥尚未保存。')
      try { next[storedKey] = safeStorage.encryptString(value.trim()).toString('base64') }
      catch { throw new Error('系统无法加密密钥，密钥尚未保存，请稍后重试。') }
    }
    this.write('settings.json', next)
    this.data = next
    return this.settings()
  }
  private encryptionAvailable(): boolean {
    // Electron can offer a plaintext backend on Linux. Never accept that fallback,
    // including when a settings directory is moved between platforms.
    try {
      return safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text')
    } catch { return false }
  }
  saved(): Caption[] {
    return savedCaptions(this.read('saved.json'))
  }
  saveCaptions(captions: Caption[]): void {
    // A retry may be pending or fail while the prior translation remains useful.
    // Persist that completed text; never persist a transient status across launches.
    const stable = captions.map(caption => caption.saved && (caption.status === 'translating' || caption.status === 'error')
      ? { ...caption, status: 'ready' } : caption)
    this.write('saved.json', savedCaptions(stable))
  }
}
