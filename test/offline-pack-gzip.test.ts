import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildDictionaryPack } = require('../scripts/build-dictionary-pack.cjs')
const directories: string[] = []
const metadata = {
  packId: 'synthetic-gzip', version: 'fixture-1', sourceLanguage: 'ja', glossLanguage: 'en',
  sourceName: 'Authored compression fixture', sourceUrl: 'https://example.test/source', sourceRevision: 'test-only',
  license: 'CC0-1.0 (authored fixture)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Authored synthetic test; no downloaded dictionary data.'
}
const workspace = () => { const dir = mkdtempSync(join(tmpdir(), 'lingobar-pack-gzip-')); directories.push(dir); return dir }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function contents(path: string) {
  const db = new DatabaseSync(join(path, 'entries.sqlite'), { readOnly: true })
  try { return Object.fromEntries(['entries', 'senses', 'forms'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) }
  finally { db.close() }
}

describe('streamed local gzip dictionary input', () => {
  it('builds identical records from plain/gzip UTF8, CRLF, blank lines and a final line without newline', async () => {
    const dir = workspace()
    const records = [
      { word: '猫', lang_code: 'ja', pos: 'noun', senses: [{ glosses: ['Authored synthetic cat definition.'] }] },
      { word: '食べる', lang_code: 'ja', pos: 'verb', forms: [{ form: '食べた', tags: ['past'] }], senses: [{ glosses: ['Authored synthetic eating definition.'] }] }
    ]
    const data = records.map(row => JSON.stringify(row)).join('\r\n\r\n')
    const plain = join(dir, 'source.jsonl'), compressed = join(dir, 'source.jsonl.gz')
    writeFileSync(plain, data); writeFileSync(compressed, gzipSync(data))
    const first = await buildDictionaryPack({ input: plain, output: join(dir, 'plain-pack'), manifest: metadata })
    const second = await buildDictionaryPack({ input: compressed, output: join(dir, 'gzip-pack'), manifest: metadata })
    expect(second).toEqual(first)
    expect(contents(join(dir, 'gzip-pack'))).toEqual(contents(join(dir, 'plain-pack')))
    expect(contents(join(dir, 'gzip-pack')).entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'line:3', headword: '食べる' })]))
  })
  it.each(['invalid', 'truncated'])('rejects %s gzip through the build promise and cleans its new output', async kind => {
    const dir = workspace(), source = join(dir, 'source.jsonl.gz'), output = join(dir, 'failed-pack')
    const compressed = gzipSync(JSON.stringify({ word: '猫', lang_code: 'ja', senses: [{ glosses: ['Authored test.'] }] }))
    writeFileSync(source, kind === 'invalid' ? Buffer.from('not a gzip stream') : compressed.subarray(0, compressed.length - 5))
    await expect(buildDictionaryPack({ input: source, output, manifest: metadata })).rejects.toBeInstanceOf(Error)
    expect(existsSync(output)).toBe(false)
    expect(readFileSync(source)).toEqual(kind === 'invalid' ? Buffer.from('not a gzip stream') : compressed.subarray(0, compressed.length - 5))
  })
  it('applies the same 4MiB limit to a decompressed record before JSON parsing', async () => {
    const dir = workspace(), source = join(dir, 'oversized.jsonl.gz'), output = join(dir, 'failed-pack')
    writeFileSync(source, gzipSync('x'.repeat(4 * 1024 * 1024 + 2)))
    await expect(buildDictionaryPack({ input: source, output, manifest: metadata })).rejects.toThrow('JSONL line 1 exceeds the documented 4MiB record limit')
    expect(existsSync(output)).toBe(false)
  })
})
