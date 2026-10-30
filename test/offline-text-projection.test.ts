import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { projectKaikkiText, prepareKaikkiText } = require('../scripts/prepare-kaikki-text.cjs')
const folders: string[] = []
const source = { url: 'https://kaikki.org/synthetic-input.jsonl', edition: 'synthetic', label: 'Synthetic self-written test', revision: 'test-v1', license: 'CC0-1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Self-written synthetic fixture, not dictionary data.' }
const fixture = () => { const folder = mkdtempSync(join(tmpdir(), 'lingobar-text-projection-')); folders.push(folder); return { folder, input: join(folder, 'source.jsonl'), output: join(folder, 'text.jsonl') } }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); vi.unstubAllGlobals() })

describe('source-preserving Kaikki lexical-text preparation', () => {
  it('keeps the documented multilingual lexical fields and strips all rich/quoted/media branches', () => {
    const row = { word: '食べる', lang: '日語', lang_code: 'ja', pos: 'verb', arbitrary: 'omit', etymology_text: 'omit',
      examples: [{ text: 'omit' }], etymology_examples: [{ text: 'omit' }], redirects: ['たべる'],
      forms: [{ form: '食べた', tags: ['past'], source: 'conjugation', ruby: [['食', 'た']], audio: 'omit' }],
      sounds: [{ ipa: '[ta̠be̞ɾɯ̟ᵝ]', enpr: 'written', roman: 'taberu', hangeul: 'written', 'zh-pron': 'written', zh_pron: 'written', other: 'written', tags: ['standard'], raw_tags: ['original region'], audio: 'omit', mp3_url: 'https://example.test/media', ogg_url: 'https://example.test/media', text: 'audio-related text omitted' }],
      senses: [{ glosses: ['吃；进食'], raw_glosses: ['(動詞) 吃；进食'], tags: ['transitive'], form_of: [{ word: '食べる', extra: 'source note', url: 'omit' }], alt_of: [{ word: '喰べる' }], examples: [{ text: 'omit quotation', ref: 'third-party' }], links: [['omit']], wikipedia: ['omit'] }] }
    expect(projectKaikkiText(row)).toEqual({ word: '食べる', lang: '日語', lang_code: 'ja', pos: 'verb', redirects: ['たべる'],
      forms: [{ form: '食べた', tags: ['past'] }], sounds: [{ ipa: '[ta̠be̞ɾɯ̟ᵝ]', enpr: 'written', roman: 'taberu', hangeul: 'written', other: 'written', 'zh-pron': 'written', zh_pron: 'written', tags: ['standard'], raw_tags: ['original region'] }],
      senses: [{ glosses: ['吃；进食'], raw_glosses: ['(動詞) 吃；进食'], tags: ['transitive'], form_of: [{ word: '食べる', extra: 'source note' }], alt_of: [{ word: '喰べる' }] }] })
    expect(row.senses[0].examples).toHaveLength(1)
  })

  it('streams exact Unicode without normalization and records independent raw/projection hashes and omissions', async () => {
    const f = fixture(), forbidden = vi.fn(() => { throw new Error('Network forbidden') }); vi.stubGlobal('fetch', forbidden)
    const rows = [
      { word: 'cafe\u0301', lang_code: 'fr', forms: [{ form: 'cafe\u0301s', tags: ['plural'] }], senses: [{ glosses: ['café'], examples: [{ text: 'excluded' }, { text: 'excluded too' }] }] },
      { word: '學習', lang_code: 'zh', redirects: ['学习'], senses: [{ glosses: ['to learn'], raw_glosses: ['raw text'] }], etymology_examples: [{ text: 'excluded' }] }
    ]
    const raw = rows.map(row => JSON.stringify(row)).join('\r\n') + '\r\n\r\n'; writeFileSync(f.input, raw)
    const result = await prepareKaikkiText({ ...f, source })
    const projected = readFileSync(f.output), proof = JSON.parse(readFileSync(result.provenance, 'utf8'))
    expect(readFileSync(f.input, 'utf8')).toBe(raw)
    expect(result.rawSha256).toBe(sha(raw)); expect(result.projectionSha256).toBe(sha(projected))
    expect(proof).toMatchObject({ source, inputRecords: 2, outputRecords: 2, blankLines: 1, removedExamples: 3, recordsWithGlosses: 2, sensesWithGlosses: 2, languageCounts: { fr: 1, zh: 1 } })
    expect(JSON.parse(projected.toString().split('\n')[0]).word).toBe('cafe\u0301')
    expect(projected.toString()).not.toContain('examples'); expect(forbidden).not.toHaveBeenCalled()
  })

  it('does not truncate retained text across read-stream chunks', async () => {
    const f = fixture(), gloss = '字'.repeat(100_000)
    writeFileSync(f.input, JSON.stringify({ word: 'text', lang_code: 'en', senses: [{ glosses: [gloss] }] }) + '\n')
    const result = await prepareKaikkiText({ ...f, source })
    expect(JSON.parse(readFileSync(f.output, 'utf8')).senses[0].glosses[0]).toBe(gloss)
    expect(result.maxInputRecordUtf8Bytes).toBeGreaterThan(64 * 1024)
  })

  it('preserves the source and does not publish a partial projection after malformed data', async () => {
    const f = fixture(), raw = '{"word":"valid","senses":[]}\nnot-json\n'; writeFileSync(f.input, raw)
    await expect(prepareKaikkiText({ ...f, source })).rejects.toThrow('Invalid JSON')
    expect(readFileSync(f.input, 'utf8')).toBe(raw); expect(existsSync(f.output)).toBe(false)
    expect(readdirSync(f.folder)).toEqual(['source.jsonl'])
    expect(() => projectKaikkiText(null)).toThrow('object')
  })

  it('refuses source/output reuse and missing provenance without overwriting files', async () => {
    const f = fixture(); writeFileSync(f.input, '{"word":"valid"}\n'); writeFileSync(f.output, 'existing')
    await expect(prepareKaikkiText({ ...f, source })).rejects.toThrow('new text output path')
    await expect(prepareKaikkiText({ input: f.input, output: f.input, source })).rejects.toThrow('new text output path')
    await expect(prepareKaikkiText({ ...f, source: {} })).rejects.toThrow('Explicit source')
    expect(readFileSync(f.output, 'utf8')).toBe('existing')
  })
})
