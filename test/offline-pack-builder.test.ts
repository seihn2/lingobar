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
  it('skips source records without glosses or form links before requiring a usable headword', async () => {
    const f = input([
      { word: ' ', lang_code: 'en', pos: 'punct', senses: [{}] },
      { word: ' ', lang_code: 'en', pos: 'punct', senses: [{ raw_glosses: ['(Internet slang)'], tags: ['empty-gloss', 'no-gloss'] }] },
      { word: 'authored', lang_code: 'en', senses: [{ glosses: ['An authored usable answer.'] }] }
    ])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    expect(built.counts).toEqual({ entries: 1, senses: 1, forms: 0 })
    const report = JSON.parse(readFileSync(join(f.output, 'BUILD-REPORT.json'), 'utf8'))
    expect(report.records).toMatchObject({ parsed: 3, matchingLanguage: 3, skippedNoLexicalContent: 2, formLinkOnly: 0, withGlosses: 1 })
    expect(report.input).toMatchObject({ bytes: readFileSync(f.source).byteLength, sha256: createHash('sha256').update(readFileSync(f.source)).digest('hex'), compression: 'none' })
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try { expect(db.prepare('SELECT id,headword FROM entries').all()).toEqual([{ id: 'line:3', headword: 'authored' }]) }
    finally { db.close() }
    const invalid = input([{ word: ' ', lang_code: 'en', senses: [{ glosses: ['A source answer with an invalid lookup headword.'] }] }])
    await expect(buildDictionaryPack({ input: invalid.source, output: invalid.output, manifest: metadata })).rejects.toThrow('Invalid headword at source line 1')
  })
  it('retains a real spacing punctuation headword and its source alias while refusing control-character punctuation', async () => {
    const f = input([{ word: ' ', lang_code: 'en', pos: 'punct', forms: [{ form: '] [', tags: ['canonical'] }], senses: [{ glosses: ['An authored spacing-symbol definition.'] }] }])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    expect(built.counts).toEqual({ entries: 1, senses: 1, forms: 1 })
    const packs = new OfflinePacks(join(f.dir, 'installed'))
    try {
      packs.install(join(f.output, 'manifest.json'))
      const entry = packs.lookup({ text: '] [', language: 'en' }).results[0]
      expect(entry.entry.headword).toBe(' '); expect(entry.entry.partOfSpeech).toBe('punct')
      expect(entry.matchPath).toBe('form'); expect(entry.entry.senses[0].glosses).toEqual(['An authored spacing-symbol definition.'])
      expect(() => packs.lookup({ text: ' ', language: 'en' })).toThrow('有效的连续短语')
    } finally { packs.close() }
    const invalid = input([{ word: '\t', lang_code: 'en', pos: 'punct', senses: [{ glosses: ['An authored invalid-control test.'] }] }])
    await expect(buildDictionaryPack({ input: invalid.source, output: invalid.output, manifest: metadata })).rejects.toThrow('Invalid headword at source line 1')
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
    { name: '257 senses', extra: { senses: Array.from({ length: 257 }, (_, i) => ({ glosses: [`Authored sense ${i}.`] })) } },
    { name: '101 glosses', extra: { senses: [{ glosses: Array.from({ length: 101 }, (_, i) => `Authored gloss ${i}.`) }] } },
    { name: '21 examples', extra: { senses: [{ glosses: ['Authored gloss.'], examples: Array.from({ length: 21 }, (_, i) => ({ text: `Authored example ${i}.` })) }] } },
    { name: 'overlong gloss', extra: { senses: [{ glosses: ['x'.repeat(16001)] }] } },
    { name: 'overlong part of speech', extra: { pos: 'x'.repeat(257) } }
  ])('rejects $name with its source line instead of producing unusable or truncated entries', async ({ extra }) => {
    const f = input([{ word: 'authored', lang_code: 'en', senses: [{ glosses: ['Authored fixture.'] }], ...extra }])
    await expect(buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })).rejects.toThrow(/Source line 1.*runtime limit/)
    expect(existsSync(f.output)).toBe(false)
  })
  it('preserves all 225 source senses in a v2 package through the last runtime answer', async () => {
    const f = input([{ word: 'authored', lang_code: 'en', senses: Array.from({ length: 225 }, (_, i) => ({ glosses: [`Authored sense ${i + 1}.`] })) }])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    expect(built.counts.senses).toBe(225); expect(built.schemaVersion).toBe(2)
    expect(JSON.parse(readFileSync(join(f.output, 'BUILD-REPORT.json'), 'utf8')).maxSourceSenses).toBe(225)
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(db.prepare('SELECT glosses_json FROM senses ORDER BY rowid').all().map(row => JSON.parse(String(row.glosses_json))[0])).toEqual(Array.from({ length: 225 }, (_, i) => `Authored sense ${i + 1}.`))
    }
    finally { db.close() }
    const packs = new OfflinePacks(join(f.dir, 'installed'))
    try {
      expect(packs.install(join(f.output, 'manifest.json')).manifest.schemaVersion).toBe(2)
      const result = packs.lookup({ text: 'authored', language: 'en' }).results[0]
      expect(result.entry.senses).toHaveLength(225)
      expect(result.entry.senses.at(-1)?.glosses).toEqual(['Authored sense 225.'])
    } finally { packs.close() }
  })
  it.each([{ count: 100, schemaVersion: 1 }, { count: 101, schemaVersion: 2 }])('marks $count actual senses with manifest v$schemaVersion without changing SQLite DDL', async ({ count, schemaVersion }) => {
    const f = input([{ word: 'authored', lang_code: 'en', senses: Array.from({ length: count }, (_, i) => ({ glosses: [`Authored sense ${i + 1}.`] })) }])
    const built = await buildDictionaryPack({ input: f.source, output: f.output, manifest: metadata })
    expect(built.schemaVersion).toBe(schemaVersion)
    expect(JSON.parse(readFileSync(join(f.output, 'BUILD-REPORT.json'), 'utf8')).maxSourceSenses).toBe(count)
    const db = new DatabaseSync(join(f.output, 'entries.sqlite'), { readOnly: true })
    try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1) }
    finally { db.close() }
  })
})
