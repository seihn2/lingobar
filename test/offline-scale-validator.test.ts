import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const { buildDictionaryPack } = createRequire(import.meta.url)('../scripts/build-dictionary-pack.cjs')

it('runs the scale validator against two explicitly synthetic sources without conflating retrieval or Chinese coverage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'offline-scale-validator-'))
  try {
    const paths: string[] = []
    for (const language of ['en', 'zh']) {
      const input = join(directory, `${language}.jsonl`), output = join(directory, language)
      writeFileSync(input, JSON.stringify({ word: '犬', lang_code: 'ja', pos: 'noun', senses: [{ glosses: [language === 'en' ? 'SYNTHETIC_EN_DOG' : '合成中文狗释义'] }] }) + '\n')
      await buildDictionaryPack({ input, output, manifest: { packId: `synthetic-ja-${language}`, version: 'test-v1', sourceLanguage: 'ja', glossLanguage: language, sourceName: `Synthetic ${language} source, not real data`, sourceUrl: 'https://example.invalid/synthetic', sourceRevision: 'synthetic-v1', license: 'Synthetic fixture created for tests', licenseUrl: 'https://example.invalid/synthetic-license', attribution: 'Self-written synthetic fixture, not dictionary data.' } })
      paths.push(join(output, 'manifest.json'))
    }
    const cases = join(directory, 'cases.json')
    writeFileSync(cases, JSON.stringify({ schemaVersion: 1, description: 'Synthetic CLI test only, not scale or lexical quality evidence.', cases: [
      { id: 'hit', language: 'ja', text: '犬', sentence: '庭に犬がいます。', expectedHeadword: '犬' },
      { id: 'miss', language: 'ja', text: '未収録の合成語', expectedHeadword: '未収録の合成語' }
    ] }))
    const output = join(directory, 'report')
    const result = spawnSync(process.execPath, [resolve('scripts/validate-dictionary-scale.cjs'), '--manifest', paths[0], '--manifest', paths[1], '--cases', cases, '--output', output, '--rounds', '2'], { cwd: resolve('.'), encoding: 'utf8', timeout: 30000 })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
    expect(report.status).toBe('passed')
    expect(report.network).toEqual({ attempts: 0, providerCalls: 0 })
    expect(report.installedCoverage).toMatchObject({ entries: 2, senses: 2, chineseEntries: 1, chineseSenses: 1, senseDenominator: 2, chineseSenseShare: .5 })
    expect(report.retrievalSummary).toMatchObject({ cases: 2, withAnyResult: 1, withExpectedHeadwordCandidate: 1, withChineseResult: 1, chineseQueryDenominator: 2, semanticAccuracyMeasured: false })
    expect(report.warmQueries.count).toBe(4)
    expect(report.warmQueries.hitsOnly.count).toBe(2)
    expect(report.learningChain.chosenSources).toHaveLength(2)
    expect(report.learningChain.snapshotsSurviveUninstall).toBe(true)
    const exported = JSON.parse(readFileSync(join(output, 'learning-export.json'), 'utf8'))
    expect(exported.entries).toHaveLength(2)
    expect(new Set(exported.entries.map((entry: any) => entry.explanation.pack.glossLanguage))).toEqual(new Set(['en', 'zh']))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
