import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
const fault = vi.hoisted(() => ({ rename: false, sync: false }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => { if (fault.rename) { fault.rename = false; throw new Error('synthetic write failure') }; return actual.renameSync(...args) },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => { if (fault.sync) { fault.sync = false; throw new Error('synthetic interrupted write') }; return actual.fsyncSync(...args) } }
})
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore, sourceFingerprint } from '../src/main/learning-store'
import { DesktopLearning } from '../src/main/learning'
import { learningOriginal, learningTarget, validPhrase, type LearningRecord } from '../src/shared/learning'
import { learningMarkdown } from '../src/main/learning-export'
import type { Caption, Settings } from '../src/shared/types'

const directories: string[] = []
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'lingobar-study-')); directories.push(value); return value }
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })) })
const settings = { targetLanguages: ['zh', 'ja'], showFurigana: true } as Settings
const caption = (id = 'synthetic-1'): Caption => ({ id, source: 'text', original: 'pick it up 日本語 👩🏽‍💻 é', language: 'English', zh: '把它拿起来', en: '', ja: '拾って', reading: '', translations: { zh: '把它拿起来', ja: '拾って' }, targetLanguages: ['zh', 'ja'], createdAt: 1, status: 'ready', saved: false })
function fixture() {
  const path = directory(), store = new LearningStore(path), captions = [caption()]
  const persist = vi.fn()
  const queue = { captions, toggleSaved: vi.fn((id: string) => {
    const item = captions.find(item => item.id === id)!
    if (!item.saved && captions.filter(item => item.saved).length >= 1000) throw new Error('收藏已满 1000 句')
    const previous = item.saved
    item.saved = !item.saved
    try { persist(captions) } catch (error) { item.saved = previous; throw error }
  }) }
  let visible = true
  const changed = vi.fn(), learning = new DesktopLearning(store, queue, () => settings, () => visible, changed)
  return { path, store, captions, persist, queue, learning, changed, visible: (value: boolean) => { visible = value } }
}

describe('explicit desktop learning actions with zero provider/audio access', () => {
  it('pins the displayed exact id and revision idempotently, without collapsing equal-text encounters', async () => {
    const f = fixture(), one = f.captions[0], target = learningTarget(one, settings)
    expect((await Promise.all([Promise.resolve(f.learning.pin(target)), Promise.resolve(f.learning.pin(target))])).map(result => result.kind)).toEqual(['saved', 'already'])
    expect(f.queue.toggleSaved).toHaveBeenCalledTimes(1)
    f.captions.push(caption('different-encounter'))
    expect(f.learning.pin(learningTarget(f.captions[1], settings)).kind).toBe('saved')
    expect(f.captions.filter(item => item.saved)).toHaveLength(2)
  })
  it.each(['hidden', 'minimized', 'no-target', 'preview', 'evicted', 'revision', 'language', 'ruby'])('rejects %s without falling back to another ready caption', condition => {
    const f = fixture(), target = learningTarget(f.captions[0], settings)
    if (condition === 'hidden' || condition === 'minimized') f.visible(false)
    if (condition === 'preview') target.id = 'preview-only'
    if (condition === 'evicted') f.captions.splice(0, 1)
    if (condition === 'revision') f.captions[0].original += '!'
    if (condition === 'language') f.captions[0].translations!.zh = '不同版本'
    if (condition === 'ruby') f.captions[0].jaSegments = [{ text: '拾って', reading: 'ひろって' }]
    f.captions.push(caption('other-ready'))
    expect(f.learning.pin(condition === 'no-target' ? null : target).kind).toMatch(/changed|unavailable/)
    expect(f.persist).not.toHaveBeenCalled()
  })
  it.each(['live', 'pending', 'translating', 'error', 'empty'])('does not persist %s or schedule a later save', mode => {
    const f = fixture(), item = f.captions[0]
    if (mode === 'live') item.live = true
    if (mode === 'pending') item.translationPending = true
    if (mode === 'translating' || mode === 'error') item.status = mode
    if (mode === 'empty') { item.zh = ''; item.ja = ''; item.translations = {} }
    expect(f.learning.pin(learningTarget(item, settings)).kind).toBe('incomplete')
    item.live = false; item.translationPending = false; item.status = 'ready'
    expect(f.persist).not.toHaveBeenCalled(); expect(item.saved).toBe(false)
  })
  it('reports favorite disk failure and capacity without a sidecar or false success', () => {
    const f = fixture(), item = f.captions[0]
    f.persist.mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => f.learning.pin(learningTarget(item, settings))).toThrow('disk unavailable')
    expect(item.saved).toBe(false); expect(readdirSync(f.path)).toEqual([])
    for (let i = 0; i < 1000; i++) f.captions.push({ ...caption(`saved-${i}`), saved: true })
    expect(() => f.learning.pin(learningTarget(item, settings))).toThrow('1000')
    expect(item.saved).toBe(false)
  })
  it('preserves ordinary favorite when sidecar rename fails and retains the previous atomic document', () => {
    const f = fixture(), item = f.captions[0]
    f.store.session('Synthetic session', f.captions)
    const before = readFileSync(join(f.path, 'learning-v1.json'), 'utf8')
    fault.rename = true
    expect(f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'synthetic note' }).kind).toBe('partial')
    expect(item.saved).toBe(true)
    expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).toBe(before)
    expect(readdirSync(f.path)).toEqual(['learning-v1.json'])
    expect(f.learning.snapshot().records).toEqual([])
  })
  it('retains the previous document if interrupted before rename and ignores abandoned temporary files', () => {
    const f = fixture(), item = f.captions[0]
    f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'committed' })
    const previous = readFileSync(join(f.path, 'learning-v1.json'), 'utf8')
    fault.sync = true
    expect(f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'uncommitted' }).kind).toBe('partial')
    expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).toBe(previous)
    writeFileSync(join(f.path, 'learning-v1.json.abandoned.tmp'), '{uncommitted')
    expect(new LearningStore(f.path).snapshot(f.captions).records[0].note).toBe('committed')
  })
  it('rejects malformed edits before saving and preserves session ownership when revising existing notes', () => {
    const f = fixture(), item = f.captions[0]
    expect(() => f.learning.save({ target: learningTarget(item, settings), phrases: [{ start: 0, end: 1, exact: 'wrong' }], note: '' })).toThrow('无效')
    expect(f.persist).not.toHaveBeenCalled()
    f.store.session('first', f.captions)
    const first = f.learning.snapshot().currentSessionId
    f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'first note' })
    f.store.session('second', f.captions)
    f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'revised note' })
    expect(f.learning.snapshot().records[0].sessionId).toBe(first)
    expect(f.learning.snapshot().sessions[0].endedAt).toBeTypeOf('number')
    f.store.session(null, f.captions)
    expect(f.learning.snapshot().currentSessionId).toBe(null)
  })
  it('serializes independent edits, strips unknown fields, and restores notes without auto-restoring a session', async () => {
    const f = fixture(), item = f.captions[0]
    f.store.session('Synthetic session', f.captions)
    const edit = { target: learningTarget(item, settings), phrases: [{ start: 0, end: 10, exact: 'pick it up', secret: 'discard' }], note: 'read later', extra: 'discard' }
    expect(f.learning.save(edit).kind).toBe('saved')
    f.captions.push(caption('second'))
    f.learning.save({ target: learningTarget(f.captions[1], settings), phrases: [], note: 'second' })
    const reloaded = new LearningStore(f.path).snapshot(f.captions)
    expect(reloaded.records).toHaveLength(2); expect(reloaded.currentSessionId).toBe(null)
    expect(reloaded.records[0].phrases).toEqual([{ start: 0, end: 10, exact: 'pick it up' }])
    expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).not.toContain('discard')
    expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).not.toContain('original')
  })
  it('cleans writable sidecar on unsave, excludes it from export and ignores orphan records after restart', () => {
    const f = fixture(), item = f.captions[0]
    f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'deleted note' })
    f.learning.toggleSaved(item.id)
    expect(f.learning.snapshot().records).toEqual([])
    expect(learningMarkdown(item.id, f.learning.snapshot().records)).toBe('')
    expect(new LearningStore(f.path).snapshot(f.captions).records).toEqual([])
  })
  it('does not attach source-mismatched metadata or unsafe offsets; explicit later writes clean orphans', () => {
    const f = fixture(), item = f.captions[0]
    f.learning.save({ target: learningTarget(item, settings), phrases: [{ start: 0, end: 10, exact: 'pick it up' }], note: 'note' })
    item.original = 'different source'
    expect(f.learning.snapshot().records).toEqual([])
    f.store.session('next', f.captions)
    expect(JSON.parse(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).records).toEqual([])
    item.translatedOriginal = 'old source'
    expect(learningOriginal(item)).toBe('old source')
    expect(f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'new' }).kind).toBe('incomplete')
    expect(f.learning.snapshot().unanchoredIds).toEqual([])
    expect(() => f.store.put(item, [], 'new', f.captions)).toThrow('未对齐')
  })
  it.each(['corrupt', 'higher'])('keeps %s sidecar unchanged and ordinary favorites usable', mode => {
    const path = directory(), raw = mode === 'corrupt' ? '{broken' : JSON.stringify({ schema: 42, records: [{ private: 'untouched' }] })
    writeFileSync(join(path, 'learning-v1.json'), raw)
    const item = { ...caption(), saved: true }, store = new LearningStore(path)
    expect(store.snapshot([item]).warning).toMatch(/只读/)
    expect(store.snapshot([item]).records).toEqual([])
    expect(() => store.put(item, [], 'note', [item])).toThrow()
    expect(() => store.remove(item.id, [])).toThrow()
    expect(readFileSync(join(path, 'learning-v1.json'), 'utf8')).toBe(raw)
    expect(sourceFingerprint(item)).toMatch(/^[a-f0-9]{64}$/)
  })
  it('does not overwrite a concurrently changed or higher-version file after startup', () => {
    const f = fixture(), item = f.captions[0]
    f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'first' })
    const future = '{"schema":50,"future":"must remain"}'
    writeFileSync(join(f.path, 'learning-v1.json'), future)
    expect(f.learning.save({ target: learningTarget(item, settings), phrases: [], note: 'second' }).kind).toBe('partial')
    expect(readFileSync(join(f.path, 'learning-v1.json'), 'utf8')).toBe(future)
    expect(f.learning.snapshot().records[0].note).toBe('first')
  })
  it('allows source-identical notes on an existing favorite after late ruby, but still rejects stale QuickPin', () => {
    const f = fixture(), item = f.captions[0], target = learningTarget(item, settings)
    f.learning.pin(target)
    item.jaSegments = [{ text: '拾って', reading: 'ひろって' }]
    expect(f.learning.pin(target).kind).toBe('changed')
    expect(f.learning.save({ target, phrases: [], note: 'source-bound note' }).kind).toBe('saved')
    item.original += 'changed'
    expect(f.learning.save({ target, phrases: [], note: 'must not bind' }).kind).toBe('changed')
  })
  it('does not create any persistent in-memory draft on opening/reloading', () => {
    const f = fixture()
    f.learning.snapshot(); new LearningStore(f.path)
    expect(readdirSync(f.path)).toEqual([])
  })
})

describe('UTF-16 exact contiguous phrases and local Markdown', () => {
  it.each([
    ['pick it up', 0, 10, true], ['日本語', 1, 3, true], ['é', 0, 1, false], ['é', 0, 2, true],
    ['🙂', 0, 1, false], ['🙂', 0, 2, true], ['👩🏽‍💻', 0, 2, false], ['👩🏽‍💻', 0, 7, true],
    ['word word', 5, 9, true], ['a', -1, 1, false], ['a', 0, 2, false], ['a', 0, 0, false],
  ])('validates %j [%i,%i)', (source, start, end, valid) => expect(validPhrase(source, { start, end, exact: source.slice(start, end) })).toBe(valid))
  it('refuses guessed text and exports only saved attached metadata with safe text', () => {
    expect(validPhrase('word word', { start: 0, end: 4, exact: 'other' })).toBe(false)
    const record: LearningRecord = { captionId: 'id', fingerprint: 'x', sessionId: null, savedAt: 1, phrases: [{ start: 5, end: 9, exact: 'word' }], note: '<script>synthetic</script>\nnext' }
    expect(learningMarkdown('id', [record])).toContain('5–9\n> word')
    expect(learningMarkdown('id', [record])).toContain('&lt;script&gt;')
    expect(learningMarkdown('different', [record])).toBe('')
  })
})
