import type { Caption, Settings } from '../shared/types'
import { learningTarget, saveEligible, validTarget, validPhrase, learningOriginal, learningSourceVersion, type LearningEdit, type LearningResult } from '../shared/learning'
import { LearningStore } from './learning-store'

type Queue = { captions: Caption[]; toggleSaved(id: string): void }
export class DesktopLearning {
  shortcutAvailable = true
  constructor(readonly store: LearningStore, private queue: Queue, private settings: () => Settings, private visible: () => boolean, private changed: () => void) {}
  snapshot() { return { ...this.store.snapshot(this.queue.captions), shortcutAvailable: this.shortcutAvailable } }
  private target(value: unknown, existingNotes = false): Caption | null {
    if (!validTarget(value)) return null
    const caption = this.queue.captions.find(caption => caption.id === value.id)
    return caption && (learningTarget(caption, this.settings()).version === value.version || (existingNotes && caption.saved && value.sourceVersion === learningSourceVersion(caption))) ? caption : null
  }
  pin(value: unknown): LearningResult {
    if (!this.visible()) return { kind: 'unavailable', message: '窗口不可见，暂未收藏。' }
    const caption = this.target(value)
    if (!caption) return { kind: 'changed', message: '目标已变化，暂未收藏。' }
    if (!saveEligible(caption)) return { kind: 'incomplete', message: '这句尚未完成，暂未收藏。' }
    if (caption.saved) return { kind: 'already', message: '已经收藏' }
    this.queue.toggleSaved(caption.id)
    if (!caption.saved) throw new Error('收藏未完成，请重试。')
    try { this.store.attachSession(caption, this.queue.captions) }
    catch { this.changed(); return { kind: 'partial', message: '句子已收藏，会话记录未保存。请在会话匣查看。' } }
    this.changed(); return { kind: 'saved', message: '已收藏' }
  }
  save(value: unknown): LearningResult {
    if (!value || typeof value !== 'object') throw new Error('学习记录格式无效。')
    const edit = value as LearningEdit
    // Validate before persisting the ordinary favorite, including grapheme spans in the store.
    const caption = this.target(edit.target, true)
    if (!caption) return { kind: 'changed', message: '目标已变化，草稿仍保留；请核对原文后重新打开。' }
    if (!saveEligible(caption)) return { kind: 'incomplete', message: '这句尚未完成，暂未收藏；草稿仅保留在内存。' }
    if (!Array.isArray(edit.phrases) || edit.phrases.length > 20 || !edit.phrases.every(phrase => validPhrase(learningOriginal(caption), phrase)) || typeof edit.note !== 'string' || edit.note.length > 2000) throw new Error('短语范围或笔记无效。')
    if (!this.visible()) return { kind: 'unavailable', message: '窗口不可见，草稿尚未保存。' }
    if (!caption.saved) this.queue.toggleSaved(caption.id)
    if (!caption.saved) throw new Error('收藏未完成，请重试。')
    try { this.store.put(caption, edit.phrases, edit.note, this.queue.captions) }
    catch (error) { this.changed(); return { kind: 'partial', message: `句子已收藏，笔记未保存：${error instanceof Error ? error.message : '写入失败'}` } }
    this.changed(); return { kind: 'saved', message: '句子与笔记已保存' }
  }
  toggleSaved(id: string): void {
    const caption = this.queue.captions.find(caption => caption.id === id)
    if (!caption) return
    const wasSaved = caption.saved
    this.queue.toggleSaved(id)
    if (wasSaved && !caption.saved) {
      try { this.store.remove(id, this.queue.captions) }
      catch (error) { this.changed(); throw new Error(`已取消收藏，学习记录未清理（不会显示或导出）：${error instanceof Error ? error.message : '写入失败'}`) }
    } else if (!wasSaved && caption.saved) {
      try { this.store.attachSession(caption, this.queue.captions) }
      catch { this.changed(); throw new Error('句子已收藏，会话记录未保存。') }
    }
    this.changed()
  }
}
