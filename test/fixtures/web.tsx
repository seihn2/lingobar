// Test-only entry. Never imported by the production Web entry or public asset directory.
import { createRoot } from 'react-dom/client'
import WebApp from '../../src/web/App'
import { BrowserSession, type WebSocketPort } from '../../src/web/session'
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
let captures = 0, cleanups = 0
let pcm!: (value: ArrayBuffer) => void
const session = new BrowserSession({ backend: '/api/session', origin: location.origin,
  id: () => `fixture-${sockets.length + 1}`,
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
  return { checks }
}

type TouchState = { mode: 'expanded' | 'compact'; id: string; top: number; x: number; y: number; overflow: number }
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
  surface.focus(); surface.scrollTop = surface.scrollHeight - surface.clientHeight; await frame()
  const box = surface.getBoundingClientRect()
  return { mode, id: peer.sessionId + ':' + id, top: surface.scrollTop, x: box.x + box.width * 0.65, y: box.y + box.height * 0.5, overflow: surface.scrollHeight - surface.clientHeight }
}
async function verifyTouch(before: TouchState) {
  const checks: string[] = [], failures: string[] = []
  const check = (ok: unknown, message: string) => { checks.push(message); if (!ok) failures.push(message) }
  const surface = query(before.mode === 'expanded' ? '.stream-viewport' : '.compact-viewport')
  const reviewing = () => before.mode === 'expanded' ? query('.stream-label').textContent?.includes('正在回看') : Boolean(document.querySelector('.compact-review'))
  const initial = { top: surface.scrollTop, reviewing: Boolean(reviewing()), overflow: surface.scrollHeight - surface.clientHeight }
  check(surface.scrollTop < before.top - 5, before.mode + ' native touch swipe actually scrolls captions')
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

;(window as unknown as { __lingobarWebTest: { run: typeof run; prepareTouch: typeof prepareTouch; verifyTouch: typeof verifyTouch } }).__lingobarWebTest = { run, prepareTouch, verifyTouch }
createRoot(document.getElementById('root')!).render(<WebApp session={session} />)
