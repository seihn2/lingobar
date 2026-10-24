import { randomUUID } from 'node:crypto'
import type { AudioSource, Caption } from '../shared/types'
import { translateCaption, type TranslationConfig } from './translation'
import { annotateJapanese } from './japanese'
import { DEFAULT_LANGUAGES, isTargetLanguage } from '../shared/languages'
import { trace } from './diagnostics'

interface AnnotationJob {
  caption: Caption
  original: string
  japanese: string
  config: TranslationConfig
  controller: AbortController
  timeout: ReturnType<typeof setTimeout>
}

interface TranslationState {
  revision: number
  publishedRevision: number
  lastStartedAt: number | null
  incremental: boolean
  finalRevision?: number
  publishedConfig?: Pick<TranslationConfig, 'baseUrl' | 'model' | 'targetLanguages'>
  timer?: ReturnType<typeof setTimeout>
}

interface TranslationJob {
  caption: Caption
  original: string
  revision: number
  config: TranslationConfig
  controller: AbortController
  queuedAt: number
  startedAt?: number
}

interface LiveUtterance { source: AudioSource; captions: Caption[] }

const FIRST_DRAFT_DELAY = 650
const DRAFT_INTERVAL = 1100
const AUDIO_CHUNK_SIZE = 6000

/** Preserve every UTF-16 unit while never cutting a supplementary character in half. */
function audioChunks(text: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + AUDIO_CHUNK_SIZE, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

export class CaptionQueue {
  captions: Caption[]
  private waiting: TranslationJob[] = []
  private running = new Map<string, TranslationJob>()
  private work = new Map<string, TranslationState>()
  private utterances = new Map<string, LiveUtterance>()
  private annotations = new Map<string, AnnotationJob>()
  private annotationWaiting: AnnotationJob[] = []
  private annotationRunning = new Set<AnnotationJob>()
  private closed = false
  constructor(saved: Caption[], private config: () => TranslationConfig, private changed: () => void,
    private persist: (captions: Caption[]) => void, private translator = translateCaption,
    private annotator = annotateJapanese) {
    this.captions = saved
  }
  add(text: string, source: Caption['source']): void {
    if (this.closed) return
    const original = text.trim()
    if (!original) return
    if (original.length > 8000) throw new Error('单句过长，请分成较短的段落。')
    const caption = this.createCaption(original, source, false)
    this.enqueue(caption)
  }
  private createCaption(original: string, source: Caption['source'], live: boolean): Caption {
    const caption: Caption = { id: randomUUID(), source, original, language: '', zh: '', en: '', ja: '', reading: '', createdAt: Date.now(), status: 'translating', saved: false,
      ...(live ? { live: true, translationPending: true } : {}) }
    this.captions.push(caption)
    this.work.set(caption.id, { revision: 1, publishedRevision: 0, lastStartedAt: null, incremental: live })
    this.trim()
    return caption
  }
  private utteranceKey(source: AudioSource, utteranceId?: string): string {
    return `${source}:${utteranceId || 'current'}`
  }
  updatePartial(text: string, source: AudioSource, utteranceId?: string): void {
    if (this.closed || !text.trim()) return
    const key = this.utteranceKey(source, utteranceId)
    this.updateUtterance(key, text.trim(), source)
    this.changed()
  }
  private updateUtterance(key: string, text: string, source: AudioSource): LiveUtterance {
    let utterance = this.utterances.get(key)
    if (!utterance) { utterance = { source, captions: [] }; this.utterances.set(key, utterance) }
    const chunks = audioChunks(text)
    for (let index = 0; index < chunks.length; index++) {
      let caption = utterance.captions[index]
      if (!caption) {
        caption = this.createCaption(chunks[index], source, true)
        utterance.captions.push(caption)
        trace('caption.segment', { id: caption.id, utterance: key, index, chars: chunks[index].length })
      } else if (caption.original !== chunks[index]) {
        caption.original = chunks[index]
        this.work.get(caption.id)!.revision++
      } else continue
      this.scheduleDraft(caption)
    }
    // Recognition corrections may shorten a previous speculative chunk.
    for (const caption of utterance.captions.splice(chunks.length)) {
      this.cancelTranslation(caption.id)
      this.cancelAnnotation(caption.id)
      this.work.delete(caption.id)
      this.captions = this.captions.filter(item => item !== caption)
    }
    return utterance
  }
  finishSentence(text: string, source: AudioSource, utteranceId?: string): void {
    if (this.closed) return
    const key = this.utteranceKey(source, utteranceId)
    let utterance = this.utterances.get(key)
    if (text.trim()) utterance = this.updateUtterance(key, text.trim(), source)
    if (!utterance) return
    this.utterances.delete(key)
    this.finalizeUtterance(utterance)
  }
  finishPartials(): void {
    if (this.closed) return
    const utterances = [...this.utterances.values()]
    this.utterances.clear()
    for (const utterance of utterances) this.finalizeUtterance(utterance)
  }
  private finalizeUtterance(utterance: LiveUtterance): void {
    for (const caption of utterance.captions) {
      const state = this.work.get(caption.id)!
      if (state.timer) { clearTimeout(state.timer); state.timer = undefined }
      caption.live = false
      const running = this.running.get(caption.id)
      const queued = this.waiting.find(job => job.caption === caption)
      let current: TranslationConfig | undefined
      try { current = this.config() } catch { /* enqueue exposes the configuration failure. */ }
      const compatible = (config?: Pick<TranslationConfig, 'baseUrl' | 'model' | 'targetLanguages'>) => Boolean(current && config &&
        current.baseUrl === config.baseUrl && current.model === config.model &&
        (current.targetLanguages || DEFAULT_LANGUAGES).join(',') === (config.targetLanguages || DEFAULT_LANGUAGES).join(','))
      const complete = caption.translatedOriginal === caption.original && this.hasTranslation(caption) && compatible(state.publishedConfig)
      if (complete) {
        this.cancelTranslation(caption.id)
        state.finalRevision = state.publishedRevision
        caption.status = 'ready'
        delete caption.error
        this.refreshPending(caption)
        if (current?.generateFurigana === false) { this.cancelAnnotation(caption.id); delete caption.furiganaStatus }
        else if (current && caption.ja && !caption.jaSegments && !this.annotations.has(caption.id)) this.enqueueAnnotation(caption, current)
        trace('translation.finalized', { id: caption.id, revision: state.revision, chars: caption.original.length, reused: true })
        continue
      }
      // An unchanged final does not invalidate a request already translating those exact words.
      const exact = running?.original === caption.original && compatible(running.config) ? running :
        queued?.original === caption.original && compatible(queued.config) ? queued : undefined
      if (exact) {
        if (exact !== running && running && !caption.original.startsWith(running.original)) {
          this.cancelTranslation(caption.id)
          this.waiting.push(exact)
        }
        this.waiting = this.waiting.filter(job => job.caption !== caption || job === exact)
        state.finalRevision = exact.revision
        if (exact !== running) exact.config = { ...exact.config, partial: false }
        this.refreshPending(caption)
        trace('translation.finalized', { id: caption.id, revision: state.revision, chars: caption.original.length, reused: true })
        continue
      }
      // Preserve a useful prefix, but cancel a genuinely corrected hypothesis.
      const usefulPrefix = running && caption.original.startsWith(running.original)
      if (!usefulPrefix) this.cancelTranslation(caption.id)
      state.finalRevision = ++state.revision
      trace('translation.finalized', { id: caption.id, revision: state.revision, chars: caption.original.length, prefixRetained: Boolean(usefulPrefix) })
      this.enqueue(caption)
    }
    this.changed()
    this.drain()
  }
  private scheduleDraft(caption: Caption): void {
    const state = this.work.get(caption.id)!
    caption.translationPending = true
    if (!this.hasTranslation(caption)) caption.status = 'translating'
    if (state.timer) return
    const delay = state.lastStartedAt === null ? FIRST_DRAFT_DELAY : Math.max(0, state.lastStartedAt + DRAFT_INTERVAL - Date.now())
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (!this.closed && caption.live) this.enqueue(caption)
    }, delay)
    state.timer.unref?.()
  }
  private hasTranslation(caption: Caption): boolean {
    return Boolean(caption.translatedOriginal || caption.zh || caption.en || caption.ja || Object.values(caption.translations || {}).some(Boolean))
  }
  private refreshPending(caption: Caption): void {
    caption.translationPending = Boolean(this.work.get(caption.id)?.timer || this.running.has(caption.id) || this.waiting.some(job => job.caption === caption))
  }
  private cancelTranslation(id: string): void {
    const state = this.work.get(id)
    if (state?.timer) { clearTimeout(state.timer); state.timer = undefined }
    this.waiting = this.waiting.filter(job => job.caption.id !== id)
    const running = this.running.get(id)
    this.running.delete(id)
    if (running) trace('translation.cancelled', { id, revision: running.revision, chars: running.original.length,
      partial: Boolean(running.config.partial), ms: Date.now() - (running.startedAt ?? running.queuedAt) })
    running?.controller.abort()
  }
  private trim(): boolean {
    // Keep pending annotations observable until they settle or reach their deadline.
    // Otherwise the renderer's reading cache could retain a forever-pending copy.
    const unsaved = this.captions.filter(c => !c.saved && !c.live && !c.translationPending && c.status !== 'translating' && c.furiganaStatus !== 'pending')
    if (unsaved.length > 150) {
      const remove = new Set(unsaved.slice(0, unsaved.length - 150).map(c => c.id))
      for (const id of remove) { this.cancelAnnotation(id); this.work.delete(id) }
      this.captions = this.captions.filter(c => !remove.has(c.id))
      return true
    }
    return false
  }
  private enqueue(caption: Caption): void {
    let state = this.work.get(caption.id)
    if (!state) { state = { revision: 1, publishedRevision: 0, lastStartedAt: null, incremental: false }; this.work.set(caption.id, state) }
    if (this.running.get(caption.id)?.revision === state.revision || this.waiting.some(job => job.caption === caption && job.revision === state!.revision)) return
    let config: TranslationConfig
    try {
      const current = this.config()
      const targetLanguages = [...(current.targetLanguages || DEFAULT_LANGUAGES)]
      config = { ...current, targetLanguages, partial: Boolean(caption.live) }
      if (!caption.targetLanguages) caption.targetLanguages = [...targetLanguages]
    } catch (error) {
      caption.status = caption.live && this.hasTranslation(caption) ? 'ready' : 'error'
      caption.error = error instanceof Error ? error.message : '无法读取翻译配置。'
      this.refreshPending(caption)
      this.changed()
      return
    }
    const previous = this.waiting.findIndex(job => job.caption === caption)
    const job: TranslationJob = { caption, original: caption.original, revision: state.revision, config, controller: new AbortController(),
      queuedAt: previous >= 0 ? this.waiting[previous].queuedAt : Date.now() }
    if (previous >= 0) this.waiting.splice(previous, 1, job)
    else {
      if (this.waiting.length >= 20) {
        const skipped = this.waiting.shift()!
        skipped.caption.status = skipped.caption.live && this.hasTranslation(skipped.caption) ? 'ready' : 'error'
        skipped.caption.error = '语句到达过快，原文已保留，可稍后重试翻译。'
        this.refreshPending(skipped.caption)
      }
      this.waiting.push(job)
    }
    caption.translationPending = true
    if (!state.incremental || !this.hasTranslation(caption)) caption.status = 'translating'
    this.changed()
    trace('translation.queued', { id: caption.id, revision: job.revision, chars: job.original.length, partial: Boolean(config.partial), waiting: this.waiting.length, running: this.running.size })
    this.drain()
  }
  retry(id: string): void {
    if (this.closed) return
    const caption = this.captions.find(c => c.id === id)
    if (!caption || caption.live || caption.translationPending || caption.status === 'translating') return
    this.cancelAnnotation(id)
    const state = this.work.get(id)
    if (state) { state.revision++; state.finalRevision = state.incremental ? state.revision : undefined }
    caption.status = state?.incremental && this.hasTranslation(caption) ? 'ready' : 'translating'
    delete caption.error
    this.enqueue(caption)
  }
  toggleSaved(id: string): void {
    const caption = this.captions.find(c => c.id === id)
    if (!caption || caption.live || caption.translationPending || caption.status !== 'ready') return
    if (!caption.saved && this.captions.filter(c => c.saved).length >= 1000) throw new Error('收藏已满 1000 句，请先导出并取消部分收藏。')
    caption.saved = !caption.saved
    try { this.persist(this.captions) }
    catch (error) { caption.saved = !caption.saved; throw error }
    this.changed()
  }
  private drain(): void {
    if (this.closed) return
    while (this.running.size < 2 && this.waiting.length) {
      const index = this.nextWaitingIndex()
      if (index < 0) break
      const job = this.waiting.splice(index, 1)[0]
      const { caption, config, controller } = job
      const state = this.work.get(caption.id)!
      job.startedAt = state.lastStartedAt = Date.now()
      this.running.set(caption.id, job)
      trace('translation.start', { id: caption.id, revision: job.revision, chars: job.original.length, partial: Boolean(config.partial),
        queueMs: job.startedAt - job.queuedAt, waiting: this.waiting.length, running: this.running.size })
      void Promise.resolve().then(() => this.translator(job.original, config, controller.signal))
        .then(result => {
          if (!this.translationCurrent(job)) return
          const sameSource = (caption.translatedOriginal ?? caption.original) === job.original
          const translations = { ...(sameSource ? caption.translations || {} : {}), ...result.translations }
          if (sameSource) {
            if (!translations.zh && caption.zh) translations.zh = caption.zh
            if (!translations.en && caption.en) translations.en = caption.en
            if (!translations.ja && caption.ja) translations.ja = caption.ja
          }
          const receivedJapanese = Object.hasOwn(result.translations, 'ja')
          const changedJapanese = !sameSource || (receivedJapanese && result.ja !== caption.ja)
          const reading = result.reading || (changedJapanese ? '' : caption.reading)
          const jaSegments = result.jaSegments || (changedJapanese ? undefined : caption.jaSegments)
          // Publish useful prefixes without clearing a newer final failure, such as queue eviction.
          const failedFinal = !caption.live && caption.status === 'error' &&
            state.finalRevision !== undefined && job.revision < state.finalRevision
          Object.assign(caption, result, { status: failedFinal ? 'error' : 'ready', translations, reading, jaSegments, translatedOriginal: job.original,
            zh: translations.zh || '', en: translations.en || '', ja: translations.ja || '',
            targetLanguages: [...new Set([...(sameSource ? caption.targetLanguages || [] : []), ...Object.keys(translations).filter(isTargetLanguage)])]
          })
          state.publishedRevision = job.revision
          state.publishedConfig = { baseUrl: config.baseUrl, model: config.model, targetLanguages: [...(config.targetLanguages || DEFAULT_LANGUAGES)] }
          trace('translation.ready', { id: caption.id, revision: job.revision, chars: job.original.length, partial: Boolean(config.partial),
            live: Boolean(caption.live), ms: Date.now() - job.startedAt! })
          if (job.revision === state.revision) delete caption.error
          if (receivedJapanese) {
            if (config.generateFurigana !== false) this.enqueueAnnotation(caption, config)
            else { this.cancelAnnotation(caption.id); delete caption.furiganaStatus }
          } else if (!sameSource) {
            this.cancelAnnotation(caption.id)
            delete caption.furiganaStatus
          }
          // The translation is immediately usable and saved independently of optional annotation.
          if (caption.saved) this.persist(this.captions)
          this.changed()
        }).catch(error => {
          trace('translation.failed', { id: caption.id, revision: job.revision, chars: job.original.length,
            partial: Boolean(config.partial), aborted: controller.signal.aborted, ms: Date.now() - job.startedAt! })
          if (!this.translationCurrent(job)) return
          caption.status = caption.live && this.hasTranslation(caption) ? 'ready' : 'error'
          caption.error = error instanceof Error ? error.message : '翻译失败，请重试。'
        }).finally(() => {
          trace('translation.finished', { id: caption.id, revision: job.revision, ms: Date.now() - job.startedAt!, aborted: controller.signal.aborted })
          if (this.running.get(caption.id) === job) {
            this.running.delete(caption.id)
          }
          this.refreshPending(caption)
          if (!this.closed) {
            // Let retained renderer rows observe completion before history eviction.
            this.changed()
            if (this.trim()) this.changed()
            this.drain()
          }
        })
    }
  }
  private nextWaitingIndex(): number {
    const available = (job: TranslationJob) => !this.running.has(job.caption.id)
    const draft = this.waiting.findIndex(job => available(job) && job.config.partial)
    const final = this.waiting.findIndex(job => available(job) && !job.config.partial)
    if (draft < 0) return final
    if (final < 0) return draft
    // With both classes waiting, one slot serves fresh drafts and one serves finals/history.
    // Neither a long history backlog nor continuous live updates can starve the other class.
    return [...this.running.values()].some(job => job.config.partial) ? final : draft
  }
  private translationCurrent(job: TranslationJob): boolean {
    const state = this.work.get(job.caption.id)
    return !this.closed && !job.controller.signal.aborted && this.running.get(job.caption.id) === job &&
      Boolean(state && job.revision > state.publishedRevision && (state.finalRevision === undefined || job.revision >= state.finalRevision ||
        job.caption.original.startsWith(job.original)))
  }
  private cancelAnnotation(id: string): void {
    const job = this.annotations.get(id)
    if (!job) return
    this.annotations.delete(id)
    this.annotationWaiting = this.annotationWaiting.filter(item => item !== job)
    this.annotationRunning.delete(job)
    clearTimeout(job.timeout)
    job.controller.abort()
    if (job.caption.furiganaStatus === 'pending') job.caption.furiganaStatus = 'error'
  }
  private enqueueAnnotation(caption: Caption, config: TranslationConfig): void {
    this.cancelAnnotation(caption.id)
    if (this.annotationWaiting.length >= 20) this.cancelAnnotation(this.annotationWaiting[0].caption.id)
    const controller = new AbortController()
    const job: AnnotationJob = { caption, original: caption.translatedOriginal || caption.original, japanese: caption.ja, config, controller,
      timeout: setTimeout(() => {
        if (this.annotations.get(caption.id) !== job) return
        this.cancelAnnotation(caption.id)
        if (!this.closed) { this.changed(); this.drainAnnotations() }
      }, 25_000)
    }
    job.timeout.unref?.()
    caption.furiganaStatus = 'pending'
    this.annotations.set(caption.id, job)
    this.annotationWaiting.push(job)
    this.drainAnnotations()
  }
  private drainAnnotations(): void {
    if (this.closed) return
    while (this.annotationRunning.size < 2 && this.annotationWaiting.length) {
      const job = this.annotationWaiting.shift()!
      if (this.annotations.get(job.caption.id) !== job) continue
      this.annotationRunning.add(job)
      void Promise.resolve().then(() => this.annotator(job.original, job.japanese, job.config, job.controller.signal))
        .then(result => {
          if (!this.annotationCurrent(job)) return
          Object.assign(job.caption, result, { furiganaStatus: 'ready' })
          if (job.caption.saved) this.persist(this.captions)
        }).catch(() => {
          // Annotation is optional; it must never change a valid translation into an error.
          if (this.annotationCurrent(job)) job.caption.furiganaStatus = 'error'
        }).finally(() => {
          clearTimeout(job.timeout)
          this.annotationRunning.delete(job)
          if (this.annotations.get(job.caption.id) === job) this.annotations.delete(job.caption.id)
          // Publish the final annotation state before a later add can evict it.
          if (!this.closed) { this.changed(); this.drainAnnotations() }
        })
    }
  }
  private annotationCurrent(job: AnnotationJob): boolean {
    return !this.closed && !job.controller.signal.aborted && this.annotations.get(job.caption.id) === job &&
      this.captions.includes(job.caption) && job.caption.ja === job.japanese
  }
  close(): void {
    this.closed = true
    this.waiting = []
    for (const state of this.work.values()) if (state.timer) clearTimeout(state.timer)
    this.utterances.clear()
    for (const job of this.running.values()) job.controller.abort()
    for (const id of this.annotations.keys()) this.cancelAnnotation(id)
  }
}
