// Offline synthetic fixtures only. No provider, audio, personal settings or Electron access.
import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/App'
import { learningTarget, validPhrase, type LearningState } from '../../src/shared/learning'
import { selectedPhrase } from '../../src/renderer/learning-selection'
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
let hideCalls = 0
let exportCalls = 0
let exportAction = async () => false
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
  retry: async () => {}, retryAnnotation: async () => {}, toggleSaved: async () => {}, exportSaved: async () => { exportCalls++; return exportAction() },
  copyText: async () => {}, importLocalKey: async () => { throw new Error('No keys in UI tests') },
  setCollapsed: async (collapsed: boolean) => { emit({ collapsed }) },
  setCompactHeight: async () => {}, hide: async () => { hideCalls++ }, quit: async () => {},
  onSnapshot: (listener: (snapshot: Snapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
  onMicrophone: () => () => {},
} as LingoAPI
window.lingo = api
// Settings may query device metadata; this UI fixture never enumerates hardware.
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
  enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {},
  getUserMedia: () => { throw new Error('Real media is forbidden in UI fixtures') },
} })

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
  checks.push(...await annotationRegression())
  return { checks, deviceScaleFactor: devicePixelRatio, platform: navigator.platform }
}

async function annotationRegression() {
  const checks: string[] = []
  const check = (ok: unknown, message: string) => { assert(ok, message); checks.push(message) }
  const originalRetry = api.retry, originalAnnotation = api.retryAnnotation
  let annotationCalls = 0, translations = 0
  api.retry = async () => { translations++ }
  api.retryAnnotation = async id => {
    annotationCalls++
    emit({ captions: snapshot.captions.map(row => row.id === id ? { ...row, furiganaStatus: 'pending' } : row) })
  }
  try {
    for (const mode of ['expanded', 'compact'] as const) {
      const row = caption('annotation-' + mode, { jaSegments: undefined, furiganaStatus: 'error', saved: true })
      emit({ state: 'idle', collapsed: mode === 'compact', settings: { ...settings }, captions: [row] }); await frame()
      const before = annotationCalls
      const button = query<HTMLButtonElement>('[aria-label="重试日语注音"]'); button.focus(); button.click(); await frame()
      const pending = query<HTMLButtonElement>('[aria-label="重试日语注音"]')
      check(annotationCalls === before + 1 && pending === document.activeElement && pending.getAttribute('aria-busy') === 'true', mode + ' annotation-only action keeps keyboard focus and exposes pending state')
      pending.click(); await frame()
      check(annotationCalls === before + 1 && translations === 0, mode + ' repeated annotation clicks never invoke translation or duplicate pending work')
      emit({ captions: [{ ...row, furiganaStatus: 'error' }] }); await frame()
      check(query<HTMLButtonElement>('[aria-label="重试日语注音"]') === pending && snapshot.captions[0].saved, mode + ' annotation failure keeps readable saved text and its focused retry action')
      pending.click(); await frame()
      emit({ captions: [{ ...row, furiganaStatus: 'ready', jaSegments: [{ text: '天気', reading: 'てんき' }] }] }); await frame()
      const viewport = query(mode === 'compact' ? '.compact-viewport' : '.stream-viewport')
      check(!document.querySelector('[aria-label="重试日语注音"]') && document.activeElement === viewport, mode + ' successful annotation returns removed-action focus to the reader')
      check(query('ruby rt').textContent === 'てんき' && snapshot.captions[0].original === row.original && snapshot.captions[0].translations?.fr === row.translations?.fr, mode + ' retry changes only ruby while preserving source and selected translations')
      emit({ captions: [row], settings: { ...settings, showFurigana: false } }); await frame()
      check(!document.querySelector('[aria-label="重试日语注音"]'), mode + ' disabled furigana hides annotation-only actions')
    }
    check(audioStarts === 0 && providerCalls === 0 && translations === 0, 'annotation UI regression never starts audio, translation or real providers')
  } finally { api.retry = originalRetry; api.retryAnnotation = originalAnnotation }
  return checks
}

async function preview(mode: 'expanded' | 'compact') {
  emit({ state: 'idle' })
  emit({ state: 'listening', collapsed: mode === 'compact', settings: { ...settings }, captions: [
    caption('previous', { original: 'Synthetic fixture: the previous sentence stays available for review.', translations: { fr: 'La phrase précédente reste disponible pour la relecture.', ja: '前の文は読み返せる。' }, ja: '前の文は読み返せる。', jaSegments: [{ text: '前', reading: 'まえ' }, { text: 'の' }, { text: '文', reading: 'ぶん' }, { text: 'は' }, { text: '読', reading: 'よ' }, { text: 'み' }, { text: '返', reading: 'かえ' }, { text: 'せる。' }] }),
    caption('current', { original: 'Synthetic fixture: today the weather is clear.', translatedOriginal: 'Synthetic fixture: today the weather is clear.', live: true, translations: { fr: "Aujourd'hui, le temps est clair.", ja: '今日の天気は晴れです。' }, ja: '今日の天気は晴れです。', jaSegments: [{ text: '今日', reading: 'きょう' }, { text: 'の' }, { text: '天気', reading: 'てんき' }, { text: 'は' }, { text: '晴', reading: 'は' }, { text: 'れです。' }] }),
  ] })
  await frame()
}
async function prepareHide(mode: 'expanded' | 'compact') {
  await preview(mode)
  const bounds = query('[aria-label="隐藏到系统托盘"]').getBoundingClientRect()
  return { calls: hideCalls, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}
async function verifyHide(mode: 'expanded' | 'compact', before: number) {
  await frame()
  const button = query('[aria-label="隐藏到系统托盘"]'), bounds = button.getBoundingClientRect()
  const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  assert(hit && button.contains(hit) && getComputedStyle(button).getPropertyValue('-webkit-app-region') === 'no-drag', `${mode} hide button is pointer-accessible outside native drag regions`)
  assert(hideCalls === before + 1 && snapshot.state === 'listening' && audioStarts === 0 && providerCalls === 0, `${mode} real browser pointer click forwards one hide call without changing capture or contacting services`)
  return [`${mode} hide button is pointer-accessible outside native drag regions`, `${mode} real browser pointer click forwards one hide call without changing capture or contacting services`]
}
async function panelFocus() {
  const checks: string[] = [], failures: string[] = []
  const check = (value: unknown, message: string) => { checks.push(message); if (!value) failures.push(message) }
  const key = (name: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra })
    ;(document.activeElement || document.body).dispatchEvent(event)
    return event.defaultPrevented
  }
  const settingsButton = () => query<HTMLButtonElement>('[aria-label="设置"]')
  emit({ state: 'idle', collapsed: true, settings: { ...settings }, captions: [caption('focus-synthetic', { saved: true })] }); await frame()
  settingsButton().focus(); settingsButton().click(); await frame()
  check(document.querySelector('.panel-settings')?.getAttribute('aria-label') === '设置' && document.querySelector('.panel-settings')?.contains(document.activeElement), 'compact settings opens a named dialog with focus inside')
  key('Escape'); await frame()
  check(document.activeElement === settingsButton(), 'Escape after compact settings restores the equivalent expanded settings trigger')

  settingsButton().focus(); settingsButton().click(); await frame()
  const close = query<HTMLButtonElement>('[aria-label="关闭面板"]')
  close.focus(); check(key('Tab', { shiftKey: true }) && document.activeElement === query('.settings-form button[type="submit"]'), 'Shift+Tab wraps from dialog first to last enabled control')
  check(key('Tab') && document.activeElement === close, 'Tab wraps from dialog last to first enabled control')
  const nav = () => [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
  nav()[0].click(); await frame()
  check(nav().map(button => button.getAttribute('aria-pressed')).join('|') === 'true|false|false', 'settings navigation exposes the current language section')
  const remove = query<HTMLButtonElement>('[aria-label="移除法语"]')
  remove.focus(); remove.click(); await frame()
  const frenchOption = [...document.querySelectorAll<HTMLButtonElement>('.language-options button')].find(button => button.textContent?.startsWith('法语'))!
  check(!remove.isConnected && document.activeElement === frenchOption, 'removing a focused selected language moves focus to its stable language option')
  frenchOption.click(); await frame()
  check(frenchOption.getAttribute('aria-pressed') === 'true', 'the focused language option can re-add the removed language')
  nav()[1].click(); await frame()
  check(nav().map(button => button.getAttribute('aria-pressed')).join('|') === 'false|true|false', 'changing settings sections updates their accessible state')
  close.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); key('Escape'); await frame()
  check(Boolean(document.querySelector('.panel-settings')), 'IME Escape does not close settings during composition')
  close.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); close.click(); await frame()
  check(document.activeElement === settingsButton(), 'closing settings with its named button restores the original trigger')

  settingsButton().focus(); settingsButton().click(); await frame()
  query<HTMLFormElement>('.settings-form').requestSubmit(); await frame()
  check(!document.querySelector('.panel') && document.activeElement === settingsButton(), 'saving settings restores focus without recording or service calls')
  const textButton = query<HTMLButtonElement>('[aria-label="输入文字翻译"]')
  textButton.focus(); textButton.click(); await frame()
  check(document.activeElement === query('#translation-input'), 'text panel still initially focuses its named textarea')
  key('Escape'); await frame()
  check(document.activeElement === textButton, 'Escape from an autofocus textarea restores the text-panel trigger')
  textButton.focus(); textButton.click(); await frame()
  key('f', { ctrlKey: true }); await frame()
  check(document.activeElement === query('.history-search-input'), 'Find from a text panel focuses history without retaining the removed textarea')
  key('f', { ctrlKey: true }); await frame()
  key('Escape'); await frame()
  check(document.activeElement === textButton, 'switching panels and repeated Find retain the original outside invoker')

  await api.setCollapsed(true); await frame()
  query('.compact-viewport').focus(); key('f', { ctrlKey: true }); await frame()
  const filter = () => [...document.querySelectorAll<HTMLButtonElement>('.history-tabs button')]
  check(filter().map(button => button.getAttribute('aria-pressed')).join('|') === 'true|false', 'history exposes the current all-history filter')
  filter()[1].click(); await frame()
  check(filter().map(button => button.getAttribute('aria-pressed')).join('|') === 'false|true', 'saved-history filtering updates its accessible state')
  key('Escape'); await frame()
  check(document.activeElement === query('[aria-label="历史与收藏"]'), 'Find opened from compact reading returns focus to the expanded history control')
  check(audioStarts === 0 && providerCalls === 0, 'panel focus tests never start media or call providers')
  return { checks, failures }
}

async function prepareSpaceScroll(mode: 'expanded' | 'compact', reverse: boolean, action: 'scroll' | 'copy' | 'modified' = 'scroll') {
  emit({ state: 'idle', captions: [], collapsed: mode === 'compact' }); await frame()
  const long = caption('space-current', { original: 'Synthetic source line. '.repeat(100), translations: { fr: 'Synthetic translation line. '.repeat(100), ja: '天気' } })
  emit({ state: 'listening', captions: [caption('space-previous'), long], collapsed: mode === 'compact' }); await frame()
  query<HTMLButtonElement>(mode === 'expanded' ? '.stream-follow' : '.compact-live').click(); await frame()
  const surface = query(mode === 'expanded' ? '.stream-viewport' : '.compact-viewport')
  surface.style.flex = '0 0 120px'; surface.style.height = '120px'; await frame()
  surface.focus(); surface.scrollTop = reverse ? surface.scrollHeight - surface.clientHeight : 0; await frame()
  if (action === 'copy') query<HTMLButtonElement>('[data-caption-id="space-current"] [aria-label="复制这段多语对照"]').focus()
  return { top: surface.scrollTop, overflow: surface.scrollHeight - surface.clientHeight, current: mode === 'expanded' ? currentId() : compactId() }
}

async function verifySpaceScroll(mode: 'expanded' | 'compact', reverse: boolean, before: { top: number; current: string }, action: 'scroll' | 'copy' | 'modified' = 'scroll') {
  const checks: string[] = [], failures: string[] = []
  const check = (condition: unknown, message: string) => { checks.push(message); if (!condition) failures.push(message) }
  const surface = query(mode === 'expanded' ? '.stream-viewport' : '.compact-viewport')
  const reviewing = () => mode === 'expanded' ? query('.stream-label').textContent?.includes('正在回看') : Boolean(document.querySelector('.compact-review'))
  if (action === 'scroll') {
    check(reverse ? surface.scrollTop < before.top - 1 : surface.scrollTop > before.top + 1, `${mode} trusted ${reverse ? 'Shift+Space' : 'Space'} retains native page scrolling`)
    check(reviewing(), `${mode} trusted ${reverse ? 'Shift+Space' : 'Space'} pauses live following`)
    const top = surface.scrollTop
    emit({ captions: [...snapshot.captions, caption('space-arrival')] }); await frame()
    check(reviewing() && (mode === 'expanded' ? Math.abs(surface.scrollTop - top) < 2 : compactId() === before.current), `${mode} arriving translation respects Space keyboard review`)
    query<HTMLButtonElement>(mode === 'expanded' ? '.stream-follow' : '.compact-live').click(); await frame()
    check(!reviewing() && (mode === 'expanded' ? currentId() : compactId()) === 'space-arrival', `${mode} explicit return resumes latest translation`)
  } else {
    check(!reviewing(), `${mode} ${action === 'copy' ? 'Space on a caption action' : 'Ctrl+Space'} does not pause following`)
    if (action === 'copy') check(Boolean(document.querySelector('[data-caption-id="space-current"] [aria-label="复制这段多语对照"] .lucide-check')), 'Space still activates the focused copy button')
  }
  return { checks, failures }
}
async function preparePanelA11y(mode: 'settings' | 'history') {
  const trigger = query<HTMLButtonElement>(mode === 'settings' ? '[aria-label="设置"]' : '[aria-label="历史与收藏"]')
  trigger.focus(); trigger.click(); await frame()
  query<HTMLButtonElement>(mode === 'settings' ? '.settings-nav button' : '.history-tabs button').click(); await frame()
}
async function exportRegression() {
  const checks: string[] = [], failures: string[] = []
  const check = (value: unknown, message: string) => { checks.push(message); if (!value) failures.push(message) }
  const saved = caption('synthetic-export', { saved: true })
  emit({ state: 'idle', message: '', captions: [saved], partial: {}, collapsed: false }); await frame()
  const openHistory = async () => { query<HTMLButtonElement>('[aria-label="历史与收藏"]').click(); await frame() }
  const close = async () => { query<HTMLButtonElement>('[aria-label="关闭面板"]').click(); await frame() }
  const button = () => query<HTMLButtonElement>('.history-toolbar > button')
  const exportToast = () => document.querySelector('.toast')?.textContent?.includes('收藏已导出')
  await openHistory()
  exportAction = async () => false
  button().click(); await frame()
  check(!exportToast() && !document.querySelector('.history-export-result'), 'cancelled export is silent and shows no success')
  check(snapshot.captions[0].saved && snapshot.captions[0].id === saved.id, 'export cancellation retains the synthetic saved caption')

  let reject!: (error: Error) => void
  const pending = new Promise<boolean>((_yes, no) => { reject = no })
  exportAction = () => pending; exportCalls = 0
  button().focus(); button().click(); button().click(); await frame()
  check(button().getAttribute('aria-disabled') === 'true' && button().getAttribute('aria-busy') === 'true' && document.activeElement === button() && exportCalls === 1, 'one pending export prevents duplicate dialogs, keeps focus and exposes its busy state')
  await close()
  query<HTMLButtonElement>('[aria-label="设置"]').click(); await frame()
  emit({ state: 'error', message: 'Synthetic current capture error' }); await frame()
  reject(new Error('Synthetic export write failure')); await frame()
  check(!query('.panel-settings').textContent?.includes('Synthetic export write failure'), 'late export failure does not enter a different settings panel')
  await close()
  await openHistory()
  check(Boolean(document.querySelector('.history-export-result[role="alert"]')?.textContent?.includes('导出未完成：Synthetic export write failure')), 'reopening history retains the failed export result in its own context')
  check(!button().disabled && snapshot.captions[0].saved, 'a failed export releases its button and preserves the saved caption')

  let rejectAgain!: (error: Error) => void
  const another = new Promise<boolean>((_yes, no) => { rejectAgain = no })
  exportAction = () => another
  button().click(); await frame(); await close()
  rejectAgain(new Error('Synthetic second export failure')); await frame()
  check(query('.inline-notice').textContent?.includes('Synthetic current capture error') && !query('.inline-notice').textContent?.includes('Synthetic second export failure'), 'late export failure cannot hide the current capture error')
  await openHistory()

  exportAction = async () => true
  button().click(); await frame()
  check(Boolean(document.querySelector('.history-export-result[role="status"]')?.textContent?.includes('收藏已导出')) && !exportToast(), 'successful retry reports export success locally without a global toast')
  exportAction = async () => false
  button().click(); await frame()
  check(!document.querySelector('.history-export-result') && !exportToast(), 'cancelling another export clears its previous result without claiming success')
  await close()
  check(snapshot.state === 'error' && snapshot.message === 'Synthetic current capture error' && audioStarts === 0 && providerCalls === 0, 'export feedback never changes capture state or calls audio/providers')
  emit({ state: 'idle', message: '' }); await frame()
  return { checks, failures }
}
async function loginItemRegression() {
  const checks: string[] = []
  const check = (ok: unknown, label: string) => { assert(ok, label); checks.push(label) }
  const originalSave = api.saveSettings
  let removals = 0, pending = true
  let reject!: (error: Error) => void
  const refusal = new Promise<void>((_yes, no) => { reject = no })
  const requests: Array<Partial<Settings>> = []
  api.saveSettings = async input => {
    requests.push(structuredClone(input))
    if (Object.keys(input).length === 1 && input.launchAtLogin === false) {
      removals++
      if (pending) await refusal
    }
    if (input.launchAtLogin === true) throw new Error('Startup registration is prohibited in this fixture')
    return originalSave(input)
  }
  try {
    emit({ state: 'idle', message: '', settings: { ...settings, launchAtLogin: false } }); await frame()
    query<HTMLButtonElement>('[aria-label="设置"]').click(); await frame()
    const appearance = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find(button => button.textContent?.includes('显示与启动'))!
    appearance.click(); await frame()
    const startup = [...document.querySelectorAll<HTMLLabelElement>('.toggle-setting')].find(label => label.textContent?.includes('不允许开机启动'))!.querySelector<HTMLInputElement>('input')!
    check(startup.disabled && !startup.checked && query('.settings-content').textContent?.includes('不会创建或恢复'), 'startup stays visibly off and cannot be enabled in settings')
    const remove = [...document.querySelectorAll<HTMLButtonElement>('.settings-content button')].find(button => button.textContent?.includes('移除语伴登录项'))!
    remove.focus(); remove.click(); remove.click(); await frame()
    query<HTMLFormElement>('.settings-form').requestSubmit(); await frame()
    check(removals === 1 && requests.length === 1 && remove.getAttribute('aria-busy') === 'true' && document.activeElement === remove, 'one explicit removal keeps focus and prevents duplicate removal or concurrent form save')
    reject(new Error('系统尚未确认移除语伴登录项。')); await frame()
    check(Boolean(document.querySelector('.panel-settings')) && query('.panel-notice').textContent?.includes('尚未确认移除') && remove.getAttribute('aria-busy') === 'false', 'failed removal is reported without claiming success or closing settings')
    emit({ captions: [caption('login-item-status-update')] }); await frame()
    check(removals === 1 && snapshot.settings.launchAtLogin === false, 'ordinary snapshots do not retry removal or enable startup')
    pending = false; remove.click(); await frame()
    check(removals === 2 && Boolean(document.querySelector('.panel-settings')) && query('.settings-content [role="status"]').textContent?.includes('登录项关闭'), 'only an explicit removal retry reports its result while retaining the settings draft')
    query<HTMLFormElement>('.settings-form').requestSubmit(); await frame()
    check(!document.querySelector('.panel') && removals === 2 && requests.every(input => input.launchAtLogin !== true), 'ordinary preference save keeps startup off and does not submit another removal')
    check(audioStarts === 0 && providerCalls === 0, 'startup-policy UI tests never start audio or call providers')
  } finally {
    api.saveSettings = originalSave
    emit({ state: 'idle', message: '', settings: { ...settings } }); await frame()
  }
  return { checks }
}

async function learningRegression() {
  const checks: string[] = []
  const check = (value: unknown, message: string) => { assert(value, message); checks.push(message) }
  const before = { audioStarts, providerCalls, hideCalls }
  const pinned: string[] = [], copied: string[] = []
  let shortcut: (() => void) | undefined
  let learning: LearningState = { records: [], sessions: [], currentSessionId: null, warning: '', shortcutAvailable: false }
  let saveCalls = 0
  const originalCopy = api.copyText
  api.copyText = async text => { copied.push(text) }
  api.learning = {
    pin: async target => {
      const item = snapshot.captions.find(item => item.id === target?.id)
      if (!item || learningTarget(item, snapshot.settings).version !== target?.version) return { kind: 'changed', message: '目标已变化，暂未收藏。' }
      if (item.live || item.translationPending || item.status !== 'ready') return { kind: 'incomplete', message: '这句尚未完成，暂未收藏。' }
      if (item.saved) return { kind: 'already', message: '已经收藏' }
      pinned.push(item.id); item.saved = true; emit({}); return { kind: 'saved', message: '已收藏' }
    },
    save: async edit => {
      saveCalls++
      const item = snapshot.captions.find(item => item.id === edit.target.id)
      if (!item || learningTarget(item, snapshot.settings).version !== edit.target.version) return { kind: 'changed', message: '目标已变化，草稿仍保留' }
      item.saved = true
      learning.records = learning.records.filter(record => record.captionId !== item.id).concat({ captionId: item.id, fingerprint: 'fixture', sessionId: null, savedAt: 1, phrases: edit.phrases, note: edit.note })
      emit({ learning }); return { kind: 'saved', message: '句子与笔记已保存' }
    },
    session: async () => {}, removeNotes: async id => { learning.records = learning.records.filter(record => record.captionId !== id); emit({ learning }) },
    onQuickPin: callback => { shortcut = callback; return () => { shortcut = undefined } },
  }
  const button = (label: string) => query<HTMLButtonElement>(`button[aria-label="${label}"]`)
  const byText = (text: string) => { const item = [...document.querySelectorAll<HTMLButtonElement>('.panel-study button')].find(item => item.textContent === text); if (!item) throw new Error(`Missing study button ${text}`); return item }
  const value = (element: HTMLInputElement | HTMLTextAreaElement, next: string) => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, next); element.dispatchEvent(new Event('input', { bubbles: true })) }
  const a = caption('learning-a', { original: 'pick it up 日本語 👩🏽‍💻 é word word', saved: false })
  const b = caption('learning-b', { saved: false })
  emit({ state: 'idle', captions: [a, b], collapsed: true, settings: { ...settings }, learning }); await frame()
  button('上一段').click(); await frame()
  check(compactId() === a.id, 'QuickPin fixture is reading a non-tail compact caption')
  shortcut!(); await frame(); shortcut!(); await frame()
  check(pinned.join() === a.id && snapshot.captions[0].saved, 'QuickPin saves the actual cursor once and repeat does not unsave')
  check(!document.querySelector('.panel'), 'QuickPin does not open a panel')
  const active = document.activeElement
  shortcut!(); await frame(); check(document.activeElement === active, 'QuickPin completion does not move internal focus')
  const origin = button('查看句子与笔记'); origin.focus(); origin.click(); await frame()
  check(Boolean(document.querySelector('.panel-study .study-source')), 'explicit detail opens inside the existing main window')
  const source = query('.study-source').textContent!
  const translations = query('.study-translations').textContent
  check([...document.querySelectorAll('[data-study-language]')].map(item => item.getAttribute('data-study-language')).join() === 'fr,ja', 'frozen detail preserves selected language order')
  check(Boolean(document.querySelector('.study-translations ruby rt')), 'frozen detail preserves same-version Japanese ruby')
  value(query<HTMLTextAreaElement>('[aria-label="句子笔记"]'), 'synthetic draft'); await frame()
  const sourceNode = query('.study-source').firstChild!
  const range = document.createRange(); range.setStart(sourceNode, 0); range.setEnd(sourceNode, 10)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  byText('加入所选原文短语').click(); await frame()
  check(query('.study-phrases').textContent!.includes('pick it up'), 'source selection maps a contiguous multiword phrase')
  const revised = { ...snapshot.captions[0], original: 'Revised source', translations: { fr: 'Révision', ja: '改訂' } }
  emit({ captions: [revised, ...Array.from({ length: 20 }, (_, i) => caption(`new-${i}`))] }); await frame()
  check(query('.study-source').textContent === source && query('.study-translations').textContent === translations, '20 new captions and same-id revision cannot replace frozen source/translation/ruby')
  check(query<HTMLTextAreaElement>('[aria-label="句子笔记"]').value === 'synthetic draft' && query('.study-phrases').textContent!.includes('pick it up'), 'incoming revisions preserve edited draft and span')
  query<HTMLTextAreaElement>('[aria-label="句子笔记"]').blur(); await frame()
  check(saveCalls === 0, 'blur never commits an in-memory draft')
  query('[aria-label="句子笔记"]').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(!document.querySelector('.study-confirm'), 'composition lifecycle protects Escape even without an isComposing key flag')
  query('[aria-label="句子笔记"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); await frame()
  check(!document.querySelector('.study-confirm') && Boolean(document.querySelector('.study-detail')), 'IME Escape does not discard or close detail')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(Boolean(document.querySelector('.study-confirm')), 'Escape requests explicit discard for edited drafts')
  byText('继续编辑').click(); await frame()
  byText('保存句子与笔记').click(); await frame()
  check(query('[role="status"].panel-notice').textContent!.includes('目标已变化') && query<HTMLTextAreaElement>('[aria-label="句子笔记"]').value === 'synthetic draft', 'stale source save refuses binding and preserves draft')
  byText('复制原文').click(); await frame()
  check(copied.at(-1) === source, 'copy uses frozen original without ruby or translation text')
  emit({ captions: [a, b], learning }); await frame()
  byText('保存句子与笔记').click(); await frame()
  check(learning.records[0]?.note === 'synthetic draft', 'explicit save persists notes and phrases only on the matching encounter')
  byText('删除已保存笔记').click(); await frame()
  check(learning.records.length === 0 && query<HTMLTextAreaElement>('[aria-label="句子笔记"]').value === '' && !document.querySelector('.study-phrases li'), 'delete removes active note/spans while retaining ordinary favorite')
  button('关闭学习面板').click(); await frame()
  check(snapshot.collapsed && compactId() === a.id, 'closing detail restores compact reading cursor instead of jumping to tail')
  check(document.activeElement === query('.compact-viewport'), 'return restores only an internal focus fallback')
  // Reopen/discard is explicit; a delayed copy error belongs only to its original detail.
  button('查看句子与笔记').click(); await frame()
  let rejectCopy!: (reason: Error) => void
  api.copyText = () => new Promise<void>((_resolve, reject) => { rejectCopy = reject })
  byText('复制原文').click(); await frame()
  value(query<HTMLTextAreaElement>('[aria-label="句子笔记"]'), 'discard me'); await frame()
  byText('会话匣').click(); await frame()
  check(Boolean(document.querySelector('.study-confirm')), 'changing views also protects edited drafts')
  byText('放弃草稿并离开').click(); await frame()
  query<HTMLSelectElement>('[aria-label="学习会话"]').value = 'all'
  query('[aria-label="学习会话"]').dispatchEvent(new Event('change', { bubbles: true })); await frame()
  value(query<HTMLInputElement>('.history-search-input'), 'learning-a'); await frame()
  const inboxRow = query<HTMLButtonElement>('.history-select'); inboxRow.focus(); inboxRow.click(); await frame()
  rejectCopy(new Error('obsolete synthetic copy error')); await frame()
  check(!document.querySelector('.panel-notice')?.textContent?.includes('obsolete') && query<HTMLTextAreaElement>('[aria-label="句子笔记"]').value === '', 'discarded draft and old copy error do not leak into reopened detail')
  api.copyText = async text => { copied.push(text) }
  byText('会话匣').click(); await frame()
  check(query<HTMLInputElement>('.history-search-input').value === 'learning-a' && document.activeElement === inboxRow, 'return to inbox preserves search and the exact internal row focus')
  inboxRow.click(); await frame()
  const originalSave = api.learning.save
  let finishSave!: (result: { kind: 'saved'; message: string }) => void
  let pendingWrites = 0
  api.learning.save = () => { pendingWrites++; return new Promise(resolve => { finishSave = resolve }) }
  byText('保存句子与笔记').click(); byText('保存句子与笔记').click(); await frame()
  check(pendingWrites === 1 && query<HTMLTextAreaElement>('[aria-label="句子笔记"]').matches(':disabled'), 'pending writes coalesce repeated clicks and protect new edits')
  button('关闭学习面板').click(); await frame()
  check(Boolean(document.querySelector('.study-detail')), 'navigation waits for a pending explicit write')
  finishSave({ kind: 'saved', message: 'synthetic saved' }); await frame()
  api.learning.save = originalSave
  button('关闭学习面板').click(); await frame()
  emit({ captions: [{ ...a, live: true, saved: false }, b] }); await frame(); shortcut!(); await frame()
  check(pinned.length === 1 && query('.toast').textContent!.includes('尚未完成'), 'live cursor cannot pin a different ready sentence')
  const expanded = Array.from({ length: 15 }, (_, i) => caption(`expanded-study-${i}`))
  emit({ captions: expanded, collapsed: false }); await frame()
  const viewport = query('.stream-viewport'); viewport.scrollTop = 600
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); viewport.dispatchEvent(new Event('scroll')); await frame()
  const anchor = [...document.querySelectorAll<HTMLElement>('.caption-card')].find(row => row.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top + 1)!
  const anchorId = anchor.dataset.captionId
  let offset = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  const noteButton = anchor.querySelector<HTMLButtonElement>('[aria-label="查看句子与笔记"]')!; noteButton.focus(); await frame(); offset = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top; noteButton.click(); await frame()
  emit({ captions: [...expanded, ...Array.from({ length: 20 }, (_, i) => caption(`expanded-new-${i}`))] }); await frame()
  button('关闭学习面板').click(); await frame()
  const restored = document.querySelector<HTMLElement>(`[data-caption-id="${anchorId}"]`)!
  check(!snapshot.collapsed && Math.abs(restored.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset) < 3 && document.activeElement === noteButton, `expanded study restores a paused history anchor and its internal invoking button (${offset} -> ${restored.getBoundingClientRect().top - viewport.getBoundingClientRect().top}; focus=${document.activeElement === noteButton})`)
  // Exercise the real mapper with cross-node/ruby/repeated text and invalid grapheme boundaries.
  const host = document.createElement('div'); host.innerHTML = '<span>word </span><ruby>日本<rt>にほん</rt></ruby><span>語 word 👩🏽‍💻 é</span><button>exclude</button>'; document.body.append(host)
  const plain = 'word 日本語 word 👩🏽‍💻 é'
  const selection = window.getSelection()!
  const select = (a: Node, start: number, b: Node, end: number) => { const r = document.createRange(); r.setStart(a, start); r.setEnd(b, end); selection.removeAllRanges(); selection.addRange(r); return selectedPhrase(host, plain, selection) }
  const phrase = select(host.querySelector('span')!.firstChild!, 0, host.querySelectorAll('span')[1].firstChild!, 1)
  check(phrase?.exact === 'word 日本語' && phrase.end === 8, 'cross-node ruby selection excludes rt text and button text')
  check(select(host.querySelector('rt')!.firstChild!, 0, host.querySelector('rt')!.firstChild!, 2) === null, 'selection inside ruby annotation is refused')
  const tail = host.querySelectorAll('span')[1].firstChild!
  const repeated = select(tail, 2, tail, 6)
  check(repeated?.start === 9 && repeated.exact === 'word', 'repeated words use DOM offsets rather than substring guessing')
  check(!validPhrase('👩🏽‍💻', { start: 0, end: 2, exact: '👩' }) && !validPhrase('é', { start: 0, end: 1, exact: 'e' }), 'ZWJ and combining-character partial spans are refused')
  host.remove(); selection.removeAllRanges()
  check(audioStarts === before.audioStarts && providerCalls === before.providerCalls && hideCalls === before.hideCalls, 'learning has zero provider/audio/hide request increments versus the existing fixture baseline')
  api.copyText = originalCopy; delete api.learning; emit({ learning: undefined, collapsed: false, captions: [] }); await frame()
  return { checks, failures: [] }
}

;(window as unknown as { __lingobarUiTest: { learningRegression: typeof learningRegression; run: typeof run; preview: typeof preview; prepareHide: typeof prepareHide; verifyHide: typeof verifyHide; panelFocus: typeof panelFocus; preparePanelA11y: typeof preparePanelA11y; exportRegression: typeof exportRegression; loginItemRegression: typeof loginItemRegression; prepareSpaceScroll: typeof prepareSpaceScroll; verifySpaceScroll: typeof verifySpaceScroll } }).__lingobarUiTest = { learningRegression, run, preview, prepareHide, verifyHide, panelFocus, preparePanelA11y, exportRegression, loginItemRegression, prepareSpaceScroll, verifySpaceScroll }
createRoot(document.getElementById('root')!).render(<App />)
