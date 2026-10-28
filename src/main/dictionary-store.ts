import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DICTIONARY_LIMITS, type AttemptStatus, type DictionaryAttempt, type DictionaryDocument, type DictionaryEncounter, type DictionaryExplanation, type DictionaryPage, type DictionaryQuery, type DictionaryReviewEvent, type DictionarySource } from '../shared/dictionary'
import { validateDictionaryModel } from '../shared/dictionary-model'
import { isTargetLanguage } from '../shared/languages'
import { validPhrase } from '../shared/learning'

export type DictionaryStoreLimits = { [K in keyof typeof DICTIONARY_LIMITS]: number }
const STATUS: AttemptStatus[] = ['persisting', 'waiting', 'ready', 'ambiguous', 'model_declined', 'schema_error', 'service_error', 'cancelled', 'interrupted']
const TERMINAL = new Set<AttemptStatus>(STATUS.filter(status => status !== 'persisting' && status !== 'waiting'))
const INVALID = '学习历史格式无效，未写入。'
function invalid(): never { throw new Error(INVALID) }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function keys(value: unknown, names: string[]): Record<string, unknown> {
  if (!object(value) || Reflect.ownKeys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name)) || Reflect.ownKeys(value).some(name => typeof name !== 'string' || !names.includes(name))) invalid()
  return value
}
const text = (value: unknown, maximum: number, nonempty = false): value is string => typeof value === 'string' && value.length <= maximum && (!nonempty || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const signature = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const publicName = (value: unknown, maximum: number) => text(value, maximum, true) && !/(?:https?|wss?):\/\//iu.test(value)
const clone = <T>(value: T): T => structuredClone(value)

export function validateDictionarySource(value: unknown): DictionarySource {
  const item = keys(value, ['text', 'language', 'sourceType', 'provenance', 'captionId', 'displayedVersion', 'sourceVersion', 'span'])
  if (!text(item.text, 2000, true) || !text(item.language, 80, true) || !['system', 'microphone', 'text'].includes(String(item.sourceType)) || !['main-verified', 'saved-favorite', 'user-input'].includes(String(item.provenance))) invalid()
  if (!(item.captionId === null || text(item.captionId, 200, true)) || !(item.displayedVersion === null || digest(item.displayedVersion)) || !(item.sourceVersion === null || digest(item.sourceVersion))) invalid()
  if (item.provenance === 'user-input') {
    if (item.sourceType !== 'text' || item.captionId !== null || item.displayedVersion !== null || item.sourceVersion !== null) invalid()
  } else if (item.captionId === null || item.sourceVersion === null) invalid()
  const span = keys(item.span, ['start', 'end', 'exact'])
  if (!text(span.exact, 256, true) || !validPhrase(item.text, span)) invalid()
  return { text: item.text, language: item.language, sourceType: item.sourceType as DictionarySource['sourceType'], provenance: item.provenance as DictionarySource['provenance'], captionId: item.captionId as string | null, displayedVersion: item.displayedVersion as string | null, sourceVersion: item.sourceVersion as string | null, span: { start: Number(span.start), end: Number(span.end), exact: span.exact } }
}
function validateAttempt(value: unknown): DictionaryAttempt {
  const item = keys(value, ['id', 'createdAt', 'updatedAt', 'dispatchState', 'status', 'explanationId'])
  if (!id(item.id) || !timestamp(item.createdAt) || !timestamp(item.updatedAt) || item.updatedAt < item.createdAt || !['not_started', 'may_have_started'].includes(String(item.dispatchState)) || !STATUS.includes(item.status as AttemptStatus) || !(item.explanationId === null || id(item.explanationId))) invalid()
  if (item.status === 'waiting' && item.dispatchState !== 'may_have_started') invalid()
  const successful = ['ready', 'ambiguous', 'model_declined'].includes(String(item.status))
  if (successful ? (item.dispatchState !== 'may_have_started' || item.explanationId === null) : item.explanationId !== null) invalid()
  return { id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt, dispatchState: item.dispatchState as DictionaryAttempt['dispatchState'], status: item.status as AttemptStatus, explanationId: item.explanationId as string | null }
}
function validateExplanation(value: unknown, encounterId: string, source: DictionarySource): DictionaryExplanation {
  const item = keys(value, ['schemaVersion', 'encounterId', 'explanationId', 'version', 'providerKind', 'providerLabel', 'model', 'promptVersion', 'createdAt', 'requestedExplanationLanguage', 'finishReason', 'usage', 'readingScope', 'content', 'validationWarnings'])
  if (item.schemaVersion !== 1 || item.encounterId !== encounterId || !id(item.explanationId) || !Number.isInteger(item.version) || Number(item.version) < 1 || item.providerKind !== 'llm-generated' || !publicName(item.providerLabel, 80) || !publicName(item.model, 200) || !publicName(item.promptVersion, 100) || !timestamp(item.createdAt) || !isTargetLanguage(item.requestedExplanationLanguage) || item.finishReason !== 'stop' || item.readingScope !== 'requested-surface-unverified') invalid()
  if (!Array.isArray(item.validationWarnings) || item.validationWarnings.length > 1 || item.validationWarnings.some(warning => warning !== 'example_duplicates_source')) invalid()
  let usage: DictionaryExplanation['usage'] = null
  if (item.usage !== null) {
    const raw = keys(item.usage, ['promptTokens', 'completionTokens', 'totalTokens'])
    if (Object.values(raw).some(value => value !== null && (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000))) invalid()
    usage = { promptTokens: raw.promptTokens as number | null, completionTokens: raw.completionTokens as number | null, totalTokens: raw.totalTokens as number | null }
  }
  const model = validateDictionaryModel(item.content, source.span.exact, source.text)
  const warnings = [...new Set([...item.validationWarnings, ...model.validationWarnings])] as DictionaryExplanation['validationWarnings']
  return { schemaVersion: 1, encounterId, explanationId: item.explanationId, version: Number(item.version), providerKind: 'llm-generated', providerLabel: item.providerLabel as string, model: item.model as string, promptVersion: item.promptVersion as string, createdAt: item.createdAt, requestedExplanationLanguage: item.requestedExplanationLanguage, finishReason: 'stop', usage, readingScope: 'requested-surface-unverified', content: model.content, validationWarnings: warnings }
}
function validateDocument(value: unknown, limits: DictionaryStoreLimits): DictionaryDocument {
  const raw = keys(value, ['schemaVersion', 'encounters', 'reviews'])
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.encounters) || raw.encounters.length > limits.encounters || !Array.isArray(raw.reviews) || raw.reviews.length > limits.reviews) invalid()
  const encounterIds = new Set<string>(), attemptIds = new Set<string>(), explanationIds = new Set<string>()
  const encounters: DictionaryEncounter[] = raw.encounters.map(value => {
    const item = keys(value, ['id', 'createdAt', 'source', 'favorite', 'note', 'explanations', 'attempts'])
    if (!id(item.id) || encounterIds.has(item.id) || !timestamp(item.createdAt) || typeof item.favorite !== 'boolean' || !text(item.note, limits.note) || !Array.isArray(item.explanations) || item.explanations.length > limits.explanations || !Array.isArray(item.attempts) || item.attempts.length > limits.attempts) invalid()
    encounterIds.add(item.id)
    const source = validateDictionarySource(item.source)
    const explanations = item.explanations.map((value, index) => {
      const explanation = validateExplanation(value, item.id as string, source)
      if (explanation.version !== index + 1 || explanationIds.has(explanation.explanationId)) invalid()
      explanationIds.add(explanation.explanationId); return explanation
    })
    const byId = new Map(explanations.map(explanation => [explanation.explanationId, explanation]))
    const owned = new Set<string>()
    const attempts = item.attempts.map(value => {
      const attempt = validateAttempt(value)
      if (attemptIds.has(attempt.id)) invalid()
      attemptIds.add(attempt.id)
      if (attempt.explanationId) {
        const explanation = byId.get(attempt.explanationId)
        const expected = explanation?.content.status === 'ok' ? 'ready' : explanation?.content.status === 'ambiguous' ? 'ambiguous' : 'model_declined'
        if (!explanation || owned.has(attempt.explanationId) || attempt.status !== expected) invalid()
        owned.add(attempt.explanationId)
      }
      return attempt
    })
    if (owned.size !== explanations.length) invalid()
    return { id: item.id, createdAt: item.createdAt, source, favorite: item.favorite, note: item.note, explanations, attempts }
  })
  const byEncounter = new Map(encounters.map(encounter => [encounter.id, encounter])), reviewIds = new Set<string>(), reviewCounts = new Map<string, number>()
  const reviews: DictionaryReviewEvent[] = raw.reviews.map(value => {
    const item = keys(value, ['id', 'sessionId', 'encounterId', 'explanationId', 'createdAt', 'response'])
    if (!id(item.id) || reviewIds.has(item.id) || !id(item.sessionId) || !id(item.encounterId) || !id(item.explanationId) || !timestamp(item.createdAt) || !['recalled', 'not_recalled'].includes(String(item.response))) invalid()
    const encounter = byEncounter.get(item.encounterId)
    if (!encounter?.explanations.some(explanation => explanation.explanationId === item.explanationId && explanation.content.status === 'ok')) invalid()
    const count = (reviewCounts.get(item.encounterId) || 0) + 1
    if (count > limits.reviewsPerEncounter) invalid()
    reviewCounts.set(item.encounterId, count); reviewIds.add(item.id)
    return { id: item.id, sessionId: item.sessionId, encounterId: item.encounterId, explanationId: item.explanationId, createdAt: item.createdAt, response: item.response as DictionaryReviewEvent['response'] }
  })
  return { schemaVersion: 1, encounters, reviews }
}

/** Own database only: this module never reads or writes legacy favorite/annotation files. */
export class DictionaryStore {
  private document: DictionaryDocument = { schemaVersion: 1, encounters: [], reviews: [] }
  private readonly path: string
  private diskSignature: string | null = null
  private _warning = ''
  private _revision = 0
  private readonly limits: DictionaryStoreLimits
  get warning(): string { return this._warning }
  get revision(): number { return this._revision }
  constructor(directory: string, limits: Partial<DictionaryStoreLimits> = {}) {
    this.path = join(directory, 'dictionary-learning-v1.json')
    this.limits = { ...DICTIONARY_LIMITS, ...limits }
    if (Object.values(this.limits).some(value => !Number.isInteger(value) || value <= 0)) throw new Error('学习历史容量配置无效。')
    if (!existsSync(this.path)) return
    try {
      if (statSync(this.path).size > this.limits.bytes) invalid()
      const contents = readFileSync(this.path, 'utf8'); this.diskSignature = signature(contents)
      const raw: unknown = JSON.parse(contents)
      if (!object(raw) || raw.schemaVersion !== 1) { this._warning = '学习历史版本不受支持，已只读保留原文件。'; return }
      this.document = validateDocument(raw, this.limits)
    } catch { this._warning = '学习历史无法读取或格式无效，已只读保留原文件。'; return }
    if (!this.document.encounters.some(encounter => encounter.attempts.some(attempt => attempt.status === 'persisting' || attempt.status === 'waiting'))) return
    const recovered = clone(this.document)
    for (const encounter of recovered.encounters) for (const attempt of encounter.attempts) if (attempt.status === 'persisting' || attempt.status === 'waiting') {
      attempt.status = 'interrupted'; attempt.updatedAt = Math.max(Date.now(), attempt.updatedAt)
    }
    try { this.commit(recovered) }
    catch { this.document = recovered; this._warning = '上次解释已中断，恢复状态未保存；学习历史现为只读，原文件已保留。' }
  }
  private writable(): void {
    if (this._warning) throw new Error(this._warning)
    try {
      if (existsSync(this.path) && statSync(this.path).size > this.limits.bytes) throw new Error('oversize')
      const actual = existsSync(this.path) ? signature(readFileSync(this.path)) : null
      if (actual !== this.diskSignature) { this._warning = '学习历史已被其他进程修改，已只读保留；请重启后重试。'; throw new Error(this._warning) }
    } catch { throw new Error(this._warning || '学习历史无法核验，未写入；请检查磁盘与权限。') }
  }
  private commit(value: DictionaryDocument): void {
    this.writable()
    const next = validateDocument(value, this.limits), payload = JSON.stringify(next, null, 2)
    const reserved = next.encounters.reduce((total, encounter) => total + encounter.attempts.filter(attempt => attempt.status === 'persisting' || attempt.status === 'waiting').length, 0) * this.limits.reservationBytes
    if (Buffer.byteLength(payload, 'utf8') + reserved > this.limits.bytes) throw new Error('学习历史已达容量上限，未提交；请先导出并显式删除部分条目。')
    const temporary = `${this.path}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, payload, 'utf8'); fsyncSync(descriptor)
      closeSync(descriptor); descriptor = undefined
      renameSync(temporary, this.path)
      this.document = next; this.diskSignature = signature(payload); this._revision++
    } catch { throw new Error('学习历史写入失败，未提交；请检查磁盘或权限后重试。') }
    finally {
      if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* Preserve the contextual write failure. */ } }
      try { unlinkSync(temporary) } catch { /* Renamed/missing temporary files need no cleanup. */ }
    }
  }
  assertCanStart(encounterId?: string): void {
    this.writable()
    if (encounterId !== undefined) {
      const encounter = this.document.encounters.find(item => item.id === encounterId)
      if (!encounter) throw new Error('学习条目不存在，未发出解释请求。')
      if (encounter.explanations.length >= this.limits.explanations || encounter.attempts.length >= this.limits.attempts) throw new Error('此条目的解释版本或尝试记录已满，未发出请求；不会静默淘汰旧记录。')
    } else if (this.document.encounters.length >= this.limits.encounters) throw new Error('学习条目已满，未发出请求；请先导出并显式删除部分条目。')
    const pending = this.document.encounters.reduce((total, encounter) => total + encounter.attempts.filter(attempt => attempt.status === 'persisting' || attempt.status === 'waiting').length, 0)
    if (Buffer.byteLength(JSON.stringify(this.document, null, 2), 'utf8') + (pending + 1) * this.limits.reservationBytes > this.limits.bytes) throw new Error('学习历史剩余空间不足以预留本次解释，未发出请求。')
  }
  get(encounterId: string): DictionaryEncounter | null { return clone(this.document.encounters.find(item => item.id === encounterId) || null) }
  exportSnapshot(): DictionaryDocument { return clone(this.document) }
  list(query: DictionaryQuery = {}): DictionaryPage {
    if (!object(query) || Object.keys(query).some(key => !['query', 'language', 'provenance', 'favorite', 'incomplete', 'page', 'pageSize'].includes(key)) || (query.query !== undefined && !text(query.query, 500)) || (query.language !== undefined && !text(query.language, 80, true)) || (query.provenance !== undefined && !['main-verified', 'saved-favorite', 'user-input'].includes(query.provenance)) || (query.favorite !== undefined && typeof query.favorite !== 'boolean') || (query.incomplete !== undefined && typeof query.incomplete !== 'boolean') || (query.page !== undefined && (!Number.isInteger(query.page) || query.page < 1)) || (query.pageSize !== undefined && (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 50))) throw new Error('学习历史查询无效。')
    const needle = (query.query || '').trim().normalize('NFC').toLowerCase(), pageSize = query.pageSize || 20
    const items = this.document.encounters.filter(encounter => {
      if (query.language !== undefined && encounter.source.language !== query.language) return false
      if (query.provenance !== undefined && encounter.source.provenance !== query.provenance) return false
      if (query.favorite !== undefined && encounter.favorite !== query.favorite) return false
      const incomplete = encounter.explanations.length === 0 && !encounter.favorite && !encounter.note.trim()
      if (query.incomplete !== undefined && incomplete !== query.incomplete) return false
      return !needle || [encounter.source.span.exact, encounter.source.text, encounter.note, ...encounter.explanations.flatMap(explanation => [explanation.content.contextMeaning || '', explanation.content.headword || '', explanation.content.usageNote || ''])].some(value => value.normalize('NFC').toLowerCase().includes(needle))
    }).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const page = Math.min(query.page || 1, Math.max(1, Math.ceil(items.length / pageSize)))
    return { items: clone(items.slice((page - 1) * pageSize, page * pageSize)), total: items.length, page, pageSize, revision: this._revision, warning: this._warning }
  }
  createEncounter(value: DictionaryEncounter): void {
    this.assertCanStart()
    if (this.document.encounters.some(item => item.id === value.id)) throw new Error('学习条目编号已存在，未写入。')
    this.commit({ ...this.document, encounters: [...this.document.encounters, clone(value)] })
  }
  addAttempt(encounterId: string, attempt: DictionaryAttempt): void {
    this.assertCanStart(encounterId)
    const next = clone(this.document), encounter = next.encounters.find(item => item.id === encounterId)!
    if (encounter.attempts.some(item => item.status === 'persisting' || item.status === 'waiting')) throw new Error('此条目已有正在等待的解释，未重复请求。')
    encounter.attempts.push(clone(attempt)); this.commit(next)
  }
  updateAttempt(encounterId: string, attemptId: string, patch: Partial<Pick<DictionaryAttempt, 'status' | 'dispatchState' | 'updatedAt' | 'explanationId'>>): void {
    if (!object(patch) || Object.keys(patch).some(key => !['status', 'dispatchState', 'updatedAt', 'explanationId'].includes(key))) invalid()
    const next = clone(this.document), encounter = next.encounters.find(item => item.id === encounterId), attempt = encounter?.attempts.find(item => item.id === attemptId)
    if (!attempt) throw new Error('解释尝试不存在，未写入。')
    if (TERMINAL.has(attempt.status) && patch.status !== undefined && patch.status !== attempt.status) throw new Error('解释尝试已经结束，未改写旧状态。')
    if (attempt.dispatchState === 'may_have_started' && patch.dispatchState === 'not_started') throw new Error('出站状态不能回退。')
    if (patch.updatedAt !== undefined && patch.updatedAt < attempt.updatedAt) invalid()
    Object.assign(attempt, clone(patch)); this.commit(next)
  }
  appendExplanation(encounterId: string, attemptId: string, explanation: DictionaryExplanation): void {
    const next = clone(this.document), encounter = next.encounters.find(item => item.id === encounterId), attempt = encounter?.attempts.find(item => item.id === attemptId)
    if (!encounter || !attempt || attempt.status !== 'waiting' || attempt.dispatchState !== 'may_have_started') throw new Error('解释尝试已结束或条目已删除，未追加结果。')
    if (encounter.explanations.length >= this.limits.explanations || explanation.version !== encounter.explanations.length + 1) throw new Error('解释版本已满或版本无效，未追加结果。')
    encounter.explanations.push(clone(explanation)); attempt.explanationId = explanation.explanationId
    attempt.status = explanation.content.status === 'ok' ? 'ready' : explanation.content.status === 'ambiguous' ? 'ambiguous' : 'model_declined'
    attempt.updatedAt = Math.max(attempt.updatedAt, explanation.createdAt); this.commit(next)
  }
  edit(encounterId: string, input: { favorite?: boolean; note?: string }): void {
    if (!object(input) || Object.keys(input).some(key => key !== 'favorite' && key !== 'note') || (input.favorite !== undefined && typeof input.favorite !== 'boolean') || (input.note !== undefined && !text(input.note, this.limits.note))) invalid()
    const next = clone(this.document), encounter = next.encounters.find(item => item.id === encounterId)
    if (!encounter) throw new Error('学习条目不存在，未保存编辑。')
    if (input.favorite !== undefined) encounter.favorite = input.favorite
    if (input.note !== undefined) encounter.note = input.note
    this.commit(next)
  }
  remove(encounterId: string): void {
    if (!id(encounterId)) invalid()
    if (!this.document.encounters.some(item => item.id === encounterId)) return
    this.commit({ ...this.document, encounters: this.document.encounters.filter(item => item.id !== encounterId), reviews: this.document.reviews.filter(item => item.encounterId !== encounterId) })
  }
  addReview(value: DictionaryReviewEvent): void {
    const existing = this.document.reviews.find(item => item.id === value.id)
    if (existing) {
      const fields: Array<keyof DictionaryReviewEvent> = ['id', 'sessionId', 'encounterId', 'explanationId', 'createdAt', 'response']
      const raw = keys(value, fields)
      if (fields.some(key => existing[key] !== raw[key])) throw new Error('复习事件编号冲突，未重复保存。')
      return
    }
    const encounter = this.document.encounters.find(item => item.id === value.encounterId)
    if (!encounter?.favorite || !encounter.explanations.some(item => item.explanationId === value.explanationId && item.content.status === 'ok')) throw new Error('只可自评仍在收藏且已有可用解释的条目。')
    if (this.document.reviews.length >= this.limits.reviews || this.document.reviews.filter(item => item.encounterId === value.encounterId).length >= this.limits.reviewsPerEncounter) throw new Error('复习记录已满，未增加计数。')
    this.commit({ ...this.document, reviews: [...this.document.reviews, clone(value)] })
  }
  removeReview(eventId: string, sessionId: string): boolean {
    if (!id(eventId) || !id(sessionId)) invalid()
    const item = this.document.reviews.find(item => item.id === eventId)
    if (!item) return false
    if (item.sessionId !== sessionId) throw new Error('只能撤销本次复习会话的事件。')
    this.commit({ ...this.document, reviews: this.document.reviews.filter(item => item.id !== eventId) }); return true
  }
}
