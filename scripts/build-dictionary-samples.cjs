// Build the committed, separately licensed real-data samples. No HTTP or model calls.
const { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, statSync, readdirSync } = require('node:fs')
const { join, resolve, relative } = require('node:path')
const { tmpdir } = require('node:os')
const { performance } = require('node:perf_hooks')
const { createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const { buildDictionaryPack } = require('./build-dictionary-pack.cjs')

const root = resolve(__dirname, '..')
const fixtures = join(root, 'test/fixtures/offline-dictionaries')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = filename => JSON.parse(readFileSync(filename, 'utf8'))
const elapsed = start => Number((performance.now() - start).toFixed(3))
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]

async function buildSamples(output = join(root, 'dist/offline-dictionaries')) {
  output = resolve(output)
  if (existsSync(output)) throw new Error('Sample output already exists; choose a new directory or remove only the previous generated samples.')
  mkdirSync(output, { recursive: true })
  const sources = json(join(fixtures, 'SOURCES.json'))
  const evaluation = json(join(fixtures, 'evaluation.json'))
  const scratch = mkdtempSync(join(tmpdir(), 'lingobar-real-dictionaries-'))
  let manager
  try {
    // This is the actual production lookup module, bundled from local project source.
    const moduleFile = join(scratch, 'offline-packs.cjs')
    buildSync({ entryPoints: [join(root, 'src/main/offline-packs.ts')], outfile: moduleFile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
    const { OfflinePacks } = require(moduleFile)
    manager = new OfflinePacks(join(scratch, 'installed'))
    const reports = []
    for (const fixture of sources.sources) {
      const metadata = json(join(fixtures, fixture.language + '.metadata.json'))
      const raw = readFileSync(join(fixtures, fixture.fixture))
      if (hash(raw) !== fixture.fixtureSha256) throw new Error('Source projection checksum mismatch: ' + fixture.language)
      const destination = join(output, metadata.packId)
      const buildStart = performance.now()
      const manifest = await buildDictionaryPack({ input: join(fixtures, fixture.fixture), output: destination, manifest: metadata })
      const buildMs = elapsed(buildStart)
      const installStart = performance.now()
      manager.install(join(destination, 'manifest.json'))
      const installationMs = elapsed(installStart)
      const test = evaluation.cases.find(item => item.language === fixture.language)
      const lookup = text => manager.lookup({ text, language: fixture.language, glossLanguage: 'zh' })
      const coldStart = performance.now(), development = lookup(test.developmentLemma), coldLookupMs = elapsed(coldStart)
      const lemma = lookup(test.validationLemma), selected = lookup(test.selection)
      const times = []
      for (let run = 0; run < 100; run++) {
        const start = performance.now(); lookup(run % 2 ? test.developmentLemma : test.selection); times.push(performance.now() - start)
      }
      const checks = {
        developmentLemma: development.results.some(hit => hit.entry.headword === test.developmentLemma),
        heldOutLemma: lemma.results.some(hit => hit.entry.headword === test.validationLemma),
        heldOutRecordedForm: selected.results.some(hit => hit.entry.headword === test.expectedHeadword && ['form', 'nfc-form'].includes(hit.matchPath)),
        excludesSourceMetadataForms: test.nonLexicalForms.every(text => lookup(text).results.length === 0),
      }
      const start = test.sentence.indexOf(test.selection), end = start + test.selection.length
      if (start < 0 || test.sentence.slice(start, end) !== test.selection) throw new Error('Invalid synthetic selection fixture')
      const report = {
        language: fixture.language, glossLanguage: manifest.glossLanguage, packId: manifest.packId,
        sourceRecords: fixture.records, counts: manifest.counts,
        databaseBytes: statSync(join(destination, 'entries.sqlite')).size,
        packBytes: statSync(join(destination, 'entries.sqlite')).size + statSync(join(destination, 'manifest.json')).size,
        buildMs, installationMs, coldLookupMs,
        warmLookup: { repetitions: times.length, p50Ms: Number(percentile(times, .5).toFixed(3)), p95Ms: Number(percentile(times, .95).toFixed(3)) },
        checks,
        nonLexicalForms: test.nonLexicalForms,
        heldOutSelection: { sentence: test.sentence, span: { start, end, exact: test.selection }, expectedHeadword: test.expectedHeadword,
          candidates: selected.results.map(hit => ({ headword: hit.entry.headword, entryId: hit.entry.id, matchPath: hit.matchPath, sourceRevision: hit.pack.sourceRevision })) },
        chineseGlossCoverage: { availableSenses: manifest.glossLanguage === 'zh' ? manifest.counts.senses : 0, denominatorSenses: manifest.counts.senses, method: 'explicit pack glossLanguage; no language guessing or translation', message: selected.message },
        dbSha256: manifest.dbSha256, fixtureSha256: fixture.fixtureSha256,
      }
      reports.push(report)
      if (!Object.values(checks).every(Boolean)) throw new Error('Real sample lookup regression: ' + fixture.language + ' ' + JSON.stringify(checks))
    }
    const report = { schemaVersion: 1, kind: 'lingobar-eight-language-real-sample-validation', createdAt: new Date().toISOString(),
      runtime: { node: process.versions.node, electron: process.versions.electron || null, platform: process.platform, architecture: process.arch },
      scope: 'Small real source-derived text samples; 1 development lemma, 1 held-out lemma and 1 recorded-form synthetic selection per language. Functional candidate checks only, not semantic accuracy, vocabulary coverage, full-dataset performance, real devices or learning efficacy.',
      source: { extractedAt: sources.extractedAt, wiktionaryDump: sources.wiktionaryDump, license: sources.license, changes: sources.changes },
      languages: reports,
    }
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    for (const name of ['SOURCES.json', 'LICENSE-DATA.md', 'evaluation.json']) copyFileSync(join(fixtures, name), join(output, name))
    const inventory = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? inventory(join(directory, item.name)) : [join(directory, item.name)])
    writeFileSync(join(output, 'SHA256SUMS.txt'), inventory(output).sort().map(filename => hash(readFileSync(filename)) + '  ' + relative(output, filename).replaceAll('\\', '/')).join('\n') + '\n')
    return report
  } finally { manager?.close(); rmSync(scratch, { recursive: true, force: true }) }
}

module.exports = { buildSamples }
if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--output')) { console.error('Usage: node scripts/build-dictionary-samples.cjs [--output new-directory]'); process.exit(1) }
  buildSamples(args[1]).then(report => console.log(JSON.stringify({ languages: report.languages.map(item => ({ language: item.language, checks: item.checks, entries: item.counts.entries, chineseGlossCoverage: item.chineseGlossCoverage })), scope: report.scope }, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
