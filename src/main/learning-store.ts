import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Caption } from '../shared/types'
import { learningOriginal, validPhrase, type LearningRecord, type LearningSession, type LearningState } from '../shared/learning'

type Document = { schema: 1; sessions: LearningSession[]; records: LearningRecord[] }
export const sourceFingerprint = (caption: Caption) => createHash('sha256').update(JSON.stringify([caption.source, caption.language, caption.original])).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000

/** Local metadata only. saved.json remains the sole source of persisted sentences. */
export class LearningStore {
  private document: Document = { schema: 1, sessions: [], records: [] }
  private current: string | null = null
  private warning = ''
  private diskSignature: string | null = null
  private readonly path: string
  constructor(directory: string) {
    this.path = join(directory, 'learning-v1.json')
    if (!existsSync(this.path)) return
    try {
      if (statSync(this.path).size > 32 * 1024 * 1024) throw new Error('oversize')
      const contents = readFileSync(this.path, 'utf8')
      this.diskSignature = createHash('sha256').update(contents).digest('hex')
      const raw: unknown = JSON.parse(contents)
      if (!object(raw) || raw.schema !== 1) { this.warning = '学习记录版本不受支持，已只读保留；普通收藏仍可使用。'; return }
      if (!Array.isArray(raw.sessions) || !Array.isArray(raw.records) || raw.sessions.length > 100 || raw.records.length > 1000) throw new Error('invalid')
      const sessions: LearningSession[] = []
      for (const item of raw.sessions) {
        if (!object(item) || !text(item.id, 100) || !item.id || !text(item.name, 80) || !time(item.startedAt) || (item.endedAt !== undefined && (!time(item.endedAt) || item.endedAt < item.startedAt))) throw new Error('invalid')
        if (sessions.some(session => session.id === item.id)) throw new Error('duplicate')
        sessions.push({ id: item.id, name: item.name, startedAt: item.startedAt, ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }) })
      }
      const records: LearningRecord[] = []
      for (const item of raw.records) {
        if (!object(item) || !text(item.captionId, 200) || !item.captionId || !text(item.fingerprint, 64) || !/^[a-f0-9]{64}$/.test(item.fingerprint) || !time(item.savedAt) || !text(item.note, 2000) || !Array.isArray(item.phrases) || item.phrases.length > 20 || !(item.sessionId === null || sessions.some(session => session.id === item.sessionId))) throw new Error('invalid')
        const phrases = item.phrases.map(value => {
          if (!object(value) || !Number.isInteger(value.start) || !Number.isInteger(value.end) || Number(value.start) < 0 || Number(value.end) <= Number(value.start) || Number(value.end) > 8000 || !text(value.exact, 1000)) throw new Error('invalid')
          return { start: Number(value.start), end: Number(value.end), exact: value.exact }
        })
        if (records.some(record => record.captionId === item.captionId)) throw new Error('duplicate')
        records.push({ captionId: item.captionId, fingerprint: item.fingerprint, sessionId: item.sessionId as string | null, savedAt: item.savedAt, phrases, note: item.note })
      }
      this.document = { schema: 1, sessions, records }
    } catch { this.warning = '学习记录无法读取或格式无效，已只读保留；普通收藏仍可使用。' }
  }
  snapshot(captions: Caption[]): LearningState {
    const saved = new Map(captions.filter(caption => caption.saved).map(caption => [caption.id, caption]))
    return structuredClone({ sessions: this.document.sessions, records: this.document.records.filter(record => {
      const caption = saved.get(record.captionId)
      return caption && sourceFingerprint(caption) === record.fingerprint && learningOriginal(caption) === caption.original && record.phrases.every(phrase => validPhrase(caption.original, phrase))
    }), unanchoredIds: this.document.records.filter(record => { const caption = saved.get(record.captionId); return caption && (sourceFingerprint(caption) !== record.fingerprint || learningOriginal(caption) !== caption.original || !record.phrases.every(phrase => validPhrase(caption.original, phrase))) }).map(record => record.captionId), currentSessionId: this.current, warning: this.warning, shortcutAvailable: true })
  }
  private commit(next: Document): void {
    if (this.warning) throw new Error(this.warning)
    if (existsSync(this.path) && statSync(this.path).size > 32 * 1024 * 1024) throw new Error('学习记录超过读取上限，未覆盖文件。')
    const actual = existsSync(this.path) ? createHash('sha256').update(readFileSync(this.path)).digest('hex') : null
    if (actual !== this.diskSignature) throw new Error('学习记录已被其他进程修改，未覆盖文件；请重启后重试。')
    const payload = JSON.stringify(next, null, 2)
    // Synchronous transactions serialize IPC updates. Commit memory only after durable temp + rename.
    const temporary = `${this.path}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, payload, 'utf8'); fsyncSync(descriptor)
      closeSync(descriptor); descriptor = undefined
      renameSync(temporary, this.path)
      this.document = next
      this.diskSignature = createHash('sha256').update(payload).digest('hex')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* A renamed temp no longer exists. */ }
    }
  }
  session(name: string | null, captions: Caption[]): void {
    const now = Date.now()
    const sessions = this.document.sessions.map(session => session.id === this.current ? { ...session, endedAt: now } : session)
    let current: string | null = null
    if (name !== null) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('会话名称需要 1–80 个字符。')
      if (sessions.length >= 100) throw new Error('学习会话已满 100 个；现有会话和收藏仍可阅读。')
      current = randomUUID(); sessions.push({ id: current, name: name.trim(), startedAt: now })
    }
    this.commit({ schema: 1, sessions, records: this.snapshot(captions).records }); this.current = current
  }
  put(caption: Caption, phrases: unknown, note: unknown, captions: Caption[]): void {
    if (learningOriginal(caption) !== caption.original) throw new Error('原文版本未对齐，暂不能绑定短语。')
    if (!Array.isArray(phrases) || phrases.length > 20 || !phrases.every(phrase => validPhrase(caption.original, phrase)) || typeof note !== 'string' || note.length > 2000) throw new Error('短语范围或笔记无效；请按完整字符重新选择。')
    const previous = this.document.records.find(record => record.captionId === caption.id && record.fingerprint === sourceFingerprint(caption))
    const record: LearningRecord = { captionId: caption.id, fingerprint: sourceFingerprint(caption), sessionId: previous ? previous.sessionId : this.current, savedAt: previous?.savedAt ?? Date.now(),
      phrases: phrases.map(({ start, end, exact }) => ({ start, end, exact })), note }
    const records = this.snapshot(captions).records.filter(record => record.captionId !== caption.id).concat(record)
    if (records.length > 1000) throw new Error('学习记录已满。')
    this.commit({ ...this.document, records })
  }
  remove(id: string, captions: Caption[]): void {
    this.commit({ ...this.document, records: this.snapshot(captions).records.filter(record => record.captionId !== id) })
  }
  attachSession(caption: Caption, captions: Caption[]): void {
    if (this.current && !this.snapshot(captions).records.some(record => record.captionId === caption.id)) this.put(caption, [], '', captions)
  }
}
