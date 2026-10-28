import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '../src/main/storage'
import { LearningStore } from '../src/main/learning-store'
import type { Caption } from '../src/shared/types'
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const paths: string[] = []
afterEach(() => paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
const fixture = (): Caption => ({ id: 'old-synthetic', source: 'text', original: '日本語の合成例', language: 'Japanese', zh: '合成例子', en: '', ja: '日本語の合成例', reading: 'にほんごのごうせいれい', jaSegments: [{ text: '日本語', reading: 'にほんご' }, { text: 'の' }, { text: '合成例', reading: 'ごうせいれい' }], translations: { zh: '合成例子', ja: '日本語の合成例' }, targetLanguages: ['zh', 'ja'], createdAt: 123, saved: true, status: 'ready' })
it('round-trips existing saved.json through upgrade, sidecar edits and downgrade without rewriting it', () => {
  const path = mkdtempSync(join(tmpdir(), 'lingobar-compat-')); paths.push(path)
  const storage = new Storage(path); storage.saveCaptions([fixture()])
  const original = readFileSync(join(path, 'saved.json'), 'utf8'), saved = storage.saved()
  const store = new LearningStore(path)
  expect(store.snapshot(saved).records).toEqual([])
  expect(readFileSync(join(path, 'saved.json'), 'utf8')).toBe(original)
  store.session('合成会话', saved); store.put(saved[0], [{ start: 0, end: 3, exact: '日本語' }], '合成笔记', saved)
  expect(readFileSync(join(path, 'saved.json'), 'utf8')).toBe(original)
  const downgraded = new Storage(path).saved()
  expect(downgraded).toEqual(saved)
  expect(downgraded[0].jaSegments).toEqual(fixture().jaSegments)
  expect(new LearningStore(path).snapshot(downgraded).records[0].note).toBe('合成笔记')
  writeFileSync(join(path, 'learning-v1.json'), '{"schema":999,"future":"preserve"}')
  expect(new Storage(path).saved()).toEqual(saved)
  expect(new LearningStore(path).snapshot(saved).warning).toContain('只读')
})
