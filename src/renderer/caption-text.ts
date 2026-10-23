import type { Caption } from '../shared/types'
import { languageInfo, type TargetLanguage } from '../shared/languages'

export function translationFor(caption: Caption, code: TargetLanguage): string {
  return caption.translations?.[code] || (code === 'zh' || code === 'en' || code === 'ja' ? caption[code] : '')
}

export function preferredTranslation(caption: Caption | undefined, targets: TargetLanguage[]): string {
  return caption ? targets.map(code => translationFor(caption, code)).find(Boolean) || '' : ''
}

/** A translation and its source always describe the same completed request. */
export function alignedOriginal(caption: Caption): string {
  const hasTranslation = Boolean(caption.zh || caption.en || caption.ja || Object.values(caption.translations || {}).some(Boolean))
  return hasTranslation && caption.translatedOriginal ? caption.translatedOriginal : caption.original
}

/** Only subtract a prefix belonging to this exact live utterance, never an older paragraph. */
export function incomingText(text: string, caption?: Caption): string {
  if (!caption?.live || text !== caption.original) return text
  const displayed = alignedOriginal(caption)
  return displayed && text.startsWith(displayed) ? text.slice(displayed.length).trimStart() : text
}

/** On final failure, keep the recognized remainder visible without pairing it with stale translations. */
export function untranslatedErrorSource(caption?: Caption): { label: string; text: string } | null {
  if (!caption || caption.status !== 'error') return null
  const translated = alignedOriginal(caption)
  if (translated === caption.original) return null
  return translated && caption.original.startsWith(translated)
    ? { label: '未译原文', text: caption.original.slice(translated.length).trimStart() }
    : { label: '修正原文', text: caption.original }
}

/** ASR can retract speculative live chunks; return to their nearest surviving predecessor. */
export function survivingCaptionId(previous: Caption[], active: Caption[], id: string | null): string | null {
  const index = previous.findIndex(caption => caption.id === id)
  const activeIds = new Set(active.map(caption => caption.id))
  if (index < 0 || !previous[index].live || activeIds.has(id!)) return id
  for (let candidate = index - 1; candidate >= 0; candidate--) {
    if (!previous[candidate].live || activeIds.has(previous[candidate].id)) return previous[candidate].id
  }
  return active[0]?.id || null
}

/** Compact mode always pairs one original with all configured translations. */
export function compactRows(caption: Caption | undefined, targets: TargetLanguage[]) {
  return [
    { code: 'original', label: '原文', lang: undefined, text: caption ? alignedOriginal(caption) : '' },
    ...targets.map(code => ({ code, label: languageInfo(code).nativeName, lang: languageInfo(code).lang, text: caption ? translationFor(caption, code) : '' })),
  ]
}
