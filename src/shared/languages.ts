export const LANGUAGES = [
  { code: 'zh', label: '简体中文', nativeName: '中文', lang: 'zh-CN' },
  { code: 'zh-Hant', label: '繁體中文', nativeName: '繁體中文', lang: 'zh-TW' },
  { code: 'en', label: '英语', nativeName: 'English', lang: 'en' },
  { code: 'ja', label: '日语', nativeName: '日本語', lang: 'ja' },
  { code: 'ko', label: '韩语', nativeName: '한국어', lang: 'ko' },
  { code: 'fr', label: '法语', nativeName: 'Français', lang: 'fr' },
  { code: 'de', label: '德语', nativeName: 'Deutsch', lang: 'de' },
  { code: 'es', label: '西班牙语', nativeName: 'Español', lang: 'es' },
  { code: 'pt', label: '葡萄牙语', nativeName: 'Português', lang: 'pt' },
  { code: 'it', label: '意大利语', nativeName: 'Italiano', lang: 'it' },
  { code: 'ru', label: '俄语', nativeName: 'Русский', lang: 'ru' },
  { code: 'ar', label: '阿拉伯语', nativeName: 'العربية', lang: 'ar' },
  { code: 'hi', label: '印地语', nativeName: 'हिन्दी', lang: 'hi' },
  { code: 'th', label: '泰语', nativeName: 'ไทย', lang: 'th' },
  { code: 'vi', label: '越南语', nativeName: 'Tiếng Việt', lang: 'vi' },
  { code: 'id', label: '印度尼西亚语', nativeName: 'Indonesia', lang: 'id' },
  { code: 'tr', label: '土耳其语', nativeName: 'Türkçe', lang: 'tr' },
  { code: 'nl', label: '荷兰语', nativeName: 'Nederlands', lang: 'nl' },
  { code: 'pl', label: '波兰语', nativeName: 'Polski', lang: 'pl' },
  { code: 'uk', label: '乌克兰语', nativeName: 'Українська', lang: 'uk' }
] as const
export type TargetLanguage = typeof LANGUAGES[number]['code']
export const DEFAULT_LANGUAGES: TargetLanguage[] = ['zh', 'en', 'ja']
export const MAX_TARGET_LANGUAGES = 8
export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && LANGUAGES.some(language => language.code === value)
}
export function validTargetLanguages(value: unknown): value is TargetLanguage[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_TARGET_LANGUAGES &&
    value.every(isTargetLanguage) && new Set(value).size === value.length
}
export function languageInfo(code: TargetLanguage) { return LANGUAGES.find(language => language.code === code)! }
