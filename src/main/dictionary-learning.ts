import { createHash, randomUUID } from 'node:crypto'
import type { Caption } from '../shared/types'
import { isTargetLanguage } from '../shared/languages'
import { learningOriginal, validPhrase } from '../shared/learning'
import { dictionarySourceVersion, type DictionaryAvailability, type DictionaryDetail, type DictionaryEncounter, type DictionaryExplainInput, type DictionaryExplanation, type DictionaryHandleResult, type DictionaryOpen, type DictionaryReviewEvent, type DictionaryReviewSession, type DictionaryRunState, type DictionarySnapshot } from '../shared/dictionary'
import { DictionarySchemaError, validateDictionaryModel, validDictionaryText } from '../shared/dictionary-model'
import { DictionaryStore } from './dictionary-store'
import type { explainDictionary } from './dictionary-provider'

type Result = Awaited<ReturnType<typeof explainDictionary>>
type Provider = (input: { sourceText: string; targetText: string; requestedExplanationLanguage: import('../shared/languages').TargetLanguage }, signal: AbortSignal) => Promise<Result>
type Context = { encounterId: string; attemptId: string; generation: number; controller: AbortController; descriptor: DictionaryAvailability }
type Review = DictionaryReviewSession & { owner: number; history: Array<{ eventId: string; index: number }>; rated: Map<string, string>; undone: Set<string>; reveal: { id: string; encounterId: string; explanationId: string } | null }
const clone = <T>(value: T): T => structuredClone(value)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value)
const feeWarning = '请求可能已发出并产生费用，无法确定；停止等待不代表退款。'

/** One explicit request owner; no ASR subscriptions, retries, hidden lookups or credentials. */
export class DictionaryLearning {
  private handles = new Map<number, { token: string; source: DictionarySnapshot; originEncounterId: string | null }>()
  private generations = new Map<string, number>()
  private runs = new Map<string, DictionaryRunState>()
  private flight: Context | null = null
  private unsaved: { context: Context; explanation: DictionaryExplanation } | null = null
  private reviews = new Map<number, Review>()
  private closed = false
  constructor(readonly store: DictionaryStore, private captions: () => Caption[], private descriptor: () => DictionaryAvailability, private provider: Provider, private changed: () => void) {}
  availability(): DictionaryAvailability {
    const result = this.descriptor()
    const model = typeof result.model === 'string' && result.model.length <= 200 && !/[\u0000-\u001f\u007f]|https?:\/\//i.test(result.model) ? result.model : '未配置有效模型'
    return { configured: result.configured && model !== '未配置有效模型', providerLabel: result.providerLabel === 'DeepSeek' ? 'DeepSeek' : '兼容翻译服务', model, offlineDictionaryAvailable: false }
  }
  open(owner: number, value: unknown): DictionaryHandleResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.invalidHandle(owner)
    const input = value as DictionaryOpen
    if (typeof input.captionId !== 'string' || input.captionId.length > 200 || !validDictionaryText(input.displayedText, 2000) || typeof input.sourceVersion !== 'string' || input.sourceVersion.length > 25000 || typeof input.displayedVersion !== 'string' || input.displayedVersion.length > 180000) return this.invalidHandle(owner)
    const caption = this.captions().find(caption => caption.id === input.captionId)
    // Source-only agreement is intentional. Late ruby/translation or a growing untranslated tail does not change this paired source.
    if (!caption || learningOriginal(caption) !== input.displayedText || dictionarySourceVersion(caption) !== input.sourceVersion || !validDictionaryText(caption.language, 80)) return this.invalidHandle(owner)
    const userInput = !caption.saved && caption.source === 'text'
    return this.issue(owner, { text: input.displayedText, language: caption.language, sourceType: caption.source, provenance: caption.saved ? 'saved-favorite' : userInput ? 'user-input' : 'main-verified', captionId: userInput ? null : caption.id,
      displayedVersion: userInput ? null : digest(input.displayedVersion), sourceVersion: userInput ? null : digest(input.sourceVersion) })
  }
  private invalidHandle(owner: number): DictionaryHandleResult {
    this.handles.delete(owner)
    return { handle: null, source: null, reason: '无法核对这次冻结原文；阅读与草稿仍可用，请重新选择句子。' }
  }
  private issue(owner: number, source: DictionarySnapshot, originEncounterId: string | null = null): DictionaryHandleResult {
    const token = randomUUID(); this.handles.set(owner, { token, source: clone(source), originEncounterId })
    return { handle: token, source: clone(source), reason: '' }
  }
  openEncounter(owner: number, value: unknown): DictionaryHandleResult {
    if (!id(value)) return this.invalidHandle(owner)
    const encounter = this.store.get(value)
    if (!encounter) return this.invalidHandle(owner)
    const { span: _span, ...source } = encounter.source
    return this.issue(owner, source, value)
  }
  release(owner: number, token: unknown): void { if (typeof token === 'string' && this.handles.get(owner)?.token === token) this.handles.delete(owner) }
  releaseOwner(owner: number): void { this.handles.delete(owner); this.reviews.delete(owner) }
  private live(context: Context): boolean { return !this.closed && this.generations.get(context.encounterId) === context.generation && Boolean(this.store.get(context.encounterId)) }
  private update(context: Context, state: DictionaryRunState['state'], message: string, unsaved?: DictionaryExplanation): DictionaryRunState {
    const attempt = this.store.get(context.encounterId)?.attempts.find(attempt => attempt.id === context.attemptId)
    const result: DictionaryRunState = { encounterId: context.encounterId, attemptId: context.attemptId, state, dispatchState: attempt?.dispatchState || 'not_started', message, ...(unsaved ? { unsaved: clone(unsaved) } : {}) }
    if (attempt) this.runs.set(context.encounterId, result)
    this.changed(); return clone(result)
  }
  explain(owner: number, value: unknown): DictionaryRunState {
    if (this.closed) throw new Error('学习服务已关闭。')
    if (this.flight) throw new Error('已有一个解释请求在途，请等待或明确停止等待。')
    if (this.unsaved) throw new Error('上次解释仅在内存，请先重试保存或明确放弃；不会自动再次调用。')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('解释请求无效。')
    const input = value as DictionaryExplainInput, handle = this.handles.get(owner)
    if (!handle || handle.token !== input.handle || (handle.originEncounterId !== null && !this.store.get(handle.originEncounterId))) throw new Error('源文快照已失效，请重新选择。')
    if (!isTargetLanguage(input.language) || !validPhrase(handle.source.text, input.span) || !validDictionaryText(input.span.exact, 256) || Object.keys(input.span).some(key => !['start', 'end', 'exact'].includes(key))) throw new Error('请从冻结原文选择不超过 256 个字符的连续完整短语。')
    const descriptor = this.availability()
    if (!descriptor.configured) throw new Error('请先在既有设置中配置翻译服务；解释未发出。')
    const acceptedSpan = { start: input.span.start, end: input.span.end, exact: input.span.exact }
    let encounter: DictionaryEncounter
    if (input.encounterId !== undefined) {
      if (!id(input.encounterId)) throw new Error('学习条目无效。')
      const current = this.store.get(input.encounterId)
      if (!current || (['text', 'language', 'sourceType', 'provenance', 'captionId', 'displayedVersion', 'sourceVersion'] as const).some(key => current.source[key] !== handle.source[key]) || current.source.span.start !== acceptedSpan.start || current.source.span.end !== acceptedSpan.end || current.source.span.exact !== acceptedSpan.exact) throw new Error('重新解释必须使用原条目的同一原文与短语。')
      encounter = current
    } else encounter = { id: randomUUID(), createdAt: Date.now(), source: { ...clone(handle.source), span: acceptedSpan }, favorite: false, note: '', explanations: [], attempts: [] }
    this.store.assertCanStart(input.encounterId)
    const attempt = { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), dispatchState: 'not_started' as const, status: 'persisting' as const, explanationId: null }
    const context: Context = { encounterId: encounter.id, attemptId: attempt.id, generation: (this.generations.get(encounter.id) || 0) + 1, controller: new AbortController(), descriptor }
    this.generations.set(encounter.id, context.generation); this.flight = context
    try {
      if (input.encounterId) this.store.addAttempt(encounter.id, attempt)
      else this.store.createEncounter({ ...encounter, attempts: [attempt] })
    } catch {
      this.flight = null
      if (!this.store.get(encounter.id)) this.generations.delete(encounter.id)
      return this.update(context, 'persist_error', '未能保存本次查询意图，解释请求未发出。请检查本机写入与容量。')
    }
    try { this.store.updateAttempt(encounter.id, attempt.id, { status: 'waiting', dispatchState: 'may_have_started', updatedAt: Date.now() }) }
    catch {
      this.flight = null
      return this.update(context, 'persist_error', '未能保存出站标志，解释请求未发出。可在未完成记录中查看。')
    }
    const waiting = this.update(context, 'waiting', `已请求以所选语言解释。${feeWarning}`)
    void this.execute(context, clone(encounter.source), input.language)
    return waiting
  }
  private async execute(context: Context, source: DictionaryEncounter['source'], language: import('../shared/languages').TargetLanguage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([this.provider({ sourceText: source.text, targetText: source.span.exact, requestedExplanationLanguage: language }, context.controller.signal), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { context.controller.abort(); reject(new Error('deadline')) }, 25000)
      })])
      if (!this.live(context)) return
      const validated = validateDictionaryModel(result.content, source.span.exact, source.text)
      if (result.finishReason !== 'stop') throw new DictionarySchemaError()
      const encounter = this.store.get(context.encounterId)!
      const explanation: DictionaryExplanation = { schemaVersion: 1, encounterId: encounter.id, explanationId: randomUUID(), version: encounter.explanations.length + 1,
        providerKind: 'llm-generated', providerLabel: context.descriptor.providerLabel, model: context.descriptor.model, promptVersion: result.promptVersion, createdAt: Date.now(), requestedExplanationLanguage: language,
        finishReason: 'stop', usage: result.usage, readingScope: 'requested-surface-unverified', content: validated.content, validationWarnings: [...new Set([...validated.validationWarnings, ...result.validationWarnings])] }
      try { this.store.appendExplanation(encounter.id, context.attemptId, explanation) }
      catch {
        if (this.live(context)) { this.unsaved = { context, explanation }; this.update(context, 'ready_unsaved', '结果仅在本次应用内存，尚未写入学习库；退出将丢失。仅重试保存不会再次调用服务。', explanation) }
        return
      }
      this.update(context, result.content.status === 'ok' ? 'ready' : result.content.status === 'ambiguous' ? 'ambiguous' : 'model_declined', 'AI 生成，可能不准确。结构校验通过不代表语义正确。')
    } catch (error) {
      if (!this.live(context)) return
      const state = error instanceof DictionarySchemaError ? 'schema_error' : 'service_error'
      try { this.store.updateAttempt(context.encounterId, context.attemptId, { status: state, updatedAt: Date.now() }) }
      catch { this.update(context, 'persist_error', `结果/失败状态未能写入；没有自动重试。${feeWarning}`); return }
      this.update(context, state, state === 'schema_error' ? `返回内容未通过严格结构校验，未自动重试。${feeWarning}` : `服务请求未完成，请检查连接、配置或额度。未自动重试。${feeWarning}`)
    } finally {
      if (timer) clearTimeout(timer)
      if (this.flight === context) this.flight = null
      this.changed()
    }
  }
  get(value: unknown): DictionaryDetail | null {
    if (!id(value)) throw new Error('学习条目无效。')
    const encounter = this.store.get(value)
    if (!encounter) return null
    const latest = encounter.attempts.at(-1)
    const run = this.runs.get(value) || (latest ? { encounterId: value, attemptId: latest.id, state: latest.status === 'persisting' ? 'interrupted' : latest.status, dispatchState: latest.dispatchState,
      message: latest.status === 'interrupted' ? (latest.dispatchState === 'not_started' ? '上次查询中断，本解释请求未发出；不会自动重试。' : `上次等待中断，不会自动重试。${feeWarning}`) : '查看已提交记录不会调用服务。' } as DictionaryRunState : null)
    return { encounter, run: clone(run) }
  }
  cancel(encounterId: unknown, attemptId: unknown): DictionaryRunState {
    if (!id(encounterId) || !id(attemptId)) throw new Error('解释请求无效。')
    const encounter = this.store.get(encounterId), attempt = encounter?.attempts.find(attempt => attempt.id === attemptId)
    if (!attempt || !['persisting', 'waiting'].includes(attempt.status)) throw new Error('此请求已结束；不会自动重新调用。')
    this.generations.set(encounterId, (this.generations.get(encounterId) || 0) + 1)
    const context = this.flight?.encounterId === encounterId && this.flight.attemptId === attemptId ? this.flight : { encounterId, attemptId, generation: 0, controller: new AbortController(), descriptor: this.availability() }
    context.controller.abort()
    if (this.unsaved?.context.encounterId === encounterId && this.unsaved.context.attemptId === attemptId) this.unsaved = null
    let stored = true
    try { this.store.updateAttempt(encounterId, attemptId, { status: 'cancelled', updatedAt: Date.now() }) } catch { stored = false }
    return this.update(context, 'cancelled', `${stored ? '已停止等待。' : '已停止等待，取消状态未能写盘。'}${attempt.dispatchState === 'not_started' ? '本解释请求未发出。' : feeWarning}`)
  }
  retrySave(encounterId: unknown, attemptId: unknown): DictionaryRunState {
    const pending = this.unsaved
    if (!pending || pending.context.encounterId !== encounterId || pending.context.attemptId !== attemptId || !this.live(pending.context)) throw new Error('没有可保存的内存结果；不会重新调用服务。')
    try { this.store.appendExplanation(pending.context.encounterId, pending.context.attemptId, pending.explanation) }
    catch { return this.update(pending.context, 'ready_unsaved', '保存仍未完成，结果仅在内存；退出将丢失。没有再次调用服务。', pending.explanation) }
    this.unsaved = null
    return this.update(pending.context, pending.explanation.content.status === 'ok' ? 'ready' : pending.explanation.content.status === 'ambiguous' ? 'ambiguous' : 'model_declined', '已保存内存结果，没有再次调用服务。AI 生成，可能不准确。')
  }
  discardUnsaved(encounterId: unknown, attemptId: unknown): void {
    const pending = this.unsaved
    if (!pending || pending.context.encounterId !== encounterId || pending.context.attemptId !== attemptId) return
    this.unsaved = null
    this.generations.set(pending.context.encounterId, pending.context.generation + 1)
    try { this.store.updateAttempt(pending.context.encounterId, pending.context.attemptId, { status: 'cancelled', updatedAt: Date.now() }) }
    catch {
      this.update(pending.context, 'cancelled', `内存结果已放弃，但状态未能写盘；不会重新调用。${feeWarning}`)
      throw new Error('内存结果已放弃，但状态未能写盘；不会重新调用。')
    }
    this.update(pending.context, 'cancelled', `已明确放弃未保存结果。${feeWarning}`)
  }
  edit(value: unknown, input: unknown): void {
    if (!id(value) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['favorite', 'note'].includes(key))) throw new Error('学习记录编辑无效。')
    this.store.edit(value, input); this.changed()
  }
  remove(value: unknown): void {
    if (!id(value)) throw new Error('学习条目无效。')
    this.generations.set(value, (this.generations.get(value) || 0) + 1)
    for (const [owner, handle] of this.handles) if (handle.originEncounterId === value) this.handles.delete(owner)
    if (this.flight?.encounterId === value) this.flight.controller.abort()
    if (this.unsaved?.context.encounterId === value) this.unsaved = null
    const prior = this.runs.get(value)
    if (prior) this.runs.set(value, { encounterId: prior.encounterId, attemptId: prior.attemptId, state: 'persist_error', dispatchState: prior.dispatchState, message: '删除尚未提交；旧请求与未保存结果已失效。' })
    try { this.store.remove(value) }
    catch { this.changed(); throw new Error('未删除：本机写入失败或记录为只读。旧请求已失效，可明确重试删除。') }
    this.runs.delete(value); this.generations.delete(value)
    const events = new Map(this.store.exportSnapshot().reviews.map(event => [event.id, event]))
    for (const review of this.reviews.values()) {
      const previous = review.cards, current = previous[review.cursor]
      const removedBefore = previous.slice(0, review.cursor).filter(card => card.encounterId === value).length
      review.cards = previous.filter(card => card.encounterId !== value)
      const retainedIndex = current ? review.cards.findIndex(card => card.encounterId === current.encounterId && card.explanationId === current.explanationId) : -1
      review.cursor = retainedIndex >= 0 ? retainedIndex : Math.min(Math.max(0, review.cursor - removedBefore), review.cards.length)
      review.history = review.history.filter(item => events.has(item.eventId)).map(item => {
        const event = events.get(item.eventId)!
        const index = review.cards.findIndex(card => card.encounterId === event.encounterId && card.explanationId === event.explanationId)
        return { ...item, index: Math.max(0, index) }
      })
      review.completed = review.history.length; review.lastEventId = review.history.at(-1)?.eventId || null
      if (review.reveal?.encounterId === value) review.reveal = null
    }
    this.changed()
  }
  get hasUnsaved(): boolean { return this.unsaved !== null }
  close(): void { this.closed = true; this.flight?.controller.abort(); this.handles.clear(); this.reviews.clear(); this.unsaved = null; this.runs.clear(); this.generations.clear() }
  private review(owner: number, sessionId: unknown): Review {
    const review = this.reviews.get(owner)
    if (!review || review.sessionId !== sessionId) throw new Error('复习会话已结束，请主动重新进入。')
    return review
  }
  private reviewSnapshot(review: Review): DictionaryReviewSession { return clone({ sessionId: review.sessionId, cards: review.cards, cursor: review.cursor, completed: review.completed, lastEventId: review.lastEventId }) }
  startReview(owner: number): DictionaryReviewSession {
    const cards = this.store.exportSnapshot().encounters.filter(encounter => encounter.favorite).flatMap(encounter => {
      const explanation = encounter.explanations.filter(explanation => explanation.content.status === 'ok').at(-1)
      return explanation ? [{ encounterId: encounter.id, explanationId: explanation.explanationId, source: clone(encounter.source) }] : []
    })
    const review: Review = { owner, sessionId: randomUUID(), cards, cursor: 0, completed: 0, lastEventId: null, history: [], rated: new Map(), undone: new Set(), reveal: null }
    this.reviews.set(owner, review); return this.reviewSnapshot(review)
  }
  reviewState(owner: number, sessionId: unknown): DictionaryReviewSession { return this.reviewSnapshot(this.review(owner, sessionId)) }
  endReview(owner: number, sessionId: unknown): void { if (this.reviews.get(owner)?.sessionId === sessionId) this.reviews.delete(owner) }
  reveal(owner: number, sessionId: unknown, encounterId: unknown, explanationId: unknown): { revealId: string; explanation: DictionaryExplanation } {
    const review = this.review(owner, sessionId), card = review.cards[review.cursor]
    if (!card || card.encounterId !== encounterId || card.explanationId !== explanationId) throw new Error('请揭示当前复习条目的已保存版本。')
    const encounter = this.store.get(card.encounterId), explanation = encounter?.explanations.find(explanation => explanation.explanationId === card.explanationId && explanation.content.status === 'ok')
    if (!encounter?.favorite || !explanation) throw new Error('此条目已变化或删除，请跳过或重新进入复习。')
    if (!review.reveal || review.reveal.encounterId !== encounterId || review.reveal.explanationId !== explanationId) review.reveal = { id: randomUUID(), encounterId: card.encounterId, explanationId: card.explanationId }
    return { revealId: review.reveal.id, explanation: clone(explanation) }
  }
  rate(owner: number, sessionId: unknown, revealId: unknown, response: unknown): DictionaryReviewSession {
    const review = this.review(owner, sessionId)
    if (typeof revealId === 'string' && review.rated.has(revealId)) return this.reviewSnapshot(review)
    if (!review.reveal || review.reveal.id !== revealId || (response !== 'recalled' && response !== 'not_recalled')) throw new Error('请先揭示当前答案，再明确自评。')
    const revealed = review.reveal, current = review.cards[review.cursor]
    if (!current || current.encounterId !== revealed.encounterId) throw new Error('复习目标已变化。')
    const encounter = this.store.get(revealed.encounterId)
    if (!encounter?.favorite || !encounter.explanations.some(explanation => explanation.explanationId === revealed.explanationId && explanation.content.status === 'ok')) throw new Error('复习条目已删除或不再可用。')
    const event: DictionaryReviewEvent = { id: randomUUID(), sessionId: review.sessionId, encounterId: revealed.encounterId, explanationId: revealed.explanationId, createdAt: Date.now(), response }
    this.store.addReview(event)
    review.rated.set(revealed.id, event.id); review.history.push({ eventId: event.id, index: review.cursor }); review.completed = review.history.length; review.lastEventId = event.id; review.cursor++; review.reveal = null
    this.changed(); return this.reviewSnapshot(review)
  }
  skip(owner: number, sessionId: unknown): DictionaryReviewSession {
    const review = this.review(owner, sessionId)
    review.cursor = Math.min(review.cursor + 1, review.cards.length); review.reveal = null
    return this.reviewSnapshot(review)
  }
  undo(owner: number, sessionId: unknown, eventId: unknown): DictionaryReviewSession {
    const review = this.review(owner, sessionId)
    if (typeof eventId === 'string' && review.undone.has(eventId)) return this.reviewSnapshot(review)
    const last = review.history.at(-1)
    if (!last || last.eventId !== eventId) throw new Error('只能撤销本次复习最近一次实际自评。')
    if (!this.store.removeReview(last.eventId, review.sessionId)) throw new Error('该自评已不存在。')
    review.history.pop(); review.undone.add(last.eventId); review.completed = review.history.length; review.lastEventId = review.history.at(-1)?.eventId || null; review.cursor = last.index; review.reveal = null
    this.changed(); return this.reviewSnapshot(review)
  }
}
