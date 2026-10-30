import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OfflinePacks } from '../src/main/offline-packs'

const require = createRequire(import.meta.url)
const { buildDictionaryPack } = require('../scripts/build-dictionary-pack.cjs')
const directories: string[] = []
const metadata = {
  packId: 'synthetic-en', version: 'fixture-1', sourceLanguage: 'en', glossLanguage: 'en',
  sourceName: 'Synthetic authored fixture', sourceUrl: 'https://example.test/source', sourceRevision: 'test-only',
  license: 'CC0-1.0 (synthetic authored fixture)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'LingoBar synthetic fixture; not a real dictionary.'
}
function input(records: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'lingobar-pack-builder-')); directories.push(dir)
  const source = join(dir, 'source.jsonl'); writeFileSync(source, records.map(value => JSON.stringify(value)).join('\n') + '\n')
  return { dir, source, output: join(dir, 'pack') }
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('local Kaikki-shaped JSONL language-pack builder', () => {
  it('writes read-only-consumable SQLite with distinct senses, actual readings/examples and bound source metadata', async () => {
    const f = input([
      { word: 'cafe\u0301', lang_code: 'en', pos: 'noun', sounds: [{ ipa: '/synthetic/' }, { audio: 'https://forbidden.example/audio.mp3' }], forms: [{ form: 'cafes', tags: ['plural'] }], senses: [{ glosses: ['An authored synthetic first sense.'], examples: [{ text: 'Synthetic source sentence.', english: 'Synthetic translation.' }] }, { glosses: ['A separate authored second sense.'], tags: ['figurative'] }] },
      { word: 'wrong-language', lang_code: 'fr', senses: [{ glosses: ['Not an English entry.'] }] }
    ])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    expect(built.counts).toEqual({ entries: 1, senses: 2, forms: 1 })
    expect(built.dbSha256).toBe(createHash('sha256').update(readFileSync(join(f.output, 'entries.sqlite'))).digest('hex'))
    expect(JSON.parse(readFileSync(join(f.output, 'manifest.json'), 'utf8'))).toEqual({ schemaVersion: 1, ...metadata, dbSha256: built.dbSha256, counts: built.counts })
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      const row = db.prepare('SELECT * FROM entries').get()!
      expect(row.headword).toBe('cafe\u0301'); expect(row.headword_nfc).toBe('café'); expect(row.id).toBe('line:1')
      expect(JSON.parse(String(row.readings_json))).toEqual(['/synthetic/'])
      expect(db.prepare('SELECT * FROM senses').all()).toHaveLength(2)
      expect(JSON.parse(String(db.prepare('SELECT examples_json FROM senses ORDER BY id LIMIT 1').get()!.examples_json))).toEqual([{ text: 'Synthetic source sentence.', translation: 'Synthetic translation.' }])
      expect(db.prepare('SELECT form FROM forms').get()?.form).toBe('cafes')
      expect(() => db.exec('DELETE FROM entries')).toThrow()
    } finally { db.close() }
  })
  it('builds explicit form_of reverse candidates without inventing a missing base', async () => {
    const f = input([
      { word: 'went', lang_code: 'en', pos: 'verb', senses: [{ form_of: [{ word: 'go' }], tags: ['past'], glosses: ['Authored inflection record.'] }] },
      { word: 'go', lang_code: 'en', pos: 'verb', senses: [{ glosses: ['Authored base definition.'] }] },
      { word: 'missing-base-form', lang_code: 'en', senses: [{ form_of: [{ word: 'absent' }], tags: ['test'] }] }
    ])
    await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('SELECT e.headword,f.form FROM forms f JOIN entries e ON e.id=f.entry_id').all()).toEqual([{ headword: 'go', form: 'went' }])
      expect(db.prepare('SELECT count(*) AS count FROM forms WHERE form=?').get('missing-base-form')?.count).toBe(0)
    } finally { db.close() }
  })
  it('does not index counters/table placeholders as forms and retains the kind of actual source aliases', async () => {
    const f = input([{ word: '고양이', lang_code: 'ko', pos: 'noun', forms: [
      { form: '마리', tags: ['counter'] }, { form: 'table metadata', tags: ['table-tags'] },
      { form: 'template metadata', tags: ['inflection-template'] }, { form: '-' },
      { form: 'sein', tags: ['auxiliary'] }, { form: 'avoir + past participle', tags: ['infinitive', 'multiword-construction'] },
      { form: 'goyangi', tags: ['romanization'] }, { form: '고양이', tags: ['canonical'] },
      { form: '괴양이', tags: ['alternative'] }
    ], senses: [{ glosses: ['Synthetic authored cat fixture.'] }] }])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: { ...metadata, packId: 'synthetic-ko', sourceLanguage: 'ko' } })
    expect(built.counts.forms).toBe(3)
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try {
      const expected = [{ form: 'goyangi', tags: ['romanization'] }, { form: '고양이', tags: ['canonical'] }, { form: '괴양이', tags: ['alternative'] }]
      const rows = db.prepare('SELECT form,tags_json FROM forms ORDER BY rowid').all().map(row => ({ form: row.form, tags: JSON.parse(String(row.tags_json)) }))
      expect(rows).toEqual(expected)
      const projection = JSON.parse(String(db.prepare('SELECT forms_json FROM entries').get()!.forms_json))
      expect(projection).toEqual(expect.arrayContaining([...expected, { form: '마리', tags: ['counter'] }, { form: 'sein', tags: ['auxiliary'] }, { form: 'avoir + past participle', tags: ['infinitive', 'multiword-construction'] }]))
    } finally { db.close() }
  })
  it('does not turn real-source classifiers, auxiliaries or unfilled templates into lemma hits', async () => {
    for (const [language, negative, unrelatedLemma] of [['ko', '마리', '고양이'], ['de', 'sein', 'gehen'], ['fr', 'avoir + past participle', 'manger']] as const) {
      const fixture = join(import.meta.dirname, 'fixtures', 'offline-dictionaries', language)
      const dir = mkdtempSync(join(tmpdir(), 'lingobar-real-form-negative-')); directories.push(dir)
      const output = join(dir, 'pack')
      await buildDictionaryPack({ input: fixture + '.jsonl', output, manifest: JSON.parse(readFileSync(fixture + '.metadata.json', 'utf8')) })
      const packs = new OfflinePacks(join(dir, 'installed'))
      try {
        packs.install(join(output, 'manifest.json'))
        expect(packs.lookup({ text: unrelatedLemma, language }).results.some(hit => hit.entry.headword === unrelatedLemma)).toBe(true)
        expect(packs.lookup({ text: negative, language }).results.some(hit => hit.entry.headword === unrelatedLemma)).toBe(false)
      } finally { packs.close() }
    }
  })
  it('cleans only its new failed output and never overwrites a prior version', async () => {
    const f = input([{ word: 'go', lang_code: 'en', senses: [{ glosses: ['Authored example.'] }] }])
    await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    const original = readFileSync(join(f.output, 'manifest.json'), 'utf8')
    await expect(buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })).rejects.toThrow('already exists')
    expect(readFileSync(join(f.output, 'manifest.json'), 'utf8')).toBe(original)
    writeFileSync(f.source, '{bad json}\n')
    const failed = join(f.dir, 'bad-pack')
    await expect(buildDictionaryPack({ input: f.source, output: failed, manifest: metadata })).rejects.toThrow('source line 1')
    expect(existsSync(failed)).toBe(false)
  })
  it('rejects absent licensing/unknown metadata and empty source-language coverage', async () => {
    const f = input([{ word: 'mot', lang_code: 'fr', senses: [{ glosses: ['Authored fixture.'] }] }])
    for (const descriptor of [{ ...metadata, license: '' }, { ...metadata, extra: true }, { ...metadata, sourceUrl: 'http://example.test' }]) {
      await expect(buildDictionaryPack({ input: f.source, output: f.output, manifest: descriptor })).rejects.toThrow()
      expect(existsSync(f.output)).toBe(false)
    }
    await expect(buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })).rejects.toThrow('No source-language entries')
    expect(existsSync(f.output)).toBe(false)
  })
  it.each([
    { name: '501 forms', extra: { forms: Array.from({ length: 501 }, (_, i) => ({ form: `authored-${i}` })) } },
    { name: '101 senses', extra: { senses: Array.from({ length: 101 }, (_, i) => ({ glosses: [`Authored sense ${i}.`] })) } },
    { name: '101 glosses', extra: { senses: [{ glosses: Array.from({ length: 101 }, (_, i) => `Authored gloss ${i}.`) }] } },
    { name: '21 examples', extra: { senses: [{ glosses: ['Authored gloss.'], examples: Array.from({ length: 21 }, (_, i) => ({ text: `Authored example ${i}.` })) }] } },
    { name: 'overlong gloss', extra: { senses: [{ glosses: ['x'.repeat(16001)] }] } },
    { name: 'overlong part of speech', extra: { pos: 'x'.repeat(257) } }
  ])('rejects $name with its source line instead of producing unusable or truncated entries', async ({ extra }) => {
    const f = input([{ word: 'authored', lang_code: 'en', senses: [{ glosses: ['Authored fixture.'] }], ...extra }])
    await expect(buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })).rejects.toThrow(/Source line 1.*runtime limit/)
    expect(existsSync(f.output)).toBe(false)
  })
  it('preserves all senses at the runtime boundary', async () => {
    const f = input([{ word: 'authored', lang_code: 'en', senses: Array.from({ length: 100 }, (_, i) => ({ glosses: [`Authored sense ${i + 1}.`] })) }])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    expect(built.counts.senses).toBe(100)
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT glosses_json FROM senses ORDER BY rowid').all().map(row => JSON.parse(String(row.glosses_json))[0])).toEqual(Array.from({ length: 100 }, (_, i) => `Authored sense ${i + 1}.`)) }
    finally { db.close() }
  })
})
