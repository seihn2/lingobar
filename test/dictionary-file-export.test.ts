import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { DictionaryStore } from '../src/main/dictionary-store'
import { commitDictionaryExport } from '../src/main/dictionary-file-export'
const paths: string[] = []
afterEach(() => paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
const fixture = () => { const path = mkdtempSync(join(tmpdir(), 'dictionary-export-')); paths.push(path); return { path, store: new DictionaryStore(path) } }
it('does not overwrite an existing destination if data changes while writing the export', async () => {
  const { path, store } = fixture(), destination = join(path, 'existing.md')
  writeFileSync(destination, 'existing synthetic file')
  const document = { id: 'encounter', createdAt: 1, favorite: false, note: '', source: { text: 'synthetic example', language: 'English', sourceType: 'text' as const, provenance: 'user-input' as const, captionId: null, displayedVersion: null, sourceVersion: null, span: { start: 0, end: 9, exact: 'synthetic' } }, explanations: [], attempts: [] }
  store.createEncounter(document)
  let continueWrite!: () => void
  const rename = vi.fn(), remove = vi.fn()
  const exporting = commitDictionaryExport(store, destination, 'markdown', { write: () => new Promise(resolve => { continueWrite = resolve }), rename, remove })
  store.remove('encounter'); continueWrite()
  expect((await exporting).saved).toBe(false)
  expect(rename).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledOnce()
  expect(readFileSync(destination, 'utf8')).toBe('existing synthetic file')
})
it('commits a consistent JSON snapshot and cleans up after a failed writer', async () => {
  const { path, store } = fixture(), destination = join(path, 'history.json')
  expect((await commitDictionaryExport(store, destination, 'json')).saved).toBe(true)
  expect(JSON.parse(readFileSync(destination, 'utf8')).schemaVersion).toBe(1)
  const remove = vi.fn()
  await expect(commitDictionaryExport(store, destination, 'json', { write: async () => { throw new Error('synthetic fail') }, rename: vi.fn(), remove })).rejects.toThrow('synthetic fail')
  expect(remove).toHaveBeenCalledOnce()
})
