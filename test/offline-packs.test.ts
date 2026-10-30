import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflinePacks } from '../src/main/offline-packs'

const require = createRequire(import.meta.url)
const { buildDictionaryPack } = require('../scripts/build-dictionary-pack.cjs')
const directories: string[] = [], managers: OfflinePacks[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'lingobar-offline-engine-')); directories.push(path); return path }
const manager = (path: string) => { const value = new OfflinePacks(path); managers.push(value); return value }
const records = (definition = 'Authored test definition.') => [
  { word: 'cafe\u0301', lang_code: 'fr', pos: 'noun', forms: [{ form: 'cafés', tags: ['plural'] }], sounds: [{ ipa: '/test-only/' }], senses: [{ glosses: [definition] }, { glosses: ['Separate authored sense.'] }] },
  { word: 'allé', lang_code: 'fr', pos: 'verb', senses: [{ glosses: ['Authored inflection.'], form_of: [{ word: 'aller' }] }] },
  { word: 'aller', lang_code: 'fr', pos: 'verb', senses: [{ glosses: ['Authored lemma.'] }] }
]
async function pack(id = 'test-fr', version = 'test-v1', glossLanguage = 'en', definition?: string, sourceRecords?: unknown[]) {
  const dir = directory(), input = join(dir, 'source.jsonl'), output = join(dir, 'pack')
  writeFileSync(input, (sourceRecords || records(definition)).map(record => JSON.stringify(record)).join('\n'))
  await buildDictionaryPack({ input, output, manifest: { packId: id, version, sourceLanguage: 'fr', glossLanguage, sourceName: 'Authored fixture', sourceUrl: 'https://example.test/source', sourceRevision: version,
    license: 'CC0-1.0 (authored test only)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Authored test data, not a real dictionary.' } })
  return join(output, 'manifest.json')
}
afterEach(() => { for (const value of managers.splice(0)) value.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllGlobals() })

describe('local read-only dictionary packs', () => {
  it('does not create state just by starting or looking up without installed data', () => {
    const state = join(directory(), 'not-created'), packs = manager(state)
    expect(packs.list()).toEqual([])
    expect(packs.lookup({ text: 'bonjour', language: 'fr' }).results).toEqual([])
    expect(existsSync(state)).toBe(false)
  })
  it('installs, separates sources/senses, finds NFC and explicitly indexed forms without network', async () => {
    const network = vi.fn(() => { throw new Error('Network forbidden') }); vi.stubGlobal('fetch', network)
    const state = join(directory(), 'installed'), packs = manager(state), first = await pack(), second = await pack('other-fr')
    expect(packs.install(first).enabled).toBe(true); packs.install(second)
    const exact = packs.lookup({ text: 'cafe\u0301', language: 'fr' })
    expect(exact.results).toHaveLength(2)
    expect(exact.results.map(result => result.pack.packId)).toEqual(['test-fr', 'other-fr'])
    expect(exact.results.every(result => result.matchPath === 'exact' && result.entry.senses.length === 2)).toBe(true)
    expect(exact.message).toContain('暂无中文释义')
    const normalized = packs.lookup({ text: 'café', language: 'fr', glossLanguage: 'en' })
    expect(normalized.results.every(result => result.matchPath === 'nfc' && result.entry.headword === 'cafe\u0301')).toBe(true)
    expect(packs.lookup({ text: 'cafés', language: 'fr' }).results.every(result => result.matchPath === 'form')).toBe(true)
    const reverse = packs.lookup({ text: 'allé', language: 'fr' }).results
    expect(reverse.some(result => result.entry.headword === 'aller' && result.matchPath === 'form')).toBe(true)
    expect(packs.lookup({ text: 'invented-stem', language: 'fr' }).results).toEqual([])
    expect(network).not.toHaveBeenCalled()
  })
  it('retains enablement across update and restart, swaps whole versions, and leaves detached snapshots unchanged', async () => {
    const state = join(directory(), 'installed'), packs = manager(state), source = await pack()
    packs.install(source)
    const snapshot = packs.lookup({ text: 'café', language: 'fr' }).results[0]
    packs.setEnabled('test-fr', false)
    packs.install(await pack('test-fr', 'test-v2', 'en', 'Authored changed definition.'))
    expect(packs.list()[0]).toMatchObject({ enabled: false, manifest: { version: 'test-v2' } })
    expect(packs.lookup({ text: 'café', language: 'fr' }).results).toEqual([])
    packs.close()
    const reopened = manager(state)
    expect(reopened.list()[0].enabled).toBe(false)
    reopened.setEnabled('test-fr', true)
    expect(reopened.lookup({ text: 'café', language: 'fr' }).results[0].entry.senses[0].glosses).toEqual(['Authored changed definition.'])
    expect(snapshot.entry.senses[0].glosses).toEqual(['Authored test definition.'])
    reopened.uninstall('test-fr')
    expect(reopened.list()).toEqual([]); expect(manager(state).list()).toEqual([])
    expect(snapshot.pack.version).toBe('test-v1')
  })
  it('does not switch an installed version when the new package digest is invalid', async () => {
    const packs = manager(join(directory(), 'installed')); packs.install(await pack())
    const invalid = await pack('test-fr', 'test-v2')
    const manifest = JSON.parse(readFileSync(invalid, 'utf8')); manifest.dbSha256 = '0'.repeat(64); writeFileSync(invalid, JSON.stringify(manifest))
    expect(() => packs.install(invalid)).toThrow()
    expect(packs.list()[0].manifest.version).toBe('test-v1')
    expect(packs.lookup({ text: 'café', language: 'fr' }).results).toHaveLength(1)
  })
  it('preserves unknown registry schemas and refuses to replace them', async () => {
    const state = directory(), original = '{"schemaVersion":99,"packs":[]}'
    writeFileSync(join(state, 'installed.json'), original)
    const packs = manager(state)
    expect(packs.warning).toContain('保留原文件'); expect(packs.list()).toEqual([])
    expect(() => packs.install(join(state, 'manifest.json'))).toThrow('保留原文件')
    expect(readFileSync(join(state, 'installed.json'), 'utf8')).toBe(original)
  })
  it('can prefer a real installed Chinese-definition source without altering other sources', async () => {
    const packs = manager(join(directory(), 'installed')); packs.install(await pack('english-fr')); packs.install(await pack('chinese-fr', 'test-v1', 'zh', '自写测试释义。'))
    const result = packs.lookup({ text: 'café', language: 'fr', glossLanguage: 'zh' })
    expect(result.results[0].pack.packId).toBe('chinese-fr')
    expect(result.results[1].pack.packId).toBe('english-fr'); expect(result.message).not.toContain('暂无中文释义')
  })
  it('deduplicates exact/NFC overlap while retaining distinct original entries, source order and senses', async () => {
    const packs = manager(join(directory(), 'installed'))
    packs.install(await pack('canonical-fr', 'v1', 'en', undefined, [
      { word: 'cafe\u0301', lang_code: 'fr', senses: [{ glosses: ['First original spelling, first sense.'] }, { glosses: ['First original spelling, second sense.'] }] },
      { word: 'café', lang_code: 'fr', senses: [{ glosses: ['Second original spelling, independent entry.'] }] }
    ]))
    for (const spelling of ['cafe\u0301', 'café']) {
      const hits = packs.lookup({ text: spelling, language: 'fr' }).results
      expect(hits.map(hit => hit.entry.id)).toEqual(['line:1', 'line:2'])
      expect(hits.map(hit => hit.entry.headword)).toEqual(['cafe\u0301', 'café'])
      expect(hits.map(hit => hit.matchPath)).toEqual(spelling === 'café' ? ['nfc', 'exact'] : ['exact', 'nfc'])
      expect(hits[0].entry.senses).toHaveLength(2)
      expect(hits.every(hit => hit.pack.packId === 'canonical-fr')).toBe(true)
    }
  })
  it('keeps the existing thirty-candidate bound after merging value-index lookups', async () => {
    const packs = manager(join(directory(), 'installed'))
    packs.install(await pack('bounded-fr', 'v1', 'en', undefined, Array.from({ length: 36 }, (_, index) => ({
      word: index === 0 ? 'cafe\u0301' : 'café', lang_code: 'fr', senses: [{ glosses: [`Independent source entry ${index + 1}.`] }]
    }))))
    const hits = packs.lookup({ text: 'café', language: 'fr' }).results
    expect(hits).toHaveLength(30)
    expect(hits.map(hit => hit.entry.id)).toEqual(Array.from({ length: 30 }, (_, index) => `line:${index + 1}`))
    expect(hits[0].matchPath).toBe('nfc'); expect(hits.slice(1).every(hit => hit.matchPath === 'exact')).toBe(true)
  })
})
