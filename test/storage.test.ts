import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caption, SettingsInput } from '../src/shared/types'
import { DEFAULT_LANGUAGES, type TargetLanguage } from '../src/shared/languages'

const encryption = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'unknown'),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => {
    const text = value.toString()
    if (!text.startsWith('encrypted:')) throw new Error('private keychain internals')
    return text.slice('encrypted:'.length)
  })
}))
vi.mock('electron', () => ({ safeStorage: encryption }))
import { defaults, Storage } from '../src/main/storage'

let directory: string
const caption = (id: string, saved = true): Caption => ({
  id, source: 'system', original: 'Hello', language: '英语', zh: '你好', en: 'Hello', ja: 'こんにちは', reading: 'こんにちは', createdAt: 1000, status: 'ready', saved
})

const migrated = (value: Caption): Caption => ({ ...value, translations: { zh: value.zh, en: value.en, ja: value.ja }, targetLanguages: ['zh', 'en', 'ja'] })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lingobar-storage-'))
  vi.clearAllMocks()
  encryption.isEncryptionAvailable.mockReturnValue(true)
  encryption.getSelectedStorageBackend.mockReturnValue('unknown')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('Storage', () => {
  it('starts new installations on DeepSeek Flash without any saved provider credentials', () => {
    expect(new Storage(directory).settings()).toMatchObject({
      translationBaseUrl: 'https://api.deepseek.com', translationModel: 'deepseek-flash',
      asrEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
      hasAsrKey: false, hasTranslationKey: false
    })
  })

  it('preserves explicit legacy Qwen endpoints, models and keys across reload and preference updates', () => {
    const storage = new Storage(directory)
    storage.save({
      translationBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      translationModel: 'qwen-plus', translationApiKey: 'legacy-qwen-secret'
    })
    const reloaded = new Storage(directory)
    reloaded.save({ fontSize: 20 })
    const final = new Storage(directory)
    expect(final.settings()).toMatchObject({
      translationBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      translationModel: 'qwen-plus', hasTranslationKey: true, fontSize: 20
    })
    expect(final.key('translation')).toBe('legacy-qwen-secret')
  })

  it('does not send a persisted key to a new default provider when its original endpoint is missing', () => {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({
      preferences: { translationModel: 'qwen-plus' },
      translationKey: Buffer.from('encrypted:legacy-qwen-secret').toString('base64')
    }))
    const recovered = new Storage(directory)
    expect(recovered.settings().hasTranslationKey).toBe(false)
    expect(recovered.key('translation')).toBe('')
  })

  it('persists encrypted independent keys and exposes only presence flags to the renderer', () => {
    const storage = new Storage(directory)
    const settings = storage.save({ asrApiKey: 'asr-secret-123', translationApiKey: 'translation-secret-456', captureMode: 'both', opacity: 0.72 })
    expect(settings).toMatchObject({ hasAsrKey: true, hasTranslationKey: true, captureMode: 'both', opacity: 0.72 })
    const serialized = JSON.stringify(settings)
    expect(serialized).not.toContain('secret')
    expect(settings).not.toHaveProperty('asrKey')
    expect(settings).not.toHaveProperty('translationKey')
    const disk = readFileSync(join(directory, 'settings.json'), 'utf8')
    expect(disk).not.toContain('asr-secret-123')
    expect(disk).not.toContain('translation-secret-456')
    if (process.platform !== 'win32') expect(statSync(join(directory, 'settings.json')).mode & 0o777).toBe(0o600)
    const reloaded = new Storage(directory)
    expect(reloaded.key('asr')).toBe('asr-secret-123')
    expect(reloaded.key('translation')).toBe('translation-secret-456')
    expect(reloaded.settings()).toEqual(settings)
  })

  it('preserves existing keys when saving preferences or blank password fields', () => {
    const storage = new Storage(directory)
    storage.save({ asrApiKey: 'asr-secret', translationApiKey: 'translation-secret' })
    storage.save({ fontSize: 20, asrApiKey: '', translationApiKey: '' })
    expect(storage.key('asr')).toBe('asr-secret')
    expect(storage.key('translation')).toBe('translation-secret')
    expect(storage.settings().fontSize).toBe(20)
  })

  it('rejects a keychain failure without partly saving other changes or plaintext', () => {
    const storage = new Storage(directory)
    storage.save({ fontSize: 18, asrApiKey: 'previous-key' })
    const previous = readFileSync(join(directory, 'settings.json'), 'utf8')
    encryption.isEncryptionAvailable.mockReturnValue(false)
    expect(() => storage.save({ fontSize: 24, asrApiKey: 'do-not-store' })).toThrow('系统密钥加密服务当前不可用')
    expect(storage.settings().fontSize).toBe(18)
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(previous)
  })

  it('does not mutate saved state when a later preference fails validation', () => {
    const storage = new Storage(directory)
    storage.save({ alwaysOnTop: true, opacity: 0.75 })
    const before = storage.settings()
    expect(() => storage.save({ alwaysOnTop: false, fontSize: Number.NaN })).toThrow('有效数值')
    expect(storage.settings()).toEqual(before)
    expect(new Storage(directory).settings()).toEqual(before)
  })

  it('keeps both previous keys and preferences when encrypting the second replacement fails', () => {
    const storage = new Storage(directory)
    storage.save({ asrApiKey: 'synthetic-old-asr', translationApiKey: 'synthetic-old-translation' })
    const before = readFileSync(join(directory, 'settings.json'), 'utf8')
    encryption.encryptString.mockImplementationOnce(value => Buffer.from(`encrypted:${value}`))
      .mockImplementationOnce(() => { throw new Error('unredacted backend detail') })
    expect(() => storage.save({ asrApiKey: 'synthetic-new-asr', translationApiKey: 'synthetic-new-translation', fontSize: 23 })).toThrow('系统无法加密密钥')
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before)
    expect(storage.key('asr')).toBe('synthetic-old-asr')
    expect(storage.key('translation')).toBe('synthetic-old-translation')
    expect(storage.settings().fontSize).toBe(defaults.fontSize)
  })

  it('does not decrypt saved keys while the operating system encryption service is unavailable', () => {
    const storage = new Storage(directory)
    storage.save({ asrApiKey: 'synthetic-secret' })
    encryption.decryptString.mockClear()
    encryption.isEncryptionAvailable.mockReturnValue(false)
    expect(() => storage.key('asr')).toThrow('无法解锁密钥')
    expect(encryption.decryptString).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'linux')('rejects Electron plaintext fallback without writing a key', () => {
    const storage = new Storage(directory)
    storage.save({ fontSize: 19 })
    const before = readFileSync(join(directory, 'settings.json'), 'utf8')
    encryption.getSelectedStorageBackend.mockReturnValue('basic_text')
    expect(() => storage.save({ asrApiKey: 'synthetic-key', fontSize: 23 })).toThrow('加密服务当前不可用')
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before)
    expect(encryption.encryptString).not.toHaveBeenCalled()
  })

  it('restores and validates a microphone device independently of capture mode', () => {
    const storage = new Storage(directory)
    storage.save({ captureMode: 'both', microphoneDeviceId: 'synthetic-device-123' })
    expect(new Storage(directory).settings()).toMatchObject({ captureMode: 'both', microphoneDeviceId: 'synthetic-device-123' })
    const before = readFileSync(join(directory, 'settings.json'), 'utf8')
    for (const device of ['', 'contains whitespace', 'invalid\u0000value', 'a'.repeat(513)]) {
      expect(() => storage.save({ microphoneDeviceId: device })).toThrow('麦克风设备')
      expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before)
    }
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ preferences: { microphoneDeviceId: { invalid: true } } }))
    expect(new Storage(directory).settings().microphoneDeviceId).toBe('default')
  })

  it('returns a safe error when encrypted key data cannot be decrypted', () => {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ preferences: {}, asrKey: Buffer.from('invalid encrypted data').toString('base64') }))
    const storage = new Storage(directory)
    expect(() => storage.key('asr')).toThrow('无法解锁已保存的密钥，请在设置中重新输入。')
  })

  it('recovers defaults and empty history from broken JSON', () => {
    writeFileSync(join(directory, 'settings.json'), '{broken')
    writeFileSync(join(directory, 'saved.json'), '{broken')
    const storage = new Storage(directory)
    expect(storage.settings()).toEqual({ ...defaults, hasAsrKey: false, hasTranslationKey: false })
    expect(storage.saved()).toEqual([])
  })

  it('restores only known valid preference fields, never unknown fields from the settings file', () => {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ preferences: {
      fontSize: 'broken', captureMode: 'camera', opacity: 0.73, alwaysOnTop: null,
      asrApiKey: 'plaintext-from-old-or-corrupt-file', translationApiKey: 'another-secret', unknown: 'discard'
    } }))
    const settings = new Storage(directory).settings()
    expect(settings).toMatchObject({ fontSize: defaults.fontSize, captureMode: defaults.captureMode, opacity: 0.73, alwaysOnTop: defaults.alwaysOnTop })
    expect(settings).not.toHaveProperty('asrApiKey')
    expect(settings).not.toHaveProperty('translationApiKey')
    expect(settings).not.toHaveProperty('unknown')
  })

  it('does not accept unknown fields from renderer settings input', () => {
    const storage = new Storage(directory)
    const settings = storage.save({ unknown: 'discard', asrKey: 'plain-secret' } as SettingsInput)
    expect(settings).not.toHaveProperty('unknown')
    expect(settings).not.toHaveProperty('asrKey')
    expect(storage.key('asr')).toBe('')
  })

  it('sanitizes out-of-range preferences and does not reuse a key after an invalid endpoint falls back', () => {
    const storage = new Storage(directory)
    storage.save({ asrApiKey: 'asr-secret', translationApiKey: 'translation-secret' })
    const stored = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))
    stored.preferences.fontSize = 500
    stored.preferences.opacity = -10
    stored.preferences.translationBaseUrl = 'http://untrusted.example/v1'
    writeFileSync(join(directory, 'settings.json'), JSON.stringify(stored))
    const recovered = new Storage(directory)
    expect(recovered.settings()).toMatchObject({ fontSize: 24, opacity: 0.45, translationBaseUrl: defaults.translationBaseUrl, hasTranslationKey: false, hasAsrKey: true })
    expect(recovered.key('translation')).toBe('')
    expect(recovered.key('asr')).toBe('asr-secret')
  })

  it('rejects unsafe service addresses before persisting a new key or preferences', () => {
    const storage = new Storage(directory)
    storage.save({ fontSize: 18 })
    const before = readFileSync(join(directory, 'settings.json'), 'utf8')
    expect(() => storage.save({ asrEndpoint: 'ws://example.test', asrApiKey: 'new-secret' })).toThrow('WSS')
    expect(() => storage.save({ translationBaseUrl: 'https://key:secret@example.test/v1' })).toThrow('HTTPS')
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before)
    expect(encryption.encryptString).not.toHaveBeenCalled()
  })

  it('treats whitespace-only password fields as unchanged', () => {
    const storage = new Storage(directory)
    storage.save({ asrApiKey: 'existing-secret' })
    storage.save({ asrApiKey: '   ' })
    expect(storage.key('asr')).toBe('existing-secret')
  })

  it('stores only saved ready captions and restores them across launches', () => {
    const storage = new Storage(directory)
    const saved = caption('saved')
    storage.saveCaptions([saved, caption('unsaved', false), { ...caption('failed'), zh: '', en: '', ja: '', status: 'error' }, { ...caption('pending'), zh: '', en: '', ja: '', status: 'translating' }])
    expect(new Storage(directory).saved()).toEqual([migrated(saved)])
    if (process.platform !== 'win32') expect(statSync(join(directory, 'saved.json')).mode & 0o777).toBe(0o600)
    storage.saveCaptions([{ ...saved, saved: false }])
    expect(new Storage(directory).saved()).toEqual([])
  })

  it('discards malformed caption records while retaining usable saved history', () => {
    const valid = caption('valid')
    writeFileSync(join(directory, 'saved.json'), JSON.stringify([
      valid,
      { id: 'missing-fields', original: 'text', status: 'ready' },
      { ...caption('bad-translation'), ja: { invalid: 'React cannot render objects' } },
      { ...caption('bad-timestamp'), createdAt: 'yesterday' },
      { ...caption('bad-source'), source: 'camera' },
      caption('not-saved', false)
    ]))
    expect(new Storage(directory).saved()).toEqual([migrated(valid), { ...caption('bad-translation'), ja: '', reading: '', translations: { zh: '你好', en: 'Hello' }, targetLanguages: ['zh', 'en'] }])
  })

  it('preserves aligned furigana while retaining legacy captions without segments', () => {
    const legacy = caption('legacy')
    const annotated = { ...caption('furigana'), ja: '小さな学校。', reading: 'ちいさながっこう。', jaSegments: [
      { text: '小', reading: 'ちい' }, { text: 'さな' }, { text: '学校', reading: 'がっこう' }, { text: '。' }
    ] }
    new Storage(directory).saveCaptions([legacy, annotated])
    expect(new Storage(directory).saved()).toEqual([migrated(legacy), migrated(annotated)])
  })

  it('drops malformed furigana as a whole and preserves the caption for plain-text fallback', () => {
    const invalid = { ...caption('bad-furigana'), ja: '学校', jaSegments: [{ text: '全然違う', reading: 'がっこう' }] }
    writeFileSync(join(directory, 'saved.json'), JSON.stringify([invalid]))
    const restored = new Storage(directory).saved()
    expect(restored).toHaveLength(1)
    expect(restored[0].ja).toBe('学校')
    expect(restored[0]).not.toHaveProperty('jaSegments')
    new Storage(directory).saveCaptions([invalid])
    expect(new Storage(directory).saved()[0]).not.toHaveProperty('jaSegments')
  })
  it('upgrades old preferences with independent ordered language defaults', () => {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ preferences: { fontSize: 18 } }))
    const storage = new Storage(directory)
    expect(storage.settings()).toMatchObject({ targetLanguages: DEFAULT_LANGUAGES, showOriginal: true, showFurigana: true, fontSize: 18 })
    const exposed = storage.settings()
    exposed.targetLanguages.reverse()
    exposed.targetLanguages.push('fr')
    expect(storage.settings().targetLanguages).toEqual(['zh', 'en', 'ja'])
    expect(new Storage(directory).settings().targetLanguages).toEqual(['zh', 'en', 'ja'])
  })

  it('preserves selected language order without sharing mutable input or output arrays', () => {
    const storage = new Storage(directory)
    const targets: TargetLanguage[] = ['fr', 'zh-Hant', 'en']
    const settings = storage.save({ targetLanguages: targets, showOriginal: false, showFurigana: false })
    targets.push('ja')
    settings.targetLanguages.reverse()
    expect(storage.settings()).toMatchObject({ targetLanguages: ['fr', 'zh-Hant', 'en'], showOriginal: false, showFurigana: false })
    expect(new Storage(directory).settings()).toEqual(storage.settings())
  })

  it.each([[], ['en', 'en'], ['en', 'not-a-language'], 'en', ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt']])('rejects an invalid target language selection atomically: %j', selection => {
    const storage = new Storage(directory)
    storage.save({ targetLanguages: ['ko', 'en'] })
    const before = readFileSync(join(directory, 'settings.json'), 'utf8')
    expect(() => storage.save({ targetLanguages: selection, showOriginal: false } as SettingsInput)).toThrow('目标语言')
    expect(storage.settings().targetLanguages).toEqual(['ko', 'en'])
    expect(storage.settings().showOriginal).toBe(true)
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe(before)
  })

  it('recovers defaults when saved language selections or visibility flags are corrupt', () => {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ preferences: {
      targetLanguages: ['en', 'en'], showOriginal: 'yes', showFurigana: null
    } }))
    expect(new Storage(directory).settings()).toMatchObject({ targetLanguages: DEFAULT_LANGUAGES, showOriginal: true, showFurigana: true })
  })

  it('restores and re-saves a non-Japanese caption with ordered dynamic translations', () => {
    const dynamic: Caption = {
      ...caption('dynamic'), zh: '', en: '', ja: '', reading: '',
      translations: { fr: 'Bonjour', ko: '안녕하세요' }, targetLanguages: ['ko', 'fr']
    }
    const storage = new Storage(directory)
    storage.saveCaptions([dynamic])
    const restored = new Storage(directory).saved()
    expect(restored).toEqual([dynamic])
    storage.saveCaptions(restored)
    expect(storage.saved()).toEqual([dynamic])
  })

  it('migrates legacy fixed translations and strips unknown or invalid map entries', () => {
    writeFileSync(join(directory, 'saved.json'), JSON.stringify([{
      ...caption('recovered'), translations: { fr: 'Bonjour', en: 'Hello from map', unknown: 'discard', ko: { invalid: true }, de: '  ' },
      targetLanguages: ['fr', 'unknown', 'en', 'fr'], surprise: 'discard'
    }]))
    const restored = new Storage(directory).saved()[0]
    expect(restored.translations).toEqual({ zh: '你好', en: 'Hello from map', ja: 'こんにちは', fr: 'Bonjour' })
    expect(restored.targetLanguages).toEqual(['fr', 'en', 'zh', 'ja'])
    expect(restored.en).toBe('Hello from map')
    expect(restored).not.toHaveProperty('surprise')
  })

  it('requires original, source language, and at least one usable catalog translation', () => {
    const empty = { ...caption('empty'), zh: '', en: '', ja: '', reading: '', translations: { unknown: 'text', fr: '' } }
    writeFileSync(join(directory, 'saved.json'), JSON.stringify([
      empty, { ...caption('no-original'), original: '' }, { ...caption('no-language'), language: '' },
      { ...empty, id: 'usable', translations: { de: 'Hallo' }, targetLanguages: ['de'] }
    ]))
    const restored = new Storage(directory).saved()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ id: 'usable', translations: { de: 'Hallo' }, targetLanguages: ['de'], reading: '' })
  })

  it('validates ruby against the recovered Japanese map and removes it for other languages', () => {
    const values = [
      { ...caption('map-ja'), translations: { ja: '学校' }, reading: '', jaSegments: [{ text: '学校', reading: 'がっこう' }] },
      { ...caption('no-ja'), zh: '', en: '', ja: '', reading: 'stale', translations: { fr: 'Bonjour' }, jaSegments: [{ text: '学校', reading: 'がっこう' }] }
    ]
    new Storage(directory).saveCaptions(values)
    const restored = new Storage(directory).saved()
    expect(restored[0]).toMatchObject({ ja: '学校', reading: '', jaSegments: [{ text: '学校', reading: 'がっこう' }] })
    expect(restored[1]).toMatchObject({ ja: '', reading: '' })
    expect(restored[1]).not.toHaveProperty('jaSegments')
  })

  it('keeps the last useful saved translation while a retry is pending or failed', () => {
    const storage = new Storage(directory)
    const existing: Caption = { ...caption('retry'), translations: { fr: 'Bonjour' }, targetLanguages: ['fr'], zh: '', en: '', ja: '', reading: '' }
    for (const status of ['translating', 'error'] as const) {
      storage.saveCaptions([{ ...existing, status, error: 'network unavailable' }, caption('another')])
      expect(storage.saved()).toEqual([existing, migrated(caption('another'))])
      expect(storage.saved()[0]).not.toHaveProperty('error')
    }
    // Disk input remains strict; transient records written by another version are not trusted.
    writeFileSync(join(directory, 'saved.json'), JSON.stringify([{ ...existing, status: 'error' }]))
    expect(storage.saved()).toEqual([])
  })

})
