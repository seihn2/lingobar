// Test-only entry. Never imported by the production Web entry or public asset directory.
import { createRoot } from 'react-dom/client'
import WebApp from '../../src/web/App'
import { BrowserSession, type WebSocketPort } from '../../src/web/session'
import type { AnnotationRequest } from '../../src/shared/annotation-protocol'
import type { Caption } from '../../src/shared/types'
import '../../src/renderer/style.css'
import '../../src/web/style.css'

class FixtureSocket extends EventTarget {
  readyState = 0
  bufferedAmount = 0
  sent: Array<string | ArrayBuffer> = []
  constructor(readonly sessionId: string) { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
  send(value: string | ArrayBuffer) {
    this.sent.push(value)
    if (typeof value === 'string' && JSON.parse(value).type === 'start') queueMicrotask(() => this.packet('ready'))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  packet(type: string, extra = {}) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ version: 1, type, sessionId: this.sessionId, ...extra }) })) }
}
const sockets: FixtureSocket[] = []
const annotations: Array<{ input: AnnotationRequest; signal: AbortSignal; resolve(response: Response): void }> = []
let captures = 0, cleanups = 0
let pcm!: (value: ArrayBuffer) => void
const session = new BrowserSession({ backend: '/api/session', origin: location.origin,
  id: () => `fixture-${sockets.length + 1}`,
  annotationFetch: async (_url, init) => new Promise<Response>(resolve => { annotations.push({ input: JSON.parse(init!.body as string), signal: init!.signal!, resolve }) }),
  socket: () => { const socket = new FixtureSocket(`fixture-${sockets.length + 1}`); sockets.push(socket); return socket as unknown as WebSocketPort },
  capture: async (chunk, _error, signal) => { captures++; pcm = chunk; if (signal.aborted) throw new Error('Cancelled fixture'); return () => { cleanups++ } }
})
session.saveSettings({ targetLanguages: ['fr', 'ja'] })
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const query = <T extends HTMLElement = HTMLElement>(selector: string): T => { const element = document.querySelector<T>(selector); if (!element) throw new Error(`Missing fixture element: ${selector}`); return element }
const row = (id: string, extra: Partial<Caption> = {}): Caption => ({ id, source: 'microphone', original: `Synthetic microphone sentence ${id}`, language: 'English', translations: { fr: `Traduction ${id}`, ja: '天気' }, ja: '天気', zh: '', en: '', reading: '', jaSegments: [{ text: '天気', reading: 'てんき' }], createdAt: 1, status: 'ready', saved: false, ...extra })
async function run() {
  const checks: string[] = []
  const check = (ok: unknown, message: string) => { assert(ok, message); checks.push(message) }
  const current = () => document.querySelector('.reading-current')?.getAttribute('data-caption-id')
  await frame()
  check(captures === 0 && sockets.length === 0, 'opening the web page never requests a microphone or opens a service socket')
  query<HTMLButtonElement>('.listen-button').click(); await frame()
  check(captures === 1 && query('.web-capture').textContent?.includes('正在聆听'), 'explicit start uses the browser session adapter and one synthetic microphone')
  pcm(new ArrayBuffer(3200))
  check(sockets[0].sent.at(-1) instanceof ArrayBuffer, 'browser PCM reaches the injected transport without any real media/provider')
  const s = sockets[0]
  s.packet('caption', { revision: 1, caption: row('draft', { original: 'A long synthetic unfinished sentence', translations: {}, ja: '', jaSegments: undefined, live: true, status: 'translating' }) }); await frame()
  check(query('.original-row p').textContent === 'A long synthetic unfinished sentence', 'raw partial source is readable before a translation exists')
  s.packet('caption', { revision: 2, caption: row('draft', { original: 'A long synthetic unfinished sentence', translatedOriginal: 'A translated prefix', live: true, translationPending: true }) }); await frame()
  check(current() === 'fixture-1:draft' && query('.original-row p').textContent === 'A translated prefix', 'translated partial appears immediately with its matching source prefix')
  check([...query('.caption-card').querySelectorAll('.language-label')].map(n => n.textContent).join('|') === '原文|Français|日本語', 'source and only selected languages keep their chosen order')
  check(query('ruby rt').textContent === 'てんき' && getComputedStyle(query('ruby')).rubyPosition === 'over', 'Japanese furigana stays above its matching kanji')
  s.packet('caption', { revision: 3, caption: row('draft', { original: 'A completed synthetic sentence' }) }); await frame()
  check(document.querySelectorAll('[data-caption-id="fixture-1:draft"]').length === 1 && query('.original-row p').textContent === 'A completed synthetic sentence', 'final recognition updates the same paragraph rather than duplicating it')
  query<HTMLButtonElement>('[aria-label="收藏这段"]').click(); await frame()
  s.packet('caption', { revision: 4, caption: row('draft', { original: 'A completed synthetic sentence', status: 'error' }) }); await frame()
  query<HTMLButtonElement>('.web-footer button:last-child').click(); await frame()
  const unsave = query<HTMLButtonElement>('[data-history-id="fixture-1:draft"] [aria-label="取消收藏"]')
  check(!unsave.disabled && session.snapshot().captions[0].saved, 'a saved caption with a failed revision can still be removed locally from history')
  unsave.click(); await frame()
  check(!session.snapshot().captions[0].saved, 'local removal does not depend on another successful provider response')
  query<HTMLButtonElement>('.web-panel-heading button').click(); await frame()
  for (let i = 0; i < 25; i++) s.packet('caption', { revision: 1, caption: row(`history-${i}`) })
  await frame()
  check(current() === 'fixture-1:history-24', 'new captions follow the newest translated paragraph')
  const viewport = query('.stream-viewport'); viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -160 })); viewport.scrollTop = 100; await frame()
  const before = viewport.scrollTop
  s.packet('caption', { revision: 1, caption: row('arrival') }); await frame()
  check(query('.stream-label').textContent?.includes('正在回看') && Math.abs(viewport.scrollTop - before) < 2, 'manual review keeps its reading position as another caption arrives')
  query<HTMLButtonElement>('.stream-follow').click(); await frame()
  check(current() === 'fixture-1:arrival', 'Back to live resumes following the newest caption')
  query<HTMLButtonElement>('.web-header button').click(); await frame()
  check(query('.compact-rows').getAttribute('data-caption-id') === 'fixture-1:arrival', 'compact reading preserves the newest shared reading position')
  query<HTMLButtonElement>('.web-header button').click(); await frame()
  const settingsButton = query<HTMLButtonElement>('.web-footer button:first-child'); settingsButton.focus(); settingsButton.click(); await frame()
  check(Boolean(document.querySelector('[aria-label="字幕设置"]')) && !document.querySelector('input[type=password]'), 'web settings expose language preferences without provider-secret inputs')
  const panel = query('[aria-label="字幕设置"]'); panel.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(Boolean(document.querySelector('[aria-label="字幕设置"]')), 'IME Escape does not close the web settings region')
  panel.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(!document.querySelector('[aria-label="字幕设置"]') && document.activeElement === settingsButton, 'Escape closes settings and returns focus to its trigger')
  const history = query<HTMLButtonElement>('.web-footer button:last-child'); history.focus(); history.click(); await frame()
  const input = query<HTMLInputElement>('.history-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'history-2'); input.dispatchEvent(new Event('input', { bubbles: true })); await frame()
  check(document.querySelectorAll('.history-item').length === 6, 'web history searches only local cached captions without service calls')
  query<HTMLButtonElement>('[data-history-id="fixture-1:history-2"] .history-select').click(); await frame()
  check(query('.focused-caption').getAttribute('data-caption-id') === 'fixture-1:history-2' && query('.stream-label').textContent?.includes('正在回看'), 'a history result locates its stable paragraph and pauses following')
  s.packet('caption', { revision: 1, caption: row('safe-text', { original: '<img src=x onerror=alert(1)> 合成文字' }) }); await frame()
  check(!query('.stream-content').querySelector('img') && query('[data-caption-id="fixture-1:safe-text"] .original-row p').textContent?.includes('<img'), 'HTML-looking captions remain safe literal text')
  s.packet('caption', { revision: 2, caption: row('safe-text', { original: 'Synthetic prefix and remaining words', translatedOriginal: 'Synthetic prefix', live: true, translationPending: true, furiganaStatus: 'pending' }) }); await frame()
  query<HTMLButtonElement>('.listen-button').click(); await frame()
  check(cleanups === 1 && session.snapshot().state === 'idle' && session.snapshot().captions.length === 28, 'pause releases the microphone while preserving this page history')
  check(query('[data-caption-id="fixture-1:safe-text"] .caption-untranslated').textContent?.includes('and remaining words'), 'pause keeps the last untranslated recognized words visible beside the translated prefix')
  const count = session.snapshot().captions.length; s.packet('caption', { revision: 99, caption: row('late') }); await frame()
  check(session.snapshot().captions.length === count, 'a late caption from the stopped connection cannot change history')
  query<HTMLButtonElement>('.listen-button').click(); await frame(); sockets[1].packet('caption', { revision: 1, caption: row('draft', { original: 'New session source' }) }); await frame()
  check(session.snapshot().captions.some(c => c.id === 'fixture-1:draft') && session.snapshot().captions.some(c => c.id === 'fixture-2:draft'), 'restarting namespaces reused upstream IDs and retains older history')
  window.dispatchEvent(new Event('pagehide')); await frame()
  check(session.snapshot().state === 'idle' && cleanups === 2 && sockets.length === 2, 'leaving the page stops capture without automatic reconnect')
  check(document.documentElement.scrollWidth <= innerWidth, 'phone-width layout does not overflow horizontally')
  const safety = (window as unknown as { __webSafety: { media: number; sockets: number } }).__webSafety
  check(safety.media === 0 && safety.sockets === 0, 'all regression media and service connections were synthetic, never real devices or providers')
  // Annotation retries use a paused retained row and injected HTTP, never capture or a socket.
  query<HTMLButtonElement>('.listen-button').click(); await frame()
  sockets[2].packet('caption', { revision: 1, caption: row('annotation-expanded', { furiganaStatus: 'error', jaSegments: undefined }) })
  sockets[2].packet('caption', { revision: 1, caption: row('annotation-compact', { furiganaStatus: 'error', jaSegments: undefined }) }); await frame()
  session.toggleSaved('fixture-3:annotation-expanded'); session.stop(); await frame()
  const captureCount = captures, socketCount = sockets.length
  const button = query<HTMLButtonElement>('[data-caption-id="fixture-3:annotation-expanded"] [aria-label="重试日语注音"]')
  button.focus(); button.click(); await frame()
  check(annotations.length === 1 && button === document.activeElement && button.getAttribute('aria-busy') === 'true', 'paused web annotation sends one text-only request and keeps pending-action focus')
  button.click(); await frame()
  check(annotations.length === 1 && captures === captureCount && sockets.length === socketCount, 'duplicate web annotation clicks neither repeat the request nor resume capture/socket')
  const success = (index: number) => { const { original: _source, japanese: _text, ...identity } = annotations[index].input; return new Response(JSON.stringify({ ...identity, reading: '', jaSegments: [{ text: '天気', reading: 'てんき' }] })) }
  annotations[0].resolve(success(0)); await frame()
  check(!document.querySelector('[data-caption-id="fixture-3:annotation-expanded"] [aria-label="重试日语注音"]') && document.activeElement === document.querySelector('.stream-viewport'), 'web annotation success restores removed-action focus to the reader')
  check(session.snapshot().captions.find(row => row.id === 'fixture-3:annotation-expanded')?.saved && query('[data-caption-id="fixture-3:annotation-expanded"] ruby rt').textContent === 'てんき', 'web annotation preserves saved source/translation and adds matching ruby')
  query<HTMLButtonElement>('.stream-follow').click(); query<HTMLButtonElement>('.web-header button').click(); await frame()
  check(!document.querySelector('[aria-label="重新翻译这段"]'), 'compact annotation failure offers annotation-only retry instead of retranslating valid text')
  query<HTMLButtonElement>('[aria-label="重试日语注音"]').click(); await frame()
  annotations[1].resolve(new Response(JSON.stringify({ version: 1, error: 'upstream', raw: 'discarded synthetic upstream data' }), { status: 502 })); await frame()
  check(query('.web-notice').textContent?.includes('注音服务暂不可用') && !document.body.textContent?.includes('discarded synthetic'), 'annotation failure uses fixed feedback and keeps primary translation ready')
  check(session.snapshot().captions.at(-1)?.status === 'ready' && captures === captureCount && sockets.length === socketCount, 'paused annotation failure cannot change audio or primary translation state')
  query<HTMLButtonElement>('[aria-label="重试日语注音"]').click(); await frame()
  window.dispatchEvent(new Event('pagehide')); await frame(); annotations[2].resolve(success(2)); await frame()
  check(annotations[2].signal.aborted && session.snapshot().captions.at(-1)?.furiganaStatus === 'error' && !document.querySelector('.web-notice'), 'page hiding cancels paused annotation and ignores its late result without a stale notice')
  return { checks }
}

type TouchState = { mode: 'expanded' | 'compact'; id: string; top: number; x: number; y: number; overflow: number; diagnostics?: unknown }
async function responsive() {
  const checks: string[] = []
  const check = (ok: unknown, message: string) => { assert(ok, message); checks.push(message) }
  session.saveSettings({ targetLanguages: ['zh', 'ja', 'en', 'fr', 'de', 'es', 'ko', 'ar'], fontSize: 24 })
  await session.start(); const peer = sockets.at(-1)!
  const japanese = '明日の天気は晴れです。'
  const segments = [{ text: '明日', reading: 'あした' }, { text: 'の' }, { text: '天気', reading: 'てんき' }, { text: 'は' }, { text: '晴', reading: 'は' }, { text: 'れです。' }]
  const translations = { zh: '合成译文'.repeat(30), ja: japanese, en: 'Synthetic '.repeat(20) + 'x'.repeat(200), fr: 'Traduction synthétique '.repeat(20), de: 'Synthetischer Text '.repeat(20), es: 'Texto sintético '.repeat(20), ko: '합성 문장 '.repeat(30), ar: 'نص اصطناعي '.repeat(30) }
  for (let i = 0; i < 3; i++) peer.packet('caption', { revision: 1, caption: row('responsive-' + i, { original: '合成原文 👩‍💻 e\u0301 <b>文字</b> ' + 'https://example.invalid/' + 'z'.repeat(200), translations, ja: japanese, jaSegments: segments, furiganaStatus: 'ready' }) })
  session.stop(); await frame()
  const mediaCount = captures, socketCount = sockets.length
  const shell = query('.web-shell')
  const codes = [...query('.caption-card:last-of-type').querySelectorAll('.language-label')].map(node => node.textContent)
  check(codes.length === 9 && codes[0] === '原文' && query('ruby rt').textContent === 'あした', 'responsive expanded view preserves source, all eight selected languages and matching ruby')
  check(document.documentElement.scrollWidth <= innerWidth, '24px multilingual content and unbroken synthetic URL do not overflow the page')
  query<HTMLButtonElement>('.web-header button').click(); await frame()
  const controls = query('.compact-controls'), buttons = [...controls.querySelectorAll<HTMLButtonElement>('.compact-navigation button')]
  check(buttons.every(button => button.getBoundingClientRect().width >= 44 && button.getBoundingClientRect().height >= 44), 'Web compact navigation provides 44px targets')
  const coarse = matchMedia('(hover:none),(any-pointer:coarse)').matches
  if (coarse) {
    check(getComputedStyle(controls).opacity === '1' && getComputedStyle(controls).pointerEvents === 'auto', 'coarse-pointer compact controls are visible and enabled before hover or a first tap')
    check(getComputedStyle(controls).position === 'static' && query('.compact-viewport').getBoundingClientRect().bottom <= controls.getBoundingClientRect().top, 'touch controls occupy their own row rather than cover subtitle text')
  } else {
    buttons[0].focus(); await frame()
    check(getComputedStyle(controls).opacity === '1', 'fine-pointer compact controls remain keyboard reachable')
  }
  check(document.querySelectorAll('.compact-row').length === 9, 'compact mode keeps the source and every selected language')
  query<HTMLButtonElement>('.web-header button').click(); await frame()
  const settings = query<HTMLButtonElement>('.web-footer button:first-child'); settings.focus(); settings.click(); await frame()
  check(document.activeElement === query('.web-panel-heading h1'), 'opening settings moves focus into the panel without opening a text keyboard')
  query('.web-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(document.activeElement === settings, 'closing settings restores the visible invoking control')
  const history = query<HTMLButtonElement>('.web-footer button:last-child'); history.focus(); history.click(); await frame()
  check(document.activeElement === query('.web-panel-heading h1'), 'history also owns initial focus while preserving explicit search entry')
  const input = query<HTMLInputElement>('.history-search-input'); input.focus()
  const viewport = (window as unknown as { __webViewportFixture: { set(value: { height: number; offsetTop: number; scale: number } | null): void } }).__webViewportFixture
  const height = Math.min(220, Math.floor(innerHeight / 2)), top = Math.min(100, innerHeight - height)
  viewport.set({ height, offsetTop: top, scale: 1 }); await frame()
  const bounds = shell.getBoundingClientRect(), search = query('.history-search').getBoundingClientRect()
  check(Math.abs(bounds.height - height) < 1 && Math.abs(bounds.top - top) < 1, 'synthetic keyboard resize and visual pan keep the shell within the visible area')
  const htmlStyle = document.documentElement.style.cssText, bodyStyle = document.body.style.cssText
  document.documentElement.style.height = '2000px'; document.documentElement.style.overflow = 'auto'; document.body.style.height = '2000px'; document.body.style.overflow = 'visible'
  window.scrollTo(0, 80); await frame()
  check(window.scrollY > 0 && Math.abs(shell.getBoundingClientRect().top - top) < 1, 'browser document panning does not displace the fixed visible-viewport shell')
  window.scrollTo(0, 0); document.documentElement.style.cssText = htmlStyle; document.body.style.cssText = bodyStyle; await frame()
  check(search.top >= bounds.top && search.bottom <= bounds.bottom && getComputedStyle(input).fontSize === '16px', 'short viewport keeps a readable search field above the synthetic keyboard')
  check(query('.history-list').getBoundingClientRect().height >= 24 && query('.web-capture').getBoundingClientRect().bottom <= bounds.bottom, 'short search mode preserves visible results and start/pause control')
  viewport.set({ height: height / 2, offsetTop: top + 40, scale: 2 }); await frame()
  check(Math.abs(shell.getBoundingClientRect().height - height) < 1, 'pinch zoom does not shrink the layout a second time')
  viewport.set(null); await frame()
  check(Math.abs(shell.getBoundingClientRect().height - innerHeight) < 2, 'keyboard dismissal restores the original viewport height')
  query('.web-panel').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); query('.web-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(Boolean(document.querySelector('.web-panel')), 'IME Escape keeps the Web panel open')
  query('.web-panel').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); query('.web-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(document.activeElement === history, 'history Escape restores focus after viewport recovery')
  shell.style.setProperty('--web-safe-left', '44px'); shell.style.setProperty('--web-safe-right', '34px'); await frame()
  const safeBounds = shell.getBoundingClientRect(), header = query('.web-header').getBoundingClientRect(), reading = query('.web-reading').getBoundingClientRect()
  check(header.left >= safeBounds.left + 44 && header.right <= safeBounds.right - 34 && reading.left >= safeBounds.left + 44 && reading.right <= safeBounds.right - 34, 'synthetic left/right safe-area values inset both controls and reading')
  check(document.documentElement.scrollWidth <= innerWidth, 'safe-area padding remains inside the page width')
  shell.style.setProperty('--web-safe-top', '20px'); shell.style.setProperty('--web-safe-bottom', '16px'); await frame()
  check(parseFloat(getComputedStyle(query('.web-header')).paddingTop) >= 20 && parseFloat(getComputedStyle(query('.web-footer')).paddingBottom) >= 16, 'top/bottom safe areas remain effective in the normal layout')
  history.focus(); history.click(); await frame(); query<HTMLInputElement>('.history-search-input').focus()
  viewport.set({ height, offsetTop: top, scale: 1 }); await frame()
  check(parseFloat(getComputedStyle(query('.web-capture')).paddingTop) >= 20 && parseFloat(getComputedStyle(shell).paddingBottom) >= 16, 'short panel preserves top/bottom safe areas while duplicate navigation is hidden')
  viewport.set(null); query('.web-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  shell.style.removeProperty('--web-safe-top'); shell.style.removeProperty('--web-safe-bottom')
  shell.style.removeProperty('--web-safe-left'); shell.style.removeProperty('--web-safe-right'); await frame()
  query<HTMLButtonElement>('.web-header button').click(); await frame(); query<HTMLButtonElement>('.compact-live').click(); await frame()
  check(captures === mediaCount && sockets.length === socketCount, 'focus, safe-area and viewport changes do not start recording or reconnect a service')
  return { checks, coarse, viewport: { width: innerWidth, height: innerHeight }, syntheticVisualViewport: true, syntheticSafeArea: true }
}

async function prepareTouch(mode: TouchState['mode']): Promise<TouchState> {
  session.stop(); await frame()
  if (document.querySelector('.web-panel-heading button')) query<HTMLButtonElement>('.web-panel-heading button').click()
  if (Boolean(document.querySelector('.compact-viewport')) !== (mode === 'compact')) query<HTMLButtonElement>('.web-header button').click()
  await frame(); await session.start(); await frame()
  const peer = sockets.at(-1)!, id = 'touch-long-' + sockets.length
  peer.packet('caption', { revision: 1, caption: row(id, { original: 'Synthetic touch source line. '.repeat(140), translations: { fr: 'Traduction tactile synthétique. '.repeat(140), ja: '天気' } }) })
  await frame()
  query<HTMLButtonElement>(mode === 'expanded' ? '.stream-follow' : '.compact-live').click(); await frame()
  const surface = query(mode === 'expanded' ? '.stream-viewport' : '.compact-viewport')
  surface.style.flex = '0 0 180px'; surface.style.height = '180px'; await frame()
  surface.focus(); surface.scrollTop = Math.floor((surface.scrollHeight - surface.clientHeight) / 2); await frame()
  const events = { start: 0, move: 0, end: 0, pointer: 0, cancel: 0 }
  surface.addEventListener('touchstart', () => { events.start++ }, { passive: true })
  surface.addEventListener('touchmove', () => { events.move++ }, { passive: true })
  surface.addEventListener('touchend', () => { events.end++ }, { passive: true })
  surface.addEventListener('pointerdown', () => { events.pointer++ }, { passive: true })
  surface.addEventListener('pointercancel', () => { events.cancel++ }, { passive: true })
  ;(surface as HTMLElement & { __touchEvents?: typeof events }).__touchEvents = events
  const box = surface.getBoundingClientRect()
  const diagnostics = { width: innerWidth, scale: visualViewport?.scale, box: { x: box.x, y: box.y, w: box.width, h: box.height }, hit: document.elementFromPoint(box.x + box.width * 0.65, box.y + box.height * 0.5)?.className, touchAction: getComputedStyle(surface).touchAction, bodyTouchAction: getComputedStyle(document.body).touchAction }
  return { diagnostics, mode, id: peer.sessionId + ':' + id, top: surface.scrollTop, x: box.x + box.width * 0.65, y: box.y + box.height * 0.5, overflow: surface.scrollHeight - surface.clientHeight }
}
async function verifyTouch(before: TouchState) {
  const checks: string[] = [], failures: string[] = []
  const check = (ok: unknown, message: string) => { checks.push(message); if (!ok) failures.push(message) }
  const surface = query(before.mode === 'expanded' ? '.stream-viewport' : '.compact-viewport')
  const reviewing = () => before.mode === 'expanded' ? query('.stream-label').textContent?.includes('正在回看') : Boolean(document.querySelector('.compact-review'))
  const initial = { events: (surface as HTMLElement & { __touchEvents?: unknown }).__touchEvents, pageTop: document.scrollingElement?.scrollTop, top: surface.scrollTop, reviewing: Boolean(reviewing()), overflow: surface.scrollHeight - surface.clientHeight }
  check(Math.abs(surface.scrollTop - before.top) > 5 && ((surface as HTMLElement & { __touchEvents?: { move: number } }).__touchEvents?.move || 0) > 0, before.mode + ' native touch swipe actually scrolls captions')
  check(reviewing(), before.mode + ' native touch swipe pauses following')
  const top = surface.scrollTop, peer = sockets.at(-1)!, id = 'touch-arrival-' + sockets.length
  const stable = () => before.mode === 'expanded' ? Math.abs(surface.scrollTop - top) < 2 : query('.compact-rows').getAttribute('data-caption-id') === before.id
  peer.packet('caption', { revision: 1, caption: row(id, { live: true, translationPending: true, furiganaStatus: 'pending' }) }); await frame()
  check(reviewing() && stable(), before.mode + ' touch review survives translated partial arrival')
  peer.packet('caption', { revision: 2, caption: row(id, { furiganaStatus: 'pending' }) }); await frame()
  peer.packet('caption', { revision: 3, caption: row(id, { furiganaStatus: 'ready' }) }); await frame()
  check(reviewing() && stable(), before.mode + ' touch review survives final and ruby updates')
  check(session.snapshot().state === 'listening', before.mode + ' review keeps the synthetic capture session active')
  const safety = (window as unknown as { __webSafety: { media: number; sockets: number } }).__webSafety
  check(safety.media === 0 && safety.sockets === 0, before.mode + ' touch test uses no real media or service sockets')
  return { checks, failures, details: { before, afterGesture: initial, afterUpdates: { top: surface.scrollTop, reviewing: Boolean(reviewing()) } } }
}


function touchPoint(selector: string) {
  const button = query<HTMLButtonElement>(selector)
  button.scrollIntoView({ block: 'nearest' })
  const box = button.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
  assert(button.contains(document.elementFromPoint(x, y)), 'Touch action must be visible and hit-testable')
  return { x, y }
}
function prepareTouchReturn(before: TouchState) {
  return touchPoint(before.mode === 'expanded' ? '.stream-follow' : '.compact-review button')
}
async function verifyTouchReturn(before: TouchState) {
  const checks: string[] = []
  const check = (ok: unknown, message: string) => { assert(ok, message); checks.push(message) }
  await frame()
  const reviewing = () => before.mode === 'expanded' ? query('.stream-label').textContent?.includes('正在回看') : Boolean(document.querySelector('.compact-review'))
  const current = () => before.mode === 'expanded' ? document.querySelector('.reading-current')?.getAttribute('data-caption-id') : query('.compact-rows').getAttribute('data-caption-id')
  check(!reviewing() && current() === session.snapshot().captions.at(-1)!.id, before.mode + ' native Return to live tap follows the latest translation')
  const surface = query(before.mode === 'expanded' ? '.stream-viewport' : '.compact-viewport')
  const source = query(before.mode === 'expanded' ? '.reading-current .original-row p' : '.compact-original p')
  const text = source.firstChild!, range = document.createRange(), selection = window.getSelection()!
  range.setStart(text, 0); range.setEnd(text, Math.min(8, text.textContent!.length))
  selection.removeAllRanges(); selection.addRange(range)
  const selected = selection.toString()
  // This checks the existing DOM selection guard, not native Safari long press.
  surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })); await frame()
  check(selected.length > 0 && reviewing(), before.mode + ' existing DOM selection guard pauses reading')
  sockets.at(-1)!.packet('caption', { revision: 1, caption: row('touch-selection-arrival-' + sockets.length, { live: true, translationPending: true }) }); await frame()
  check(reviewing() && selection.toString() === selected, before.mode + ' selected text survives a new translated partial')
  selection.removeAllRanges()
  return { checks }
}
function prepareTouchHistory() {
  const target = document.querySelectorAll<HTMLButtonElement>('.history-select')[1]
  assert(target, 'History fixture needs an older segment')
  const id = target!.closest<HTMLElement>('[data-history-id]')!.dataset.historyId!
  target!.scrollIntoView({ block: 'nearest' })
  const box = target!.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
  assert(target!.contains(document.elementFromPoint(x, y)), 'History touch target must be hit-testable')
  return { id, x, y }
}
async function verifyTouchHistory(id: string) {
  await frame()
  assert(!document.querySelector('.web-panel') && query('.focused-caption').getAttribute('data-caption-id') === id, 'Native history tap must locate the selected segment')
  sockets.at(-1)!.packet('caption', { revision: 1, caption: row('touch-history-arrival-' + sockets.length) }); await frame()
  assert(query('.stream-label').textContent?.includes('正在回看') && query('.focused-caption').getAttribute('data-caption-id') === id, 'History touch selection must survive new translation')
  assert(session.snapshot().state === 'listening', 'History review must not stop the synthetic audio session')
  return { checks: ['native history tap locates its stable segment', 'new translation preserves history touch selection and active capture'] }
}
;(window as unknown as { __lingobarWebTest: { run: typeof run; responsive: typeof responsive; prepareTouch: typeof prepareTouch; verifyTouch: typeof verifyTouch; touchPoint: typeof touchPoint; prepareTouchReturn: typeof prepareTouchReturn; verifyTouchReturn: typeof verifyTouchReturn; prepareTouchHistory: typeof prepareTouchHistory; verifyTouchHistory: typeof verifyTouchHistory } }).__lingobarWebTest = { run, responsive, prepareTouch, verifyTouch, touchPoint, prepareTouchReturn, verifyTouchReturn, prepareTouchHistory, verifyTouchHistory }
createRoot(document.getElementById('root')!).render(<WebApp session={session} />)
