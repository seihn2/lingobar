import type { Caption } from '../shared/types'
import type { TargetLanguage } from '../shared/languages'

export interface ReadingClock { id: string | null; completedAt: number | null; signature: string | null }
export interface ReadingOptions { targets: TargetLanguage[]; showFurigana: boolean }
export interface ReadingStep { clock: ReadingClock; wakeAt: number | null }
/** Carries the reader's place when switching between expanded and compact views. */
export interface ReadingSession { clock: ReadingClock | null; following: boolean; anchor: { id: string; offset: number } | null }
export const emptyReadingClock = (): ReadingClock => ({ id: null, completedAt: null, signature: null })

/** Reopening the live stream starts now; saved history remains available by scrolling. */
export function initialReadingClock(captions: Caption[], preview = false): ReadingClock {
  const initial = preview ? captions[0] : captions.at(-1)
  return { id: initial?.id ?? null, completedAt: null, signature: null }
}

function translated(caption: Caption, target: TargetLanguage): string {
  return caption.translations?.[target] || (target === 'zh' || target === 'en' || target === 'ja' ? caption[target] : '')
}

/** Live results take priority; history remains available through explicit review. */
export function advanceReading(captions: Caption[], previous: ReadingClock, options: ReadingOptions, now: number): ReadingStep {
  const current = captions.slice().reverse().find(caption => caption.status === 'error' || options.targets.some(target => translated(caption, target))) || captions.at(-1)
  if (!current) return { clock: emptyReadingClock(), wakeAt: null }
  return {
    clock: {
      id: current.id,
      completedAt: previous.id === current.id ? previous.completedAt ?? now : now,
      signature: null,
    },
    wakeAt: null,
  }
}
