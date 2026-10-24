// Offline synthetic fixtures only. No provider, audio, personal settings or Electron access.
import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/App'
import type { Caption, LingoAPI, Settings, Snapshot } from '../../src/shared/types'
import type { TargetLanguage } from '../../src/shared/languages'
import '../../src/renderer/style.css'

const settings = {
  targetLanguages: ['fr', 'ja'], showOriginal: true, showFurigana: true,
  captureMode: 'system', microphoneDeviceId: 'default', alwaysOnTop: true, opacity: 0.94, fontSize: 16,
  launchAtLogin: false, asrModel: 'fixture', asrEndpoint: 'wss://example.test/asr',
  translationBaseUrl: 'https://example.test', translationModel: 'fixture', hasAsrKey: false, hasTranslationKey: false,
} as Settings
let snapshot: Snapshot = { settings, state: 'idle', message: '', captions: [], partial: {}, collapsed: false }
const listeners = new Set<(snapshot: Snapshot) => void>()
const saves: Array<Partial<Settings>> = []
let audioStarts = 0
let holdPause = false
let finishPause: ((result: 'finished' | 'timeout') => void) | null = null
const emit = (next: Partial<Snapshot>) => {
  snapshot = structuredClone({ ...snapshot, ...next })
  for (const listener of listeners) listener(snapshot)
}
const api = {
  platform: 'win32',
  getSnapshot: async () => snapshot,
  saveSettings: async (input: Partial<Settings>) => { saves.push(input); emit({ settings: { ...snapshot.settings, ...input } }); return snapshot.settings },
  start: async () => { audioStarts++; throw new Error('Audio is disabled in UI tests') },
  stop: async () => {
    emit({ state: 'idle' })
    if (holdPause) return new Promise<'finished' | 'timeout'>(resolve => { finishPause = resolve })
  },
  pushMicrophone: () => { throw new Error('Audio is disabled in UI tests') },
  microphoneFailed: () => {}, microphoneReady: () => {},
  translateText: async () => { throw new Error('Providers are disabled in UI tests') },
  retry: async () => {}, toggleSaved: async () => {}, exportSaved: async () => false,
  copyText: async () => {}, importLocalKey: async () => { throw new Error('No keys in UI tests') },
  setCollapsed: async (collapsed: boolean) => { emit({ collapsed }) },
  setCompactHeight: async () => {}, hide: async () => {}, quit: async () => {},
  onSnapshot: (listener: (snapshot: Snapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  onMicrophone: () => () => {},
} as LingoAPI
window.lingo = api

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const assert = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
const query = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing fixture element: ${selector}`)
  return element
}
const caption = (id: string, extra: Partial<Caption> = {}): Caption => ({
  id, source: 'system', original: `Synthetic source ${id}`, language: 'English', zh: '', en: '', ja: '天気', reading: '',
  translations: { fr: `Traduction synthétique ${id}`, ja: '天気', en: `Synthetic translation ${id}`, zh: `合成译文 ${id}` },
  jaSegments: [{ text: '天気', reading: 'てんき' }], createdAt: 0, saved: false, status: 'ready', ...extra,
})
const currentId = () => document.querySelector('.reading-current')?.getAttribute('data-caption-id')
const compactId = () => query('.compact-rows').getAttribute('data-caption-id')

async function run() {
  const checks: string[] = []
  const check = (value: unknown, message: string) => { assert(value, message); checks.push(message) }
  await api.setCollapsed(false); await frame()
  emit({ state: 'idle' }); await frame()
  const pending = caption('pause-tail', { original: 'Synthetic unfinished tail', live: true, translationPending: true })
  emit({ state: 'listening', captions: [pending], settings: { ...snapshot.settings, showOriginal: true, hasAsrKey: true, hasTranslationKey: true } }); await frame()
  holdPause = true
  query<HTMLButtonElement>('.listen-button').click(); await frame()
  check(query<HTMLButtonElement>('.listen-button').disabled && query('.listen-button').textContent?.includes('正在暂停'), 'explicit pause disables repeat capture actions while the final response is pending')
  emit({ captions: [{ ...pending, original: 'Synthetic completed tail', translatedOriginal: 'Synthetic completed tail', translations: { ja: '合成末句' }, ja: '合成末句', live: false, translationPending: false }] }); await frame()
  check(document.querySelectorAll('[data-caption-id="pause-tail"]').length === 1 && query('[data-caption-id="pause-tail"] .original-row p').textContent === 'Synthetic completed tail', 'a paused final updates the existing paragraph without creating a duplicate')
  finishPause!('timeout'); await frame()
  check(!query<HTMLButtonElement>('.listen-button').disabled && query('.inline-notice').textContent?.includes('已暂停收音') && query('.inline-notice').textContent?.includes('超时'), 'pause timeout confirms devices stopped and the last recognized words remain available')
  holdPause = false

  const history = Array.from({ length: 22 }, (_, index) => caption(`history-${index}`))
  emit({ state: 'idle' })
  emit({ state: 'listening', captions: history, collapsed: false, settings: { ...settings } })
  await frame()
  check(currentId() === 'history-21', 'expanded view follows newest translated paragraph')
  const latest = query('[data-caption-id="history-21"]')
  check([...latest.querySelectorAll('.language-label')].map(element => element.textContent).join('|') === '原文|Français|日本語', 'expanded rows preserve only selected language order')
  check(query('ruby rt').textContent === 'てんき' && getComputedStyle(query('ruby')).rubyPosition === 'over', 'Japanese readings render above their matching kanji')

  const raw = caption('live', { original: 'Synthetic live source with unfinished words', live: true, status: 'translating', translations: {}, ja: '', jaSegments: undefined, furiganaStatus: undefined })
  emit({ captions: [...history, raw] }); await frame()
  check(currentId() === 'history-21', 'raw recognition keeps the latest readable translation visible')
  const draft = { ...raw, status: 'ready' as const, translationPending: true, translatedOriginal: 'Synthetic live source', translations: { fr: 'Premier préfixe', ja: '天気' }, ja: '天気', jaSegments: [{ text: '天気', reading: 'てんき' }], furiganaStatus: 'pending' as const }
  emit({ captions: [...history, draft] }); await frame()
  check(currentId() === 'live', 'partial translation becomes current before final recognition and annotation')
  check(query('[data-caption-id="live"] .original-row p').textContent === draft.translatedOriginal, 'source stays aligned with the published partial translation')
  const updated = { ...draft, original: `${raw.original} and more`, translatedOriginal: `${raw.original} and more`, translations: { fr: 'Préfixe complété', ja: '天気' } }
  emit({ captions: [...history, updated] }); await frame()
  check(document.querySelectorAll('[data-caption-id="live"]').length === 1 && query('[data-caption-id="live"] .original-row p').textContent === updated.original, 'partial revisions update one paragraph in place')

  const surface = query('.stream-viewport')
  surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -180 }))
  surface.scrollTop = 200
  await frame()
  const oldTop = surface.scrollTop
  const newest = caption('newest')
  emit({ captions: [...history, updated, newest] }); await frame()
  check(query('.stream-label').textContent?.includes('正在回看') && Math.abs(surface.scrollTop - oldTop) < 2, 'wheel review keeps its scroll position while new translations arrive')
  query<HTMLButtonElement>('.stream-follow').click(); await frame()
  check(currentId() === 'newest', 'return-to-live immediately resumes the newest translation')

  const selected = query('[data-caption-id="newest"] .original-row p')
  const range = document.createRange(); range.selectNodeContents(selected)
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  selected.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  await frame()
  emit({ captions: [...history, updated, newest, caption('after-selection')] }); await frame()
  check(query('.stream-label').textContent?.includes('正在回看') && !selection.isCollapsed, 'selecting subtitle text pauses automatic following')
  selection.removeAllRanges()
  query<HTMLButtonElement>('.stream-follow').click(); await frame()
  emit({ captions: [{ ...history[0], furiganaStatus: 'ready' }, ...history.slice(1), updated, newest, caption('after-selection')] }); await frame()
  check(currentId() === 'after-selection', 'late old annotations do not pull reading back')

  await api.setCollapsed(true); await frame()
  check(compactId() === 'after-selection', 'collapsing preserves the current reading paragraph')
  check([...document.querySelectorAll('.compact-row')].map(element => element.getAttribute('data-language')).join('|') === 'original|fr|ja', 'compact mode preserves original and selected languages')
  check(getComputedStyle(query('.compact-drag-edge')).getPropertyValue('-webkit-app-region') === 'drag' && query('.compact-drag-edge').getBoundingClientRect().height >= 20, 'compact mode keeps its full-width 20px drag edge')
  const compactStyle = getComputedStyle(query('.compact-caption'))
  check(parseFloat(compactStyle.paddingLeft) >= 8 && parseFloat(compactStyle.paddingRight) >= 8 && parseFloat(compactStyle.paddingBottom) >= 8, 'compact side and bottom drag padding stays available')
  check(getComputedStyle(query('.compact-viewport')).getPropertyValue('-webkit-app-region') === 'no-drag' && getComputedStyle(query('.compact-controls')).getPropertyValue('-webkit-app-region') === 'no-drag', 'subtitle scrolling and controls remain outside drag regions')

  const long = caption('long', { original: 'Synthetic long source. '.repeat(90), translations: { fr: 'Phrase synthétique longue. '.repeat(90), ja: '天気' } })
  emit({ captions: [long] }); await frame()
  const viewport = query('.compact-viewport')
  check(viewport.scrollHeight > viewport.clientHeight, 'long compact paragraphs remain scrollable')
  const gutter = viewport.offsetWidth - viewport.clientWidth
  check(gutter > 0, 'fixture exposes a scrollbar gutter for pointer regression')
  viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: viewport.getBoundingClientRect().right - 1 }))
  await frame()
  emit({ captions: [long, caption('after-scrollbar')] }); await frame()
  check(Boolean(document.querySelector('.compact-review')) && compactId() === 'long', 'dragging the compact scrollbar pauses following through incoming translations')
  query<HTMLButtonElement>('.compact-live').click(); await frame()
  check(compactId() === 'after-scrollbar', 'compact return-to-live resumes newest paragraph')

  query<HTMLButtonElement>('[aria-label="上一段"]').click(); await frame()
  emit({ captions: [long, caption('after-scrollbar'), caption('while-reviewing')] }); await frame()
  check(compactId() === 'long', 'compact history navigation remains stable while new speech arrives')
  await api.setCollapsed(false); await frame()
  check(Boolean(document.querySelector('[data-caption-id="long"]')) && query('.stream-label').textContent?.includes('正在回看'), 'expanding preserves historical reading mode')
  query<HTMLButtonElement>('.stream-follow').click(); await frame()
  check(currentId() === 'while-reviewing', 'expanded return-to-live works after compact review')

  const eight: TargetLanguage[] = ['fr', 'ja', 'zh', 'en', 'de', 'es', 'ko', 'ar']
  const multilingual = caption('eight', { translations: Object.fromEntries(eight.map(code => [code, code === 'ja' ? '天気' : `Synthetic ${code}`])) })
  emit({ captions: [multilingual], settings: { ...snapshot.settings, targetLanguages: eight } }); await frame()
  check(query('[data-caption-id="eight"] .language-rows').children.length === 9, 'expanded view supports eight selected languages plus original')
  await api.setCollapsed(true); await frame()
  check(document.querySelectorAll('.compact-row').length === 9, 'compact view supports eight selected languages plus original')
  emit({ settings: { ...snapshot.settings, targetLanguages: ['ja'], showOriginal: false, showFurigana: false } }); await frame()
  check(document.querySelectorAll('.compact-row').length === 2 && !document.querySelector('ruby') && query('[data-language="original"] p').textContent === multilingual.original, 'one-language compact mode retains original and can hide optional readings')

  const slider = query<HTMLInputElement>('.quick-opacity input')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '0.55')
  slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }))
  slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await frame()
  check(saves.some(input => input.opacity === 0.55) && getComputedStyle(query('.app-shell')).getPropertyValue('--surface-opacity').trim() === '0.55', 'opacity slider saves the background setting')
  check(getComputedStyle(query('.compact-row p')).opacity === '1', 'background transparency leaves subtitle glyph opacity intact')
  check(audioStarts === 0, 'UI regression never starts audio or provider requests')
  return { checks, deviceScaleFactor: devicePixelRatio, platform: navigator.platform }
}

async function preview(mode: 'expanded' | 'compact') {
  emit({ state: 'idle' })
  emit({ state: 'listening', collapsed: mode === 'compact', settings: { ...settings }, captions: [
    caption('previous', { original: 'Synthetic fixture: the previous sentence stays available for review.', translations: { fr: 'La phrase précédente reste disponible pour la relecture.', ja: '前の文は読み返せる。' }, ja: '前の文は読み返せる。', jaSegments: [{ text: '前', reading: 'まえ' }, { text: 'の' }, { text: '文', reading: 'ぶん' }, { text: 'は' }, { text: '読', reading: 'よ' }, { text: 'み' }, { text: '返', reading: 'かえ' }, { text: 'せる。' }] }),
    caption('current', { original: 'Synthetic fixture: today the weather is clear.', translatedOriginal: 'Synthetic fixture: today the weather is clear.', live: true, translations: { fr: "Aujourd'hui, le temps est clair.", ja: '今日の天気は晴れです。' }, ja: '今日の天気は晴れです。', jaSegments: [{ text: '今日', reading: 'きょう' }, { text: 'の' }, { text: '天気', reading: 'てんき' }, { text: 'は' }, { text: '晴', reading: 'は' }, { text: 'れです。' }] }),
  ] })
  await frame()
}
;(window as unknown as { __lingobarUiTest: { run: typeof run; preview: typeof preview } }).__lingobarUiTest = { run, preview }
createRoot(document.getElementById('root')!).render(<App />)
