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
let providerCalls = 0
const emit = (next: Partial<Snapshot>) => {
  snapshot = structuredClone({ ...snapshot, ...next })
  for (const listener of listeners) listener(snapshot)
}
const api = {
  platform: 'win32',
  getSnapshot: async () => snapshot,
  saveSettings: async (input: Partial<Settings>) => { saves.push(input); emit({ settings: { ...snapshot.settings, ...input } }); return snapshot.settings },
  start: async () => { audioStarts++; throw new Error('Audio is disabled in UI tests') },
  stop: async () => { emit({ state: 'idle' }) },
  pushMicrophone: () => { throw new Error('Audio is disabled in UI tests') },
  microphoneFailed: () => {}, microphoneReady: () => {},
  translateText: async () => { providerCalls++; throw new Error('Providers are disabled in UI tests') },
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

  // The real renderer searches local snapshots; no service, audio, or search-index dependency.
  const lookup = [
    caption('find-old', { original: 'First needle in synthetic history' }),
    caption('find-saved', { original: 'Second NEEDLE in synthetic history', saved: true }),
    caption('find-unicode', { original: '東京 Cafe\u0301 👩🏽‍💻 <img src=x onerror=alert(1)>' }),
    caption('find-other-language', { original: 'A different synthetic source', translations: { de: 'Nicht gewählte Sprache Nadel', fr: 'Exemple' } }),
    caption('find-latest', { original: 'Third needle in synthetic history' }),
  ]
  const priorFind = Array.from({ length: 20 }, (_, index) => caption(`find-prior-${index}`, { original: `Needle synthetic archive ${index}` }))
  emit({ state: 'idle', captions: [...priorFind, ...lookup] }); await frame()
  const shortcut = (target: EventTarget, key: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  const compactSurface = query('.compact-viewport')
  shortcut(compactSurface, 'f', { ctrlKey: true, isComposing: true }); await frame()
  check(!document.querySelector('.panel-history'), 'IME key events do not open history search')
  compactSurface.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  shortcut(compactSurface, 'f', { ctrlKey: true }); await frame()
  check(!document.querySelector('.panel-history'), 'composition state also protects shortcuts without an isComposing flag')
  compactSurface.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  check(shortcut(compactSurface, 'f', { ctrlKey: true }), 'Ctrl+F handles local search instead of browser find')
  await frame()
  const search = query<HTMLInputElement>('.history-search-input')
  check(!snapshot.collapsed && document.activeElement === search, 'search from compact mode expands the window and focuses history input')
  const setSearch = async (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value)
    search.dispatchEvent(new Event('input', { bubbles: true })); search.dispatchEvent(new Event('change', { bubbles: true }))
    await frame()
  }
  const matchId = () => document.querySelector('.history-match-current')?.getAttribute('data-history-id')
  await setSearch('needle')
  check(document.querySelectorAll('.history-item').length === 23 && matchId() === 'find-latest', 'local literal lookup finds original text in newest-first history')
  shortcut(search, 'Enter'); await frame()
  check(matchId() === 'find-saved', 'Enter selects the next matching segment')
  shortcut(search, 'Enter', { shiftKey: true }); await frame()
  check(matchId() === 'find-latest', 'Shift+Enter selects the previous matching segment')
  query<HTMLButtonElement>('[aria-label="上一个匹配"]').click(); await frame()
  check(matchId() === 'find-prior-0', 'previous-match button wraps by segment ID')
  shortcut(search, 'Enter'); await frame()
  shortcut(search, 'Enter'); await frame()
  check(matchId() === 'find-saved', 'keyboard navigation keeps the input available while locating older matches')
  const selectedTop = query('.history-match-current').getBoundingClientRect().top
  const arrivals = Array.from({ length: 100 }, (_, index) => caption(`find-arrival-${index}`, { original: `Needle synthetic arrival ${index}` }))
  emit({ captions: [...priorFind, ...lookup, ...arrivals] }); await frame()
  check(matchId() === 'find-saved' && Math.abs(query('.history-match-current').getBoundingClientRect().top - selectedTop) < 2, '100 arriving segments preserve the selected match and its reading position')
  const late = { ...lookup[3], translations: { ...lookup[3].translations, fr: 'needle from a delayed synthetic translation' } }
  emit({ captions: [...priorFind, ...lookup.slice(0, 3), late, lookup[4], ...arrivals] }); await frame()
  check(matchId() === 'find-saved' && Math.abs(query('.history-match-current').getBoundingClientRect().top - selectedTop) < 2, 'late translated matches do not steal the selected segment or scroll position')
  search.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  shortcut(search, 'Enter'); shortcut(search, 'Escape'); await frame()
  check(matchId() === 'find-saved' && Boolean(document.querySelector('.panel-history')), 'IME confirmation and cancellation do not navigate or close search')
  search.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  await setSearch('café')
  check(matchId() === 'find-unicode', 'canonical combining-character search finds the original Unicode text')
  await setSearch('東京')
  check(matchId() === 'find-unicode', 'CJK search remains a local literal lookup')
  await setSearch('👩🏽‍💻')
  check(matchId() === 'find-unicode', 'emoji search preserves complete displayed sequences')
  await setSearch('<img')
  check(query('.history-original').textContent?.includes('<img src=x') && !query('.history-list').querySelector('img'), 'HTML-looking subtitles are displayed as text, never markup')
  await setSearch('Nadel')
  check(matchId() === 'find-other-language' && query('.history-match-language').textContent === 'Deutsch匹配', 'search includes an existing translation outside the displayed language selection')
  await setSearch('needle')
  query<HTMLButtonElement>('.history-tabs button:nth-child(2)').click(); await frame()
  check(document.querySelectorAll('.history-item').length === 1 && matchId() === 'find-saved', 'saved-only filtering retains local search semantics')
  query<HTMLButtonElement>('[aria-label="清空查找"]').click(); await frame()
  check(search.value === '' && document.querySelectorAll('.history-item').length === 1 && document.activeElement === search, 'clearing a search restores the filtered history and input focus')
  await setSearch('no synthetic match')
  check(Boolean(document.querySelector('.empty-history')) && query<HTMLButtonElement>('[aria-label="下一个匹配"]').disabled, 'no-match state disables navigation without losing the query')
  emit({ captions: [] }); await frame()
  check(!document.querySelector('.history-match-current') && query('.history-search-count').textContent === '0 / 0', 'clearing history removes stale search selection')
  shortcut(search, 'Escape'); await frame()
  const historyButton = query<HTMLButtonElement>('[aria-label="历史与收藏"]')
  historyButton.focus(); historyButton.click(); await frame()
  check(query<HTMLInputElement>('.history-search-input').value === '', 'reopening history does not persist the search query')
  shortcut(document.activeElement!, 'Escape'); await frame()
  check(document.activeElement === historyButton && !document.querySelector('.panel-history'), 'Escape closes history and restores the invoking control focus')
  emit({ captions: lookup }); await frame()
  shortcut(historyButton, 'f', { metaKey: true }); await frame()
  check(document.activeElement === document.querySelector('.history-search-input'), 'Cmd+F also opens and focuses local history search')
  query<HTMLButtonElement>('.history-tabs button:first-child').click(); await frame()
  query<HTMLButtonElement>('[data-history-id="find-old"] .history-select').click(); await frame()
  check(!document.querySelector('.panel-history') && query('.focused-caption').getAttribute('data-caption-id') === 'find-old' && query('.stream-label').textContent?.includes('正在回看'), 'opening a history result locates its original segment and pauses live following')
  emit({ captions: [...lookup, caption('after-search')] }); await frame()
  check(query('.focused-caption').getAttribute('data-caption-id') === 'find-old', 'new subtitles do not replace a paragraph opened from search')
  query<HTMLButtonElement>('[aria-label="输入文字翻译"]').click(); await frame()
  const textInput = query<HTMLTextAreaElement>('#translation-input')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textInput, 'Synthetic typed sentence')
  textInput.dispatchEvent(new Event('input', { bubbles: true })); await frame()
  const submitButton = query<HTMLButtonElement>('.text-form button[type="submit"]')
  submitButton.focus()
  shortcut(submitButton, 'f', { ctrlKey: true }); await frame()
  check(Boolean(document.querySelector('.panel-history')) && document.activeElement === document.querySelector('.history-search-input'), 'Find remains available when the text submit button has focus')
  shortcut(document.activeElement!, 'Escape'); await frame()
  query<HTMLButtonElement>('[aria-label="输入文字翻译"]').click(); await frame()
  const composingInput = query<HTMLTextAreaElement>('#translation-input')
  composingInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  shortcut(composingInput, 'Enter', { ctrlKey: true }); await frame()
  check(providerCalls === 0, 'IME confirmation with Ctrl+Enter cannot submit typed text to a provider')
  composingInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  shortcut(composingInput, 'Enter', { metaKey: true, isComposing: true }); await frame()
  check(providerCalls === 0, 'isComposing also blocks Cmd+Enter provider submission')
  shortcut(composingInput, 'Escape'); await frame()
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
