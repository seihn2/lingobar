import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const directory = join(import.meta.dirname, 'fixtures/offline-dictionaries')
const read = (filename: string) => JSON.parse(readFileSync(join(directory, filename), 'utf8'))
const audit = read('SOURCES.json')
const evaluation = read('evaluation.json')
const languages = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'zh']
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

describe('separately licensed real eight-language data fixtures', () => {
  it('pins source/projection hashes and actual language pairs rather than relabeling dictionary data as application code', () => {
    expect(audit.kind).toBe('real-kaikki-text-projections')
    expect(audit.license).toBe('CC-BY-SA-4.0')
    expect(audit.wiktionaryDump).toBe('enwiktionary-2026-10-01')
    expect(audit.sources.map((source: { language: string }) => source.language)).toEqual(languages)
    expect(audit.sources.flatMap((source: { downloads: unknown[] }) => source.downloads)).toHaveLength(18)
    for (const source of audit.sources) {
      const metadata = read(source.language + '.metadata.json')
      const bytes = readFileSync(join(directory, source.fixture))
      expect(hash(bytes)).toBe(source.fixtureSha256)
      expect(metadata.sourceLanguage).toBe(source.language)
      expect(metadata.glossLanguage).toBe('en')
      expect(metadata.license).toContain('CC-BY-SA-4.0')
      expect(metadata.attribution).toContain('Wiktionary contributors')
      const rows = bytes.toString('utf8').trim().split('\n')
      expect(rows).toHaveLength(source.records)
      for (const download of source.downloads) {
        expect(download.status).toBe(200)
        expect(new URL(download.url).hostname).toBe('kaikki.org')
        expect(download.bytes).toBeLessThanOrEqual(2 * 1024 * 1024)
        expect(download.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(download.historyUrl).toContain('action=history')
        for (const record of download.records) {
          expect(record.originalLineSha256).toMatch(/^[a-f0-9]{64}$/)
          expect(hash(rows[record.projectedLine - 1])).toBe(record.projectionSha256)
        }
      }
    }
  })

  it('keeps only the documented lexical text projection, without redistributing quotations or media as licensed examples', () => {
    const allowed = ['word', 'lang', 'lang_code', 'pos', 'forms', 'redirects', 'sounds', 'senses']
    for (const source of audit.sources) {
      const rows = readFileSync(join(directory, source.fixture), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(rows.some(row => row.senses?.some((sense: { glosses?: string[] }) => sense.glosses?.length))).toBe(true)
      for (const row of rows) {
        expect(row.lang_code).toBe(source.language)
        expect(Object.keys(row).every(key => allowed.includes(key))).toBe(true)
        for (const sense of row.senses || []) expect(Object.keys(sense).every(key => ['glosses', 'tags', 'form_of'].includes(key))).toBe(true)
        for (const sound of row.sounds || []) expect(Object.keys(sound).every(key => ['ipa', 'enpr', 'roman', 'hangeul', 'other', 'tags'].includes(key))).toBe(true)
      }
    }
  })

  it('uses a different validation lemma and a genuinely recorded form in every synthetic selection case', () => {
    expect(evaluation.cases.map((item: { language: string }) => item.language)).toEqual(languages)
    for (const test of evaluation.cases) {
      expect(test.validationLemma).not.toBe(test.developmentLemma)
      const rows = readFileSync(join(directory, test.language + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const candidates = rows.filter(row => row.word === test.validationLemma)
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates.some(row => row.forms?.some((form: { form: string }) => form.form === test.selection))).toBe(true)
      const start = test.sentence.indexOf(test.selection)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(test.sentence.slice(start, start + test.selection.length)).toBe(test.selection)
    }
  })
})
