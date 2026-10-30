import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflinePacks } from '../src/main/offline-packs'

const require = createRequire(import.meta.url)
const { prepareKaikkiText } = require('../scripts/prepare-kaikki-text.cjs')
const { buildDictionaryPack } = require('../scripts/build-dictionary-pack.cjs')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'offline-readings')
const provenance = JSON.parse(readFileSync(join(fixtureRoot, 'PROVENANCE.json'), 'utf8'))
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals() })

describe('small real source reading fields through preparation, import and restart', () => {
  it.each([
    { label: 'ko-hans', word: '공산당', language: 'ko', expected: '来源韩文记音（hangeul；标签：["phonetic"]）：공(ː)산당' },
    { label: 'ko-hant', word: '회교', language: 'ko', expected: '来源韩文记音（hangeul；标签：["phonetic"]）：훼교' },
    { label: 'zh-hans', word: '咧', language: 'zh', expected: '来源中文记音（zh_pron；标签：["Min-Nan","Hokkien","Phak-fa-su"]；原标签：["菲律賓"]）：--le' },
    { label: 'zh-hant', word: '大去', language: 'zh', expected: '来源中文记音（zh_pron；标签：["Min-Nan","Hokkien","Phak-fa-su"]）：tōa--khì' },
    { label: 'zh-many-readings', word: '在', language: 'zh', expected: '来源中文记音（zh_pron；标签：["Old-Chinese","Zhengzhang"]）：/*zlɯːs/' }
  ])('imports $label with the supplied notation and labels, without a network or media path', async ({ label, word, language, expected }) => {
    const forbidden = vi.fn(() => { throw new Error('External network is forbidden in offline reading tests') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('WebSocket', class { constructor() { forbidden() } })
    const directory = mkdtempSync(join(tmpdir(), 'lingobar-source-reading-')); directories.push(directory)
    const source = join(fixtureRoot, label + '.jsonl'), output = join(directory, 'text.jsonl')
    const evidence = provenance.sources.find((item: { file: string }) => item.file === label + '.jsonl')
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(evidence.fixtureSha256)
    const prepared = await prepareKaikkiText({ input: source, output, source: evidence.source })
    expect(prepared.projectionSha256).toBe(evidence.fixtureSha256)
    const descriptor = JSON.parse(readFileSync(join(fixtureRoot, label + '.metadata.json'), 'utf8'))
    const manifest = await buildDictionaryPack({ input: output, output: join(directory, 'pack'), manifest: descriptor })
    expect(manifest.schemaVersion).toBe(label === 'zh-many-readings' ? 3 : 1)
    expect(manifest.license).toContain('CC-BY-SA-4.0')
    let packs = new OfflinePacks(join(directory, 'installed'))
    try {
      packs.install(join(directory, 'pack', 'manifest.json'))
      const hit = packs.lookup({ text: word, language }).results[0]
      expect(hit.pack.sourceUrl).toBe(descriptor.sourceUrl)
      expect(hit.entry.readings).toContain(expected)
      expect(hit.entry.readings.join()).not.toContain('audio')
      if (label === 'zh-many-readings') {
        expect(hit.entry.readings).toHaveLength(254)
        expect(hit.entry.readings.at(-1)).toBe(expected)
      }
      if (label === 'zh-hans') {
        const endings = hit.entry.readings.filter(reading => reading.endsWith('：--le'))
        expect(endings).toHaveLength(3)
        expect(endings.some(reading => !reading.includes('原标签'))).toBe(true)
        expect(endings.filter(reading => reading.includes('菲律賓'))).toHaveLength(2)
      }
      if (label === 'zh-hant') {
        const homepage = packs.lookup({ text: '首頁', language }).results[0].entry.readings
        expect(homepage.some(reading => reading.includes('"Mandarin","Pinyin"') && reading.endsWith('：shǒuyè'))).toBe(true)
        expect(homepage.some(reading => reading.includes('"Cantonese","Jyutping"') && reading.endsWith('：sau² jip⁶'))).toBe(true)
        expect(homepage.some(reading => reading.includes('"Hakka"'))).toBe(true)
        expect(homepage.some(reading => reading.includes('"Min-Nan"'))).toBe(true)
      }
      const before = hit.entry.readings
      packs.close(); packs = new OfflinePacks(join(directory, 'installed'))
      expect(packs.lookup({ text: word, language }).results[0].entry.readings).toEqual(before)
      packs.uninstall(manifest.packId)
      expect(packs.lookup({ text: word, language }).results).toEqual([])
      expect(forbidden).not.toHaveBeenCalled()
    } finally { packs.close() }
  })

  it.each([1, 2, 3])('rejects an external package violating manifest %i reading capacity instead of truncating it', async schemaVersion => {
    const directory = mkdtempSync(join(tmpdir(), 'lingobar-reading-cap-')); directories.push(directory)
    const output = join(directory, 'pack'), descriptor = JSON.parse(readFileSync(join(fixtureRoot, 'zh-many-readings.metadata.json'), 'utf8'))
    const manifest = await buildDictionaryPack({ input: join(fixtureRoot, 'zh-many-readings.jsonl'), output, manifest: descriptor })
    manifest.schemaVersion = schemaVersion
    if (schemaVersion === 3) {
      const path = join(output, 'entries.sqlite'), db = new DatabaseSync(path)
      try {
        const row = db.prepare('SELECT id,readings_json FROM entries').get()!
        const readings = JSON.parse(String(row.readings_json))
        readings.push('Self-authored oversized reading 255', 'Self-authored oversized reading 256', 'Self-authored oversized reading 257')
        db.prepare('UPDATE entries SET readings_json=? WHERE id=?').run(JSON.stringify(readings), row.id)
      } finally { db.close() }
      manifest.dbSha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest))
    const packs = new OfflinePacks(join(directory, 'installed'))
    try {
      packs.install(join(output, 'manifest.json'))
      const result = packs.lookup({ text: '在', language: 'zh' })
      expect(result.results).toEqual([])
      expect(result.message).toContain('无法查询')
    } finally { packs.close() }
  })
})
