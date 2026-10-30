// Synthetic learning data and in-memory provider only. This fixture never opens media,
// reaches a provider, reads credentials, or accesses a user's learning library.
import { createRoot } from 'react-dom/client'
import App from '../../src/renderer/App'
import type { Caption, LingoAPI, Settings, Snapshot } from '../../src/shared/types'
import DictionaryPanel, { PhraseExplanation } from '../../src/renderer/DictionaryPanel'
import { usableDictionaryExplanation, type DictionaryAPI, type DictionaryDetail, type DictionaryEncounter, type DictionaryExplanation, type GeneratedDictionaryExplanation, type DictionaryHandleResult, type DictionaryQuery, type DictionaryReviewEvent, type DictionaryReviewSession, type DictionaryRunState, type DictionarySnapshot, type DictionaryOpen } from '../../src/shared/dictionary'
import type { OfflineHit, OfflinePackInfo } from '../../src/shared/offline-dictionary'
import type { Phrase } from '../../src/shared/learning'
import type { TargetLanguage } from '../../src/shared/languages'
import '../../src/renderer/style.css'

let forbiddenNetwork = 0, forbiddenMedia = 0
window.fetch = (() => { forbiddenNetwork++; throw new Error('Only the in-memory dictionary provider is allowed in this fixture') }) as typeof fetch
window.WebSocket = class { constructor() { forbiddenNetwork++; throw new Error('WebSocket is forbidden in dictionary UI fixtures') } } as unknown as typeof WebSocket
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
  enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {},
  getUserMedia: () => { forbiddenMedia++; throw new Error('Real media is forbidden in dictionary UI fixtures') },
} })

const text = 'He picked it up yesterday. 日本語 👩🏽‍💻 é'
const phrase: Phrase = { start: 3, end: 15, exact: 'picked it up' }
const source: DictionarySnapshot = { text, language: 'English', sourceType: 'text', provenance: 'main-verified', captionId: 'synthetic-caption', sourceVersion: 'a'.repeat(64), displayedVersion: 'b'.repeat(64) }
const listeners = new Set<() => void>()
const emit = () => { revision++; for (const callback of listeners) callback() }
const clone = <T,>(value: T): T => structuredClone(value)
const records = new Map<string, DictionaryEncounter>()
const runs = new Map<string, DictionaryRunState>()
const handles = new Map<string, DictionarySnapshot>([['synthetic-handle', source]])
const openRequests: DictionaryOpen[] = [], openHandles: string[] = [], releasedHandles: string[] = []
let configured = true, revision = 0, providerCalls = 0, cancelCalls = 0, retrySaveCalls = 0, exportCalls = 0, noteWrites = 0, favoriteWrites = 0, deleteCalls = 0, closeCalls = 0, revealCalls = 0, ignoredLate = 0
let nextId = 0, mountId = 0, currentRequest: { id: string; attemptId: string; generation: number } | null = null
let generation = 0, failRating = false, failEdit = false
const inputRequests: Array<{ handle: string; span: Phrase; language: TargetLanguage; encounterId?: string }> = []
const reviews: DictionaryReviewEvent[] = []
let session: DictionaryReviewSession | null = null
let reveal: { id: string; encounterId: string; explanationId: string; cursor: number } | null = null
const ratedTokens = new Map<string, string>()
const eventPositions = new Map<string, number>()
const undone = new Set<string>()
let exportSnapshot: DictionaryEncounter[] = []

function explanation(id: string, nullable = false, status: 'ok' | 'ambiguous' = 'ok'): GeneratedDictionaryExplanation {
  const target = records.get(id)?.source.span.exact || phrase.exact
  return {
    schemaVersion: 1, encounterId: id, explanationId: `${id}-explanation-${(records.get(id)?.explanations.length || 0) + 1}`, version: (records.get(id)?.explanations.length || 0) + 1,
    providerKind: 'llm-generated', providerLabel: 'Synthetic provider', model: 'synthetic-model', promptVersion: 'dictionary-v1', createdAt: 1000 + nextId,
    requestedExplanationLanguage: 'zh', finishReason: 'stop', usage: null, readingScope: 'requested-surface-unverified', validationWarnings: [],
    content: status === 'ambiguous' ? { schemaVersion: 1, status, reasonCode: 'ambiguous_context', targetText: target, headword: null, reading: null, partOfSpeech: null, contextMeaning: null, usageNote: null, examples: null } : {
      schemaVersion: 1, status, reasonCode: null, targetText: target, headword: nullable ? null : 'pick it up', reading: nullable ? null : { text: 'pɪkt ɪt ʌp', notation: 'ipa' }, partOfSpeech: nullable ? null : '动词短语（合成）',
      contextMeaning: `SYNTHETIC_MEANING_${id}`, usageNote: nullable ? null : 'SYNTHETIC_USAGE <b>plain text</b>',
      examples: nullable ? null : [{ text: 'AI example <img src="https://invalid.test/image"> [remote](https://invalid.test/link)', translation: 'AI生成合成例句译文' }],
    },
  }
}
function seed() {
  currentRequest = null; generation++; records.clear(); runs.clear(); handles.clear(); handles.set('synthetic-handle', source)
  for (let index = 0; index < 32; index++) {
    const id = `seed-${String(index).padStart(2, '0')}`
    const original = index % 3 === 0 ? `日本語の合成例 ${index}` : `Synthetic sentence ${index}: picked it up.`
    const exact = index % 3 === 0 ? '日本語' : phrase.exact
    const start = original.indexOf(exact)
    const encounter: DictionaryEncounter = { id, createdAt: 2000 - index, source: { ...source, text: original, language: index % 3 === 0 ? '日本語' : 'English', provenance: index % 4 === 0 ? 'saved-favorite' : index % 4 === 1 ? 'user-input' : 'main-verified', captionId: index % 4 === 1 ? null : `caption-${id}`, span: { start, end: start + exact.length, exact } }, favorite: index < 3, note: `SECRET_NOTE_${id}`, explanations: [], attempts: [] }
    if (index === 31) encounter.note = ''
    records.set(id, encounter)
    if (index !== 31) encounter.explanations.push(explanation(id, index === 1, index === 2 ? 'ambiguous' : 'ok'))
    else encounter.attempts.push({ id: `${id}-attempt`, createdAt: 1, updatedAt: 2, dispatchState: 'may_have_started', status: 'service_error', explanationId: null })
  }
  reviews.splice(0); session = null; reveal = null; ratedTokens.clear(); eventPositions.clear(); undone.clear(); emit()
}
const availableHandle = (handle = 'synthetic-handle', snapshot = source): DictionaryHandleResult => ({ handle, reason: '', source: clone(snapshot) })
function complete(id: string, mode: 'ready' | 'unsaved' = 'ready', requestGeneration = currentRequest?.generation) {
  const request = currentRequest
  if (!request || request.id !== id || requestGeneration !== request.generation || !records.has(id)) { ignoredLate++; return }
  const item = records.get(id)!, result = explanation(id)
  if (mode === 'unsaved') runs.set(id, { encounterId: id, attemptId: request.attemptId, state: 'ready_unsaved', dispatchState: 'may_have_started', message: '有效结果仅在内存；退出应用会丢失。仅重试保存不会再次调用服务。', unsaved: result })
  else {
    item.explanations.push(result)
    Object.assign(item.attempts.at(-1)!, { status: 'ready', explanationId: result.explanationId, updatedAt: 3 })
    runs.set(id, { encounterId: id, attemptId: request.attemptId, state: 'ready', dispatchState: 'may_have_started', message: 'AI语境解释已保存' })
  }
  currentRequest = null; emit()
}
const api: DictionaryAPI = {
  availability: async () => ({ configured, providerLabel: 'Synthetic provider', model: 'synthetic-model', offlineDictionaryAvailable: false }),
  open: async input => { openRequests.push(clone(input)); const handle = `open-handle-${++nextId}`, snapshot = { ...source, captionId: input.captionId, text: input.displayedText }; openHandles.push(handle); handles.set(handle, snapshot); return { handle, reason: '', source: snapshot } },
  openEncounter: async id => {
    const item = records.get(id)
    if (!item) return { handle: null, reason: '条目不存在', source: null }
    const handle = `history-handle-${id}`; const { span: _span, ...snapshot } = item.source
    handles.set(handle, snapshot); return { handle, reason: '', source: clone(snapshot) }
  },
  release: async handle => { releasedHandles.push(handle); handles.delete(handle) },
  explain: async input => {
    if (!configured) throw new Error('尚未配置翻译服务')
    if (currentRequest) throw new Error('已有解释正在等待')
    const snapshot = handles.get(input.handle)
    if (!snapshot) throw new Error('快照已失效，请重新选择句子')
    if (snapshot.text.slice(input.span.start, input.span.end) !== input.span.exact) throw new Error('合成源文范围未对齐')
    providerCalls++; inputRequests.push(clone(input))
    const id = input.encounterId || `request-${++nextId}`
    let item = records.get(id)
    if (!item) { item = { id, createdAt: 3000 + nextId, source: { ...clone(snapshot), span: clone(input.span) }, favorite: false, note: '', explanations: [], attempts: [] }; records.set(id, item) }
    const attemptId = `${id}-attempt-${item.attempts.length + 1}`
    item.attempts.push({ id: attemptId, createdAt: 3000, updatedAt: 3001, dispatchState: 'may_have_started', status: 'waiting', explanationId: null })
    const result: DictionaryRunState = { encounterId: id, attemptId, state: 'waiting', dispatchState: 'may_have_started', message: '已请求以中文解释；请求可能已发出并产生费用，无法确定。' }
    runs.set(id, result); currentRequest = { id, attemptId, generation: ++generation }; emit(); return clone(result)
  },
  cancel: async (id, attemptId) => {
    cancelCalls++; const result: DictionaryRunState = { encounterId: id, attemptId, state: 'cancelled', dispatchState: 'may_have_started', message: '已停止等待；请求可能已发出并产生费用，无法确定。' }
    if (currentRequest?.id === id) { currentRequest = null; generation++ }
    runs.set(id, result); const item = records.get(id); if (item?.attempts.at(-1)) item.attempts.at(-1)!.status = 'cancelled'; emit(); return clone(result)
  },
  retrySave: async (id, attemptId) => {
    retrySaveCalls++; const existing = runs.get(id)
    if (existing?.state !== 'ready_unsaved' || !existing.unsaved) throw new Error('没有待保存的结果')
    records.get(id)!.explanations.push(existing.unsaved)
    const result: DictionaryRunState = { encounterId: id, attemptId, state: 'ready', dispatchState: 'may_have_started', message: '结果已保存，没有再次调用服务。' }
    runs.set(id, result); emit(); return clone(result)
  },
  discardUnsaved: async (id, attemptId) => { runs.set(id, { encounterId: id, attemptId, state: 'cancelled', dispatchState: 'may_have_started', message: '已放弃未保存结果' }); emit() },
  list: async (query: DictionaryQuery) => {
    const words = (query.query || '').toLocaleLowerCase()
    const items = [...records.values()].filter(item => (!query.language || item.source.language === query.language) && (!query.provenance || item.source.provenance === query.provenance) && (query.favorite === undefined || item.favorite === query.favorite) && (query.incomplete === undefined || ((!item.explanations.length && !item.favorite && !item.note.trim()) === query.incomplete)) && (!words || [item.source.text, item.source.span.exact, item.note, ...item.explanations.map(value => value.providerKind === 'offline-dictionary' ? value.sense.glosses.join(' ') : value.content.contextMeaning || '')].some(value => value.toLocaleLowerCase().includes(words))))
    const pageSize = query.pageSize || 20, page = Math.min(Math.max(1, query.page || 1), Math.max(1, Math.ceil(items.length / pageSize)))
    return clone({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, revision, warning: '' })
  },
  get: async id => records.has(id) ? clone({ encounter: records.get(id)!, run: runs.get(id) || null }) : null,
  edit: async (id, input) => {
    if (failEdit) { failEdit = false; throw new Error('合成写入失败；笔记未保存') }
    const item = records.get(id); if (!item) throw new Error('条目不存在')
    if (input.favorite !== undefined) { favoriteWrites++; item.favorite = input.favorite }
    if (input.note !== undefined) { noteWrites++; item.note = input.note }
    emit()
  },
  remove: async id => { deleteCalls++; records.delete(id); runs.delete(id); for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].encounterId === id) reviews.splice(i, 1); if (currentRequest?.id === id) { currentRequest = null; generation++ }; emit() },
  export: async _format => { exportCalls++; exportSnapshot = clone([...records.values()].filter(item => item.explanations.length)); return { saved: true, message: '合成导出已完成' } },
  startReview: async () => {
    session = { sessionId: `session-${++nextId}`, cards: [...records.values()].filter(item => item.favorite && item.explanations.some(usableDictionaryExplanation)).map(item => ({ encounterId: item.id, explanationId: item.explanations.filter(usableDictionaryExplanation).at(-1)!.explanationId, source: clone(item.source) })), cursor: 0, completed: 0, lastEventId: null }; reveal = null; return clone(session)
  },
  reviewState: async sessionId => { if (!session || session.sessionId !== sessionId) throw new Error('复习会话已变化'); return clone(session) },
  endReview: async sessionId => { if (session?.sessionId === sessionId) { session = null; reveal = null } },
  reveal: async (sessionId, encounterId, explanationId) => {
    if (!session || session.sessionId !== sessionId || session.cards[session.cursor]?.encounterId !== encounterId) throw new Error('复习会话已变化')
    revealCalls++; reveal = { id: `reveal-${++nextId}`, encounterId, explanationId, cursor: session.cursor }
    return { revealId: reveal.id, explanation: clone(records.get(encounterId)!.explanations.find(item => item.explanationId === explanationId)!) }
  },
  rate: async (sessionId, revealId, response) => {
    if (!session || sessionId !== session.sessionId) throw new Error('复习会话已变化')
    if (ratedTokens.has(revealId)) return clone(session)
    if (!reveal || reveal.id !== revealId) throw new Error('请先揭示已保存解释')
    if (failRating) { failRating = false; throw new Error('合成复习写入失败；未记录自评') }
    const event: DictionaryReviewEvent = { id: `review-${++nextId}`, sessionId, encounterId: reveal.encounterId, explanationId: reveal.explanationId, createdAt: 5000, response }
    reviews.push(event); ratedTokens.set(revealId, event.id); eventPositions.set(event.id, reveal.cursor)
    session.completed++; session.cursor++; session.lastEventId = event.id; reveal = null; emit(); return clone(session)
  },
  skip: async sessionId => { if (!session || sessionId !== session.sessionId) throw new Error('复习会话已变化'); session.cursor++; reveal = null; return clone(session) },
  undo: async (sessionId, eventId) => {
    if (!session || sessionId !== session.sessionId) throw new Error('复习会话已变化')
    if (undone.has(eventId)) return clone(session)
    const item = reviews.find(item => item.id === eventId && item.sessionId === sessionId)
    if (!item || session.lastEventId !== eventId) throw new Error('只能撤销本次复习最近的自评')
    reviews.splice(reviews.indexOf(item), 1); undone.add(eventId); session.completed--; session.cursor = eventPositions.get(eventId)!; session.lastEventId = [...reviews].reverse().find(item => item.sessionId === sessionId)?.id || null; reveal = null; emit(); return clone(session)
  },
  onChanged: callback => { listeners.add(callback); return () => listeners.delete(callback) },
}

// Renderer fixtures only: these are deliberately synthetic entries, not the real
// Kaikki extraction samples exercised by the separate pack/engine tests.
const offlineWords = [['en', 'cats'], ['ja', '猫'], ['ko', '고양이'], ['fr', 'chat'], ['de', 'Katze'], ['es', 'gato'], ['ru', 'кошка'], ['zh', '猫']] as const
const offlinePacks = new Map<string, OfflinePackInfo>()
let offlineQueries = 0, offlineSaves = 0, cancelInstall = false
let largeEntryFixture = false
let sourceReadingFixture = false
// Self-authored renderer strings only: source-field semantics are tested against
// real raw/projection/builder records separately, without claiming these are data.
const sourceReadingFixtures = {
  ko: ['[kʰojaŋi]', '来源韩文记音（hangeul；标签：["phonetic"]；原标签：["合成地区"]）：고양이'],
  zh: [
    '来源中文记音（zh_pron；标签：["Min-Nan"]；原标签：["菲律賓"]）：--le',
    '来源中文记音（zh_pron；标签：["Min-Nan"]；原标签：["臺灣"]）：--le',
    '来源中文记音（zh_pron；原标签：["<img src=\\"https://invalid.test/reading\\">"]）：<script>synthetic reading</script>',
  ],
} as const
const offlineHits = (language: string, selected: string): OfflineHit[] => {
  const pack = offlinePacks.get(`synthetic-${language}`)
  if (!pack?.enabled || offlineWords.find(item => item[0] === language)?.[1] !== selected) return []
  const hit: OfflineHit = { pack: clone(pack.manifest), entry: { id: `entry-${language}`, headword: language === 'en' ? 'cat' : selected, language, readings: language === 'ja' ? ['ねこ'] : [], partOfSpeech: 'noun', forms: language === 'en' ? [{ form: 'cats', tags: ['plural'] }] : [], senses: [
    { id: 'sense-1', glosses: [`SYNTHETIC_OFFLINE_MEANING_${language} <img src="https://invalid.test/offline">`], tags: [], examples: [] },
    { id: 'sense-2', glosses: [`SYNTHETIC_SECOND_SENSE_${language}`], tags: ['figurative'], examples: [] },
  ] }, matchPath: language === 'en' ? 'form' : 'exact', matchedText: selected }
  if (sourceReadingFixture && (language === 'ko' || language === 'zh')) hit.entry.readings = [...sourceReadingFixtures[language]]
  if (largeEntryFixture && language === 'en') hit.entry.senses = Array.from({ length: 225 }, (_, index) => ({ id: `large-sense-${index + 1}`, glosses: [`SYNTHETIC_LARGE_SENSE_${String(index + 1).padStart(3, '0')}`], tags: [], examples: [] }))
  return [hit]
}
const resetOfflinePacks = () => {
  offlinePacks.clear()
  for (const [language] of offlineWords) offlinePacks.set(`synthetic-${language}`, { enabled: true, manifest: {
    schemaVersion: 1, packId: `synthetic-${language}`, version: '1', sourceLanguage: language, glossLanguage: 'en', sourceName: `Synthetic ${language} source`, sourceUrl: 'https://invalid.test/synthetic-source', sourceRevision: 'synthetic-1', license: 'CC0 synthetic fixture', licenseUrl: 'https://invalid.test/synthetic-license', attribution: 'Synthetic UI data only', dbSha256: 'a'.repeat(64), counts: { entries: 1, senses: 2, forms: language === 'en' ? 1 : 0 },
  } })
}
resetOfflinePacks()
api.openInput = async input => {
  const handle = `user-input-${++nextId}`, snapshot: DictionarySnapshot = { text: input.text, language: input.language, sourceType: 'text', provenance: 'user-input', captionId: null, sourceVersion: null, displayedVersion: null }
  handles.set(handle, clone(snapshot)); return availableHandle(handle, snapshot)
}
api.offlineLookup = async input => {
  offlineQueries++
  if (!handles.has(input.handle)) throw new Error('离线源文句柄已失效')
  return { query: input.span.exact, language: input.language, requestedGlossLanguage: input.glossLanguage || 'zh', results: offlineHits(input.language, input.span.exact), message: '' }
}
api.saveOffline = async input => {
  const snapshot = handles.get(input.handle), hit = offlineHits(input.language, input.span.exact).find(hit => hit.pack.packId === input.packId && hit.entry.id === input.entryId), sense = hit?.entry.senses.find(sense => sense.id === input.senseId)
  if (!snapshot || !hit || !sense || hit.pack.version !== input.packVersion || hit.pack.dbSha256 !== input.packSha256) throw new Error('所选离线义项已变化，请重新查询')
  offlineSaves++
  const id = `offline-encounter-${++nextId}`, { senses: _senses, ...entry } = hit.entry
  const record: DictionaryEncounter = { id, createdAt: Date.now(), source: { ...clone(snapshot), span: clone(input.span) }, favorite: true, note: '', attempts: [], explanations: [{ schemaVersion: 1, encounterId: id, explanationId: `offline-explanation-${nextId}`, version: 1, providerKind: 'offline-dictionary', providerLabel: hit.pack.sourceName, createdAt: Date.now(), pack: clone(hit.pack), entry: clone(entry), sense: clone(sense), matchPath: hit.matchPath, matchedText: hit.matchedText }] }
  records.set(id, record); emit(); return clone(record)
}
api.packs = {
  list: async () => clone([...offlinePacks.values()]),
  install: async () => {
    if (cancelInstall) { cancelInstall = false; return { installed: false, pack: null } }
    const pack = clone(offlinePacks.get('synthetic-en')!); pack.manifest.version = '2'; pack.manifest.sourceRevision = 'synthetic-2'; offlinePacks.set(pack.manifest.packId, pack); emit(); return { installed: true, pack: clone(pack) }
  },
  setEnabled: async (id, enabled) => { const pack = offlinePacks.get(id); if (!pack) throw new Error('语言包不存在'); pack.enabled = enabled; emit() },
  uninstall: async id => { offlinePacks.delete(id); emit() },
}

const root = createRoot(document.getElementById('root')!)
let mode: 'phrase' | 'history' | 'app' | 'none' = 'none'
function mountPhrase(options: { configured?: boolean; handlePromise?: Promise<DictionaryHandleResult> | null; sourceText?: string; phrases?: Phrase[] } = {}) {
  configured = options.configured ?? true; mode = 'phrase'
  const handle = `phrase-handle-${++mountId}`
  const snapshot = { ...source, text: options.sourceText ?? text }
  handles.set(handle, snapshot)
  root.render(<main className="app-shell"><section className="panel panel-study" data-fixture-mount={mountId}><PhraseExplanation key={mountId} api={api} handlePromise={options.handlePromise === undefined ? Promise.resolve(availableHandle(handle, snapshot)) : options.handlePromise} source={snapshot.text} phrases={options.phrases || [phrase]} defaultLanguage="zh" onOpenHistory={mountHistory} /></section></main>)
}
function mountHistory() {
  mode = 'history'; mountId++
  root.render(<main className="app-shell"><section className="panel panel-dictionary" data-fixture-mount={mountId}><DictionaryPanel key={mountId} api={api} defaultLanguage="zh" onClose={() => { closeCalls++; mode = 'none'; root.render(<p>Closed synthetic panel</p>) }} /></section></main>)
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const query = <T extends HTMLElement = HTMLElement>(selector: string): T => { const item = document.querySelector<T>(selector); if (!item) throw new Error(`Missing dictionary fixture element: ${selector}`); return item }
const button = (name: string) => { const item = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name); if (!item) throw new Error(`Missing dictionary fixture button: ${name}`); return item }
const setValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
const wait = async (test: () => boolean, message: string) => { for (let i = 0; i < 120; i++) { if (test()) return; await frame() }; throw new Error(message) }
const getText = () => document.getElementById('root')!.textContent || ''
const openRow = async (id: string) => { query<HTMLButtonElement>(`[data-encounter-id="${id}"] .dictionary-open`).click(); await wait(() => Boolean(document.querySelector('.dictionary-detail')), 'dictionary detail did not open') }
function diagnostics() { return { providerCalls, inputRequests: clone(inputRequests), cancelCalls, retrySaveCalls, exportCalls, noteWrites, favoriteWrites, deleteCalls, closeCalls, revealCalls, ignoredLate, openRequests: clone(openRequests), openHandles: [...openHandles], releasedHandles: [...releasedHandles], reviewEvents: clone(reviews), forbiddenNetwork, forbiddenMedia, mode } }

// Filled out against the production DOM in this same branch; no mock screen is substituted.
async function run() {
  const checks: string[] = []
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message) }
  seed(); configured = true; providerCalls = 0; cancelCalls = 0; retrySaveCalls = 0; exportCalls = 0; noteWrites = 0; favoriteWrites = 0; deleteCalls = 0; closeCalls = 0; revealCalls = 0; ignoredLate = 0; inputRequests.splice(0)
  mountPhrase(); await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-request:not(:disabled)`)), 'configured phrase preview did not become ready')
  check(getText().includes(text) && getText().includes(phrase.exact) && getText().includes('Synthetic provider') && getText().includes('synthetic-model'), 'request preview contains only the frozen sentence, selected phrase and configured provider/model')
  check(providerCalls === 0, 'opening a frozen phrase does not call its provider')
  const explain = button('解释这处用法（调用服务）'); explain.click(); explain.click(); await wait(() => Boolean(currentRequest) && Boolean(document.querySelector('.dictionary-run')), 'explanation did not enter waiting')
  check(providerCalls === 1 && inputRequests.length === 1 && inputRequests[0].language === 'zh', 'one explicit click dispatches one requested language and repeated click is locked')
  const first = currentRequest!; button('停止等待').click(); await frame(); complete(first.id, 'ready', first.generation); await frame()
  check(cancelCalls === 1 && ignoredLate === 1 && !records.get(first.id)!.explanations.length, 'cancelled late response never becomes success')
  check(getText().includes('可能') && !getText().includes('已退款') && !getText().includes('确定未计费'), 'stop-waiting feedback keeps billing uncertainty')
  mountPhrase(); await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-request:not(:disabled)`)), 'new phrase view was not ready'); button('解释这处用法（调用服务）').click(); await wait(() => Boolean(currentRequest), 'second request did not start')
  const second = currentRequest!; complete(second.id, 'unsaved'); await wait(() => Boolean(document.querySelector('.dictionary-unsaved')), 'ReadyUnsaved was not displayed')
  check(Boolean(document.querySelector('.dictionary-explanation')) && getText().includes('内存'), 'ReadyUnsaved shows the valid result with its persistence-loss warning')
  const beforeRetry = providerCalls; button('仅重试保存').click(); await wait(() => !document.querySelector('.dictionary-unsaved') && records.get(second.id)!.explanations.length === 1, 'retry-save did not finish')
  check(retrySaveCalls === 1 && providerCalls === beforeRetry && records.get(second.id)!.explanations.length === 1, 'retry-save persists a ready result without a provider request')
  check(!document.querySelector('img,a,iframe,script[src*="invalid.test"]') && getText().includes('<img'), 'model HTML and URL strings stay inert plain text')
  check(getText().includes('原形') && getText().includes('未') && getText().includes('AI'), 'headword and reading provenance stay explicitly AI/unverified')
  mountPhrase(); await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-request:not(:disabled)`)), 'third phrase view was not ready')
  button('解释这处用法（调用服务）').click(); await wait(() => Boolean(currentRequest), 'third request did not start')
  const previousDetail = currentRequest!
  mountPhrase({ sourceText: 'Another synthetic sentence.', phrases: [{ start: 0, end: 7, exact: 'Another' }] })
  await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-request:not(:disabled)`)), 'replacement phrase view was not ready')
  complete(previousDetail.id); await frame(); await frame()
  check(!document.querySelector('.dictionary-explanation') && records.get(previousDetail.id)!.explanations.length === 1, 'an old detail response is saved only to its own encounter without entering the new view')
  const beforeNoConfig = providerCalls
  mountPhrase({ configured: false }); await wait(() => getText().includes('尚未配置可用翻译服务'), 'missing configuration warning was not shown')
  check(button('解释这处用法（调用服务）').disabled && providerCalls === beforeNoConfig, 'missing service configuration disables explanation without a request')
  configured = true; mountHistory(); await wait(() => Boolean(document.querySelector('.dictionary-history [data-encounter-id]')), 'history did not mount'); await frame()
  const historyBaseline = providerCalls
  check(document.querySelectorAll('[data-encounter-id]').length <= 20 && document.querySelectorAll('[data-encounter-id]').length > 0, 'history uses a bounded local page')
  const next = button('下一页'); next.click(); await wait(() => Boolean(document.querySelector('[data-encounter-id="seed-25"]')), 'next history page did not load'); check(document.querySelector('[data-encounter-id="seed-25"]'), 'history paging exposes later independent encounters')
  const visibleIds = () => [...document.querySelectorAll<HTMLElement>('.dictionary-history [data-encounter-id]')].map(item => item.dataset.encounterId!)
  query<HTMLInputElement>('[aria-label="只看收藏"]').click()
  await wait(() => visibleIds().length > 0 && visibleIds().every(id => records.get(id)!.favorite), 'favorite filter did not settle')
  check(visibleIds().every(id => records.get(id)!.favorite), 'history favorite filter is local and excludes unstarred encounters')
  query<HTMLInputElement>('[aria-label="只看收藏"]').click()
  setValue(query<HTMLSelectElement>('[aria-label="筛选来源"]'), 'user-input')
  await wait(() => visibleIds().length > 0 && visibleIds().every(id => records.get(id)!.source.provenance === 'user-input'), 'source filter did not settle')
  check(visibleIds().every(id => records.get(id)!.source.provenance === 'user-input'), 'history provenance filter keeps user input distinct from verified captions')
  setValue(query<HTMLSelectElement>('[aria-label="筛选来源"]'), '')
  setValue(query<HTMLInputElement>('[aria-label="筛选原文语言"]'), '日本語')
  await wait(() => visibleIds().length > 0 && visibleIds().every(id => records.get(id)!.source.language === '日本語'), 'language filter did not settle')
  check(visibleIds().every(id => records.get(id)!.source.language === '日本語'), 'free-form source language filter does not assume BCP47')
  setValue(query<HTMLInputElement>('[aria-label="筛选原文语言"]'), '')
  query<HTMLInputElement>('[aria-label="显示未完成"]').click()
  await wait(() => visibleIds().length > 0 && visibleIds().every(id => !records.get(id)!.explanations.length), 'unfinished filter did not settle')
  check(visibleIds().every(id => !records.get(id)!.explanations.length), 'unfinished intents remain explicitly discoverable rather than silently evicted')
  query<HTMLInputElement>('[aria-label="显示未完成"]').click()
  setValue(query<HTMLInputElement>('.dictionary-query'), 'SECRET_NOTE_seed-01')
  await wait(() => document.querySelectorAll('[data-encounter-id]').length === 1 && Boolean(document.querySelector('[data-encounter-id="seed-01"]')), 'note search did not settle')

  check(document.querySelectorAll('[data-encounter-id]').length === 1, 'history lookup includes local notes')
  await openRow('seed-01')
  check(getText().includes('SYNTHETIC_MEANING_seed-01') && !getText().includes('undefined') && !getText().includes('[object Object]'), 'nullable structured fields render without invented values')
  check(getText().includes('用户输入') && records.get('seed-01')!.source.provenance === 'user-input', 'reopening an input encounter does not upgrade its provenance')
  const priorNote = records.get('seed-01')!.note
  setValue(query<HTMLTextAreaElement>('[aria-label="查词笔记"]'), 'Edited synthetic note'); await frame()
  failEdit = true; button('保存查词笔记').click()
  await wait(() => getText().includes('合成写入失败') && !button('保存查词笔记').disabled, 'note write failure was not shown')
  check(records.get('seed-01')!.note === priorNote && query<HTMLTextAreaElement>('[aria-label="查词笔记"]').value === 'Edited synthetic note', 'failed note save preserves the prior commit and edited draft')
  query('[aria-label="查词笔记"]').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame()
  check(Boolean(document.querySelector('.dictionary-detail')) && !document.querySelector('.dictionary-confirm'), 'IME Escape does not close or discard an edited learning note')
  query('[aria-label="查词笔记"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  button('返回学习历史').click(); await frame()
  check(Boolean(document.querySelector('.dictionary-confirm')), 'leaving an edited independent note requires an explicit discard decision')
  button('继续编辑').click(); await frame(); button('保存查词笔记').click()
  await wait(() => records.get('seed-01')!.note === 'Edited synthetic note' && button('保存查词笔记').disabled, 'note save did not commit')

  check(records.get('seed-01')!.note === 'Edited synthetic note', 'notes save in the independent learning library')
  button('收藏学习条目').click(); await frame(); check(records.get('seed-01')!.favorite === false, 'favorite status is independent from lookup and source caption favorites')
  button('返回学习历史').click(); await frame()
  setValue(query<HTMLInputElement>('.dictionary-query'), ''); await frame(); await frame()
  button('导出词典 JSON').click(); await frame(); button('导出学习 Markdown').click(); await frame()
  check(exportCalls >= 2 && exportSnapshot.every(item => item.explanations.length > 0), 'explicit JSON/Markdown export uses only committed structured versions')
  setValue(query<HTMLInputElement>('.dictionary-query'), 'SECRET_NOTE_seed-30')
  await wait(() => Boolean(document.querySelector('[data-encounter-id="seed-30"]')), 'deletion target did not appear')
  await openRow('seed-30'); button('删除学习条目').click(); await frame()
  check(Boolean(document.querySelector('.dictionary-confirm')), 'learning deletion requires an explicit confirmation distinct from source favorites')
  button('确定删除学习条目').click(); await wait(() => !records.has('seed-30') && Boolean(document.querySelector('.dictionary-history')), 'learning deletion did not complete')
  setValue(query<HTMLInputElement>('.dictionary-query'), ''); await frame(); await frame()
  button('导出词典 JSON').click(); await frame()
  check(!exportSnapshot.some(item => item.id === 'seed-30'), 'successfully deleted learning items are absent from subsequent exports')
  check(providerCalls === historyBaseline, 'paging/search/notes/favorites/view/export add no provider request')
  // Review starts a separate view: answer-bearing history/detail DOM must be removed.
  records.get('seed-01')!.favorite = true; emit(); await frame()
  button('复习收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-review')), 'review did not start')
  const current = session!.cards[session!.cursor], answer = (records.get(current.encounterId)!.explanations.find(item => item.explanationId === current.explanationId)! as GeneratedDictionaryExplanation).content.contextMeaning!
  check(!document.querySelector('.dictionary-history,.dictionary-detail,.dictionary-explanation') && !getText().includes(answer) && !getText().includes(records.get(current.encounterId)!.note), 'before reveal, answer and note are absent from review DOM rather than visually hidden')
  check(reviews.length === 0, 'entering review and viewing a prompt are not review events')
  button('揭示已保存解释').click(); await frame(); check(getText().includes(answer) && reviews.length === 0, 'reveal shows its saved version without counting a self-review')
  failRating = true; button('记起了').click(); await frame(); check(reviews.length === 0 && session!.cursor === 0, 'rating write failure neither advances nor increments review count')
  const rate = button('记起了'); rate.click(); rate.click(); await frame()
  check(reviews.length === 1 && session!.completed === 1, 'self-rating is idempotent under a double click')
  const beforeSkip = reviews.length; button('跳过').click(); await frame(); check(reviews.length === beforeSkip, 'skipping never produces a review event')
  const undo = button('撤销本次自评'); undo.click(); undo.click(); await frame()
  check(reviews.length === 0 && session!.completed === 0, 'undo is idempotent and removes only the latest actual rating in this session')
  check(providerCalls === historyBaseline && forbiddenNetwork === 0 && forbiddenMedia === 0, 'all history/review behavior is offline and opens no media')
  checks.push(...await offlineRendererChecks())
  return { checks, failures: [] as string[] }
}

async function offlineRendererChecks() {
  const checks: string[] = []
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message) }
  configured = false; records.clear(); runs.clear(); resetOfflinePacks(); offlineQueries = 0; offlineSaves = 0
  const callsBefore = providerCalls
  for (const [language, word] of offlineWords) {
    mountHistory(); await wait(() => Boolean(document.querySelector('.dictionary-history')), 'offline history did not mount')
    button('离线查词').click(); await wait(() => Boolean(document.querySelector('[aria-label="离线查词原句"]')), 'offline input did not open')
    const original = `Before ${word} after.`
    setValue(query<HTMLTextAreaElement>('[aria-label="离线查词原句"]'), original)
    setValue(query<HTMLInputElement>('[aria-label="离线输入原文语言"]'), language)
    await frame(); button('开始离线查词').click()
    await wait(() => Boolean(document.querySelector('[aria-label="离线短语起点"]')), 'offline frozen input did not mount')
    setValue(query<HTMLInputElement>('[aria-label="离线短语起点"]'), '7'); setValue(query<HTMLInputElement>('[aria-label="离线短语终点"]'), String(7 + word.length)); await frame(); button('采用此范围').click()
    await wait(() => !button('查询本机词典').disabled, 'offline selection not ready')
    button('查询本机词典').click(); await wait(() => Boolean(document.querySelector('.dictionary-offline-hit')), `no offline result for ${language}`)
    check(getText().includes(`SYNTHETIC_OFFLINE_MEANING_${language}`) && document.querySelectorAll('.dictionary-offline-sense').length === 2, `${language}: real offline renderer shows each selected source sense independently`)
    check(getText().includes('暂无中文释义') && !document.querySelector('img,a[href*="invalid.test"]'), `${language}: non-Chinese glosses have explicit fallback and source text never creates remote resources`)
    const savesBefore = offlineSaves, save = query<HTMLButtonElement>('.dictionary-offline-sense button'); save.click(); save.click()
    await wait(() => offlineSaves === savesBefore + 1 && save.disabled, 'offline sense save did not settle')
    check(offlineSaves === savesBefore + 1 && [...records.values()].at(-1)?.source.span.exact === word, `${language}: duplicate save is locked and the selected phrase/context is preserved`)
  }
  check(providerCalls === callsBefore && offlineQueries === 8 && offlineSaves === 8, 'eight-language offline input/query/save works without configured AI or any provider request')
  const english = [...records.values()].find(item => item.source.language === 'en')!, saved = clone(english.explanations[0])
  mountHistory(); await wait(() => Boolean(document.querySelector('.dictionary-history')), 'pack history did not mount')
  const packsButton = button('管理语言包'); packsButton.focus(); packsButton.click(); await wait(() => Boolean(document.querySelector('.dictionary-packs')), 'pack panel did not mount')
  check(document.activeElement?.classList.contains('dictionary-packs-heading') && document.querySelectorAll('[data-pack-id]').length === 8, 'package management enters its heading and lists eight actual installed fixture packages')
  cancelInstall = true; button('导入语言包').click(); await wait(() => getText().includes('导入已取消'), 'cancelled import feedback missing')
  check(offlinePacks.get('synthetic-en')!.manifest.version === '1', 'cancelled native package selection changes nothing')
  button('导入语言包').click(); await wait(() => getText().includes('synthetic-2'), 'package update did not appear')
  const enabled = query<HTMLInputElement>('[aria-label="启用语言包 synthetic-en"]'); enabled.click(); await wait(() => !enabled.checked && !enabled.disabled, 'pack disable did not finish')
  check(!offlinePacks.get('synthetic-en')!.enabled, 'package enable state is controlled by the saved package list')
  button('卸载语言包 synthetic-en').click(); await wait(() => !document.querySelector('[data-pack-id="synthetic-en"]'), 'pack removal did not finish')
  check(JSON.stringify(records.get(english.id)!.explanations[0]) === JSON.stringify(saved), 'pack update/disable/removal leaves the old learning snapshot unchanged')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(() => Boolean(document.querySelector('.dictionary-history')), 'Escape did not return from packages')
  check(document.activeElement?.textContent === '管理语言包', 'returning from package management restores its internal invoker')
  button('复习收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-review')), 'offline review did not open')
  check(!document.querySelector('.dictionary-offline-explanation') && !getText().includes('SYNTHETIC_OFFLINE_MEANING'), 'offline answers are absent from review DOM before reveal')
  button('揭示已保存解释').click(); await wait(() => Boolean(document.querySelector('.dictionary-offline-explanation')), 'offline answer not revealed')
  check(getText().includes('SYNTHETIC_OFFLINE_MEANING') && !getText().includes('AI生成，可能不准确'), 'review reveals the saved offline dictionary sense with its own source instead of an AI label')
  check(providerCalls === callsBefore && forbiddenNetwork === 0 && forbiddenMedia === 0, 'offline package/history/review renderer path has zero external requests and media access')
  return checks
}
async function appIntegration() {
  const checks: string[] = []
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message) }
  seed(); configured = true
  const previous = window.lingo, baseRequests = providerCalls
  const sourceCaption: Caption = { id: 'app-integration-source', source: 'text', original: text, language: 'English', zh: '合成译文', en: '', ja: '拾って', reading: '', translations: { zh: '合成译文', ja: '拾って' }, jaSegments: [{ text: '拾', reading: 'ひろ' }, { text: 'って' }], targetLanguages: ['zh', 'ja'], createdAt: 1, saved: false, status: 'ready' }
  const settings: Settings = { targetLanguages: ['zh', 'ja'], showOriginal: true, showFurigana: true, captureMode: 'system', microphoneDeviceId: 'default', alwaysOnTop: true, opacity: .94, fontSize: 16, launchAtLogin: false, asrModel: 'synthetic-asr', asrEndpoint: 'wss://invalid.test/asr', translationBaseUrl: 'https://invalid.test/translation', translationModel: 'synthetic-model', hasAsrKey: false, hasTranslationKey: false }
  let snapshot: Snapshot = { settings, state: 'idle', message: '', captions: [sourceCaption], partial: {}, collapsed: false, learning: { sessions: [], records: [], currentSessionId: null, warning: '', shortcutAvailable: true } }
  const subscriptions = new Set<(snapshot: Snapshot) => void>()
  const counters = { audio: 0, hide: 0, text: 0, key: 0, oldSave: 0 }
  const appEmit = (change: Partial<Snapshot>) => { snapshot = clone({ ...snapshot, ...change }); for (const callback of subscriptions) callback(snapshot) }
  const mock: LingoAPI = {
    platform: 'win32', dictionary: api,
    learning: { pin: async () => ({ kind: 'saved', message: '合成收藏' }), save: async () => { counters.oldSave++; return { kind: 'saved', message: '合成字幕收藏' } }, session: async () => {}, removeNotes: async () => {}, onQuickPin: () => () => {} },
    getSnapshot: async () => snapshot, onSnapshot: callback => { subscriptions.add(callback); return () => { subscriptions.delete(callback) } }, onMicrophone: () => () => {},
    saveSettings: async input => { appEmit({ settings: { ...snapshot.settings, ...input } }); return snapshot.settings },
    start: async () => { counters.audio++; throw new Error('Real audio is forbidden') }, stop: async () => {}, pushMicrophone: () => { counters.audio++; throw new Error('PCM is forbidden') }, microphoneFailed: () => {}, microphoneReady: () => {},
    translateText: async () => { counters.text++; throw new Error('Legacy translation is forbidden in this integration fixture') }, retry: async () => {}, retryAnnotation: async () => {}, toggleSaved: async () => { counters.oldSave++ }, exportSaved: async () => false,
    copyText: async () => {}, importLocalKey: async () => { counters.key++; throw new Error('Credential access is forbidden') }, setCollapsed: async collapsed => { appEmit({ collapsed }) }, setCompactHeight: async () => {}, hide: async () => { counters.hide++ }, quit: async () => {},
  }
  window.lingo = mock; mode = 'app'; mountId++
  root.render(<App key={mountId} />)
  try {
    await wait(() => Boolean(document.querySelector('[data-caption-id="app-integration-source"] [aria-label="查看句子与笔记"]')), 'actual App caption did not mount')
    const beforeOpen = openRequests.length
    const origin = query<HTMLButtonElement>('[data-caption-id="app-integration-source"] [aria-label="查看句子与笔记"]'); origin.focus(); origin.click()
    check(openRequests.length === beforeOpen + 1 && openRequests.at(-1)!.displayedText === text, 'App registers the frozen aligned source in the same explicit detail-opening event')
    const firstHandle = openHandles.at(-1)!
    await wait(() => Boolean(document.querySelector('.study-detail .dictionary-phrase-tool')), 'StudyPanel did not expose explicit phrase explanation')
    check(providerCalls === baseRequests && counters.oldSave === 0, 'opening actual StudyPanel registers source without provider requests or old-favorite writes')
    setValue(query<HTMLInputElement>('[aria-label="短语起点"]'), String(phrase.start)); setValue(query<HTMLInputElement>('[aria-label="短语终点"]'), String(phrase.end)); button('加入范围').click()
    await wait(() => Boolean(document.querySelector('.dictionary-request:not(:disabled)')), 'App phrase selection did not become callable')
    const call = button('解释这处用法（调用服务）'); call.focus(); call.click()
    await wait(() => Boolean(currentRequest) && Boolean(document.querySelector('.dictionary-run')), 'actual StudyPanel did not start the explicit request')
    const request = currentRequest!, internalFocus = document.activeElement
    const revised = { ...sourceCaption, original: 'A revised synthetic source.', translatedOriginal: 'A revised synthetic source.', translations: { zh: '更新后的合成译文', ja: '変更' }, ja: '変更', jaSegments: [{ text: '変更', reading: 'へんこう' }] }
    appEmit({ captions: [revised, ...Array.from({ length: 20 }, (_, index) => ({ ...sourceCaption, id: `app-new-${index}`, original: `New synthetic paragraph ${index}` }))] }); await frame(); await frame()
    check(query('.study-source').textContent === text && query('.dictionary-request-preview .dictionary-source').textContent === text && handles.get(firstHandle)?.text === text, 'twenty new captions and same-ID source revision do not replace the registered source or frozen request preview')
    check(openRequests.length === beforeOpen + 1, 'background source/translation arrivals never silently re-register a new source')
    complete(request.id); await wait(() => Boolean(document.querySelector('.dictionary-explanation')), 'App explanation result did not appear')
    check(document.activeElement === internalFocus && counters.hide === 0, 'background explanation completion does not move focus or hide/activate an external window')
    check(counters.oldSave === 0 && records.get(request.id)!.source.text === text, 'explicit explanation saves independent encounter context without writing old subtitle favorites')
    button('关闭学习面板').click(); await frame(); button('放弃草稿并离开').click()
    await wait(() => !document.querySelector('.panel-study'), 'App did not close StudyPanel after explicit discard')
    await wait(() => releasedHandles.includes(firstHandle), 'closed StudyPanel did not release its handle')
    check(releasedHandles.includes(firstHandle), 'closing a detail releases exactly its owned source handle')
    const reopened = query<HTMLButtonElement>('[data-caption-id="app-integration-source"] [aria-label="查看句子与笔记"]'); reopened.focus(); reopened.click()
    const nextHandle = openHandles.at(-1)!
    await wait(() => Boolean(document.querySelector('.study-source')) && query('.study-source').textContent === revised.original, 'reopened detail did not use the current explicitly selected source')
    check(nextHandle !== firstHandle && handles.has(nextHandle) && openRequests.at(-1)!.displayedText === revised.original, 'reopening creates a distinct handle; cleanup of the old handle cannot release the new one')
    button('关闭学习面板').click(); await wait(() => !document.querySelector('.panel-study'), 'second App detail did not close')
    const history = button('学习历史'); history.focus(); history.click()
    await wait(() => Boolean(document.querySelector('.panel-dictionary .dictionary-history')), 'App history footer did not open the same-window dictionary panel')
    check(document.querySelectorAll('.panel').length === 1, 'learning history uses the existing application panel instead of a new window')
    button('关闭学习历史').click(); await wait(() => !document.querySelector('.panel-dictionary'), 'App dictionary panel did not close')
    check(document.activeElement === history, 'closing learning history restores its internal footer invoker')
    check(providerCalls === baseRequests + 1 && Object.values(counters).every(value => value === 0) && forbiddenNetwork === 0 && forbiddenMedia === 0, 'actual App learning flow makes only its one explicit mock explanation and no audio/key/legacy/network calls')
  } finally {
    root.render(<p>Finished synthetic App integration</p>); await frame(); window.lingo = previous; mode = 'none'
  }
  return { checks, failures: [] as string[] }
}

async function prepareReviewAx() {
  seed(); mountHistory(); await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-history [data-encounter-id]`)), 'history did not mount')
  button('复习收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-review')), 'review did not mount')
  const current = session!.cards[session!.cursor], item = records.get(current.encounterId)!
  return { forbidden: [item.note, ...item.explanations.flatMap(value => value.providerKind === 'offline-dictionary' ? [...value.sense.glosses, ...value.entry.readings, ...value.sense.examples.flatMap(example => [example.text, example.translation])].filter((value): value is string => Boolean(value)) : [value.content.contextMeaning, value.content.usageNote, value.content.partOfSpeech, value.content.reading?.text, ...(value.content.examples || []).flatMap(example => [example.text, example.translation])].filter((value): value is string => Boolean(value)))], source: item.source.text }
}
async function prepareOfflineReviewAx() {
  records.clear(); runs.clear(); resetOfflinePacks(); configured = false
  const text = 'Before cats after.', span = { start: 7, end: 11, exact: 'cats' }
  const opened = await api.openInput!({ text, language: 'en' }), hit = offlineHits('en', 'cats')[0]
  const record = await api.saveOffline!({ handle: opened.handle!, span, language: 'en', glossLanguage: 'zh', packId: hit.pack.packId, packVersion: hit.pack.version, packSha256: hit.pack.dbSha256, entryId: hit.entry.id, senseId: hit.entry.senses[0].id })
  mountHistory(); await wait(() => Boolean(document.querySelector('.dictionary-history [data-encounter-id]')), 'offline AX history did not mount')
  button('复习收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-review')), 'offline AX review did not mount')
  const saved = record.explanations[0]
  if (saved.providerKind !== 'offline-dictionary') throw new Error('Expected an offline AX snapshot')
  return { forbidden: [...saved.sense.glosses, ...saved.entry.readings], source: text }
}
async function prepareSourceReadingReviewAx(language: 'ko' | 'zh') {
  const checks: string[] = [], beforeCalls = providerCalls
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message) }
  records.clear(); runs.clear(); reviews.splice(0); resetOfflinePacks(); configured = false; sourceReadingFixture = true
  const selected = offlineWords.find(item => item[0] === language)![1], expected = [...sourceReadingFixtures[language]]
  const sentence = `Before ${selected} after.`, start = sentence.indexOf(selected)
  mountHistory(); await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-history`)), 'source-reading history did not mount')
  button('离线查词').click(); await wait(() => Boolean(document.querySelector('[aria-label="离线查词原句"]')), 'source-reading input did not open')
  setValue(query<HTMLTextAreaElement>('[aria-label="离线查词原句"]'), sentence)
  setValue(query<HTMLInputElement>('[aria-label="离线输入原文语言"]'), language); await frame(); button('开始离线查词').click()
  await wait(() => Boolean(document.querySelector('[aria-label="离线短语起点"]')), 'source-reading sentence did not freeze')
  setValue(query<HTMLInputElement>('[aria-label="离线短语起点"]'), String(start)); setValue(query<HTMLInputElement>('[aria-label="离线短语终点"]'), String(start + selected.length)); await frame(); button('采用此范围').click()
  await wait(() => !button('查询本机词典').disabled, 'source-reading lookup was not ready'); button('查询本机词典').click()
  await wait(() => Boolean(document.querySelector('.dictionary-offline-hit')), 'source-reading result did not mount')
  const hit = query('.dictionary-offline-hit')
  check(hit.textContent?.includes('来源读音记录（未校验）') && expected.every(reading => hit.textContent?.includes(reading)), `${language} source-reading lookup preserves source field, tags and original regional labels as unverified records`)
  check(!hit.querySelector('img,script,iframe,a'), `${language} source-reading labels and malicious-looking text stay inert without media or links`)
  query<HTMLButtonElement>('.dictionary-offline-sense button').click()
  await wait(() => records.size === 1 && Boolean(document.querySelector('.dictionary-offline-sense button:disabled')), 'source-reading sense did not save')
  const record = [...records.values()][0], saved = record.explanations[0]
  if (saved.providerKind !== 'offline-dictionary') throw new Error('Expected source-reading snapshot')
  check(JSON.stringify(saved.entry.readings) === JSON.stringify(expected), `${language} explicit save snapshots every distinct labelled reading without normalizing or merging it`)
  sourceReadingFixture = false
  button('查看学习历史中的收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-history [data-encounter-id]')), 'source-reading saved history did not open')
  await openRow(record.id)
  check(getText().includes('来源读音记录（未校验）') && expected.every(reading => getText().includes(reading)), `${language} saved history retains the reading snapshot after the lookup source changes`)
  check(!document.querySelector('.dictionary-offline-explanation img,.dictionary-offline-explanation script,.dictionary-offline-explanation iframe,.dictionary-offline-explanation a'), `${language} saved-reading detail renders no source-supplied HTML or external link`)
  button('返回学习历史').click(); await wait(() => Boolean(document.querySelector('.dictionary-history')), 'source-reading detail did not return')
  button('复习收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-review')), 'source-reading review did not mount')
  const forbidden = [...saved.sense.glosses, ...expected]
  check(!document.querySelector('.dictionary-explanation,.dictionary-history,.dictionary-detail') && forbidden.every(value => !getText().includes(value)), `${language} reading records and definitions are absent from the prereveal DOM`)
  check(reviews.length === 0 && session?.completed === 0 && providerCalls === beforeCalls && forbiddenNetwork === 0 && forbiddenMedia === 0, `${language} lookup/history/review neither grade a reading nor invoke a provider or media`)
  return { checks, forbidden, language }
}
async function finishSourceReadingReview(language: 'ko' | 'zh') {
  const checks: string[] = []
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message) }
  button('揭示已保存解释').click(); await wait(() => Boolean(document.querySelector('.dictionary-offline-explanation')), 'source-reading answer did not reveal')
  check(getText().includes('来源读音记录（未校验）') && sourceReadingFixtures[language].every(reading => getText().includes(reading)), `${language} reveal displays only the saved unverified source readings and their labels`)
  check(reviews.length === 0 && session?.completed === 0 && !document.querySelector('.dictionary-offline-explanation img,.dictionary-offline-explanation script,.dictionary-offline-explanation iframe,.dictionary-offline-explanation a'), `${language} revealing readings never auto-grades them or activates HTML`)
  button('跳过').click(); await wait(() => getText().includes('本次列表已结束'), 'source-reading review did not skip')
  check(reviews.length === 0 && session?.completed === 0 && forbiddenNetwork === 0 && forbiddenMedia === 0, `${language} skip remains a local non-rating action`)
  return { checks }
}
// A capacity regression with synthetic data, not evidence of language coverage.
async function prepareLargeEntryReviewAx() {
  const checks: string[] = [], beforeCalls = providerCalls
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message) }
  records.clear(); runs.clear(); resetOfflinePacks(); configured = false; largeEntryFixture = true
  const pack = offlinePacks.get('synthetic-en')!
  pack.manifest.schemaVersion = 2; pack.manifest.version = 'large-entry-1'; pack.manifest.counts.senses = 225
  pack.manifest.sourceName = 'Synthetic 225-sense capacity fixture'
  mountHistory(); await wait(() => Boolean(document.querySelector(`[data-fixture-mount="${mountId}"] .dictionary-history`)), 'large-entry history did not mount')
  button('离线查词').click(); await wait(() => Boolean(document.querySelector('[aria-label="离线查词原句"]')), 'large-entry input did not open')
  setValue(query<HTMLTextAreaElement>('[aria-label="离线查词原句"]'), 'Before cats after.')
  setValue(query<HTMLInputElement>('[aria-label="离线输入原文语言"]'), 'en'); await frame(); button('开始离线查词').click()
  await wait(() => Boolean(document.querySelector('[aria-label="离线短语起点"]')), 'large-entry source did not freeze')
  setValue(query<HTMLInputElement>('[aria-label="离线短语起点"]'), '7'); setValue(query<HTMLInputElement>('[aria-label="离线短语终点"]'), '11'); await frame(); button('采用此范围').click()
  await wait(() => !button('查询本机词典').disabled, 'large-entry lookup was not ready'); button('查询本机词典').click()
  await wait(() => document.querySelectorAll('.dictionary-offline-sense').length === 225, 'large-entry lookup did not render all 225 senses')
  const rendered = [...document.querySelectorAll<HTMLElement>('.dictionary-offline-sense')]
  check(rendered.length === 225 && rendered.every((sense, index) => sense.textContent?.includes(`SYNTHETIC_LARGE_SENSE_${String(index + 1).padStart(3, '0')}`)), 'synthetic capacity: all225 senses appear completely in the actual renderer')
  const last = query<HTMLButtonElement>('[data-offline-sense="large-sense-225"] button')
  last.scrollIntoView({ block: 'center' }); await frame(); last.click()
  await wait(() => last.disabled && last.textContent === '此义项已收藏' && records.size === 1, 'last large-entry sense did not save')
  const record = [...records.values()][0], saved = record.explanations[0]
  if (saved.providerKind !== 'offline-dictionary') throw new Error('Expected an offline large-entry snapshot')
  check(saved.sense.id === 'large-sense-225' && saved.pack.schemaVersion === 2 && saved.pack.counts.senses === 225, 'synthetic capacity: last-sense explicit save retains its schema2 source pack')
  check(!('senses' in saved.entry) && record.explanations.length === 1, 'synthetic capacity: history snapshots only the selected sense instead of all225 answers')
  button('查看学习历史中的收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-history [data-encounter-id]')), 'large-entry saved history did not open')
  await openRow(record.id)
  check(document.querySelectorAll('.dictionary-offline-explanation').length === 1 && getText().includes('SYNTHETIC_LARGE_SENSE_225') && !getText().includes('SYNTHETIC_LARGE_SENSE_001'), 'synthetic capacity: saved detail presents only the selected final sense')
  button('返回学习历史').click(); await wait(() => Boolean(document.querySelector('.dictionary-history')), 'large-entry detail did not return')
  button('复习收藏').click(); await wait(() => Boolean(document.querySelector('.dictionary-review')), 'large-entry review did not open')
  check(session?.cards.length === 1 && session.cards[0].explanationId === saved.explanationId, 'synthetic capacity: review targets the one saved selected-sense snapshot')
  check(!document.querySelector('.dictionary-explanation,.dictionary-history,.dictionary-detail') && !getText().includes('SYNTHETIC_LARGE_SENSE_'), 'synthetic capacity: every answer is absent from review DOM before reveal')
  check(providerCalls === beforeCalls && forbiddenNetwork === 0 && forbiddenMedia === 0, 'synthetic capacity: lookup/save/history/review make no service or media call')
  largeEntryFixture = false
  return { checks, forbidden: Array.from({ length: 225 }, (_, index) => `SYNTHETIC_LARGE_SENSE_${String(index + 1).padStart(3, '0')}`), sourcePackSchemaVersion: saved.pack.schemaVersion, selectedSense: saved.sense.id, syntheticOnly: true }
}
async function finishLargeEntryReview() {
  button('揭示已保存解释').click(); await wait(() => Boolean(document.querySelector('.dictionary-offline-explanation')), 'large-entry selected answer did not reveal')
  if (!getText().includes('SYNTHETIC_LARGE_SENSE_225') || getText().includes('SYNTHETIC_LARGE_SENSE_001') || document.querySelectorAll('.dictionary-offline-explanation').length !== 1) throw new Error('Large-entry reveal did not remain limited to its selected answer')
  return { checks: ['synthetic capacity: reveal presents only the saved225th sense, without the other224 meanings'] }
}
function verifyReviewAx() { return { answerNodes: document.querySelectorAll('.dictionary-explanation,.dictionary-history,.dictionary-detail').length, diagnostics: diagnostics() } }
seed()
;(window as unknown as { __lingobarDictionaryTest: unknown }).__lingobarDictionaryTest = { run, appIntegration, mountPhrase, mountHistory, prepareReviewAx, prepareOfflineReviewAx, prepareSourceReadingReviewAx, finishSourceReadingReview, prepareLargeEntryReviewAx, finishLargeEntryReview, verifyReviewAx, diagnostics, complete }
mountHistory()
