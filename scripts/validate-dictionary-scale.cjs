// Measure local, already-built packs with production SQLite and learning modules.
// No dictionary download, provider, credentials, Electron/UI or user profile access.
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, dirname } = require('node:path')
const { performance } = require('node:perf_hooks')
const { syncBuiltinESMExports } = require('node:module')
const { createHash } = require('node:crypto')
const { build } = require('esbuild')
const root = resolve(__dirname, '..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function argumentsFor(argv) {
  const result = { manifests: [], cases: join(root, 'test/fixtures/offline-scale-cases.json'), output: join(root, 'artifacts/offline-scale'), rounds: 20 }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index], value = argv[++index]
    if (!value) throw new Error(`Missing value for ${name}`)
    if (name === '--manifest') result.manifests.push(resolve(value))
    else if (name === '--cases') result.cases = resolve(value)
    else if (name === '--output') result.output = resolve(value)
    else if (name === '--rounds' && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 1000) result.rounds = Number(value)
    else throw new Error('Use --manifest PATH (repeatable), --cases PATH, --output DIRECTORY, or --rounds 1..1000.')
  }
  if (!result.manifests.length) throw new Error('At least one --manifest local language-pack manifest.json is required.')
  return result
}
const percentiles = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = fraction => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null
  return { count: sorted.length, minMs: sorted[0] ?? null, medianMs: quantile(.5), p95Ms: quantile(.95), maxMs: sorted.at(-1) ?? null }
}
const countBy = (values, key) => values.reduce((result, value) => { const name = key(value); result[name] = (result[name] || 0) + 1; return result }, {})

async function main() {
  const options = argumentsFor(process.argv.slice(2))
  const casesFile = JSON.parse(readFileSync(options.cases, 'utf8'))
  assert.equal(casesFile.schemaVersion, 1)
  assert.ok(Array.isArray(casesFile.cases) && casesFile.cases.length > 0)
  const cases = casesFile.cases
  for (const item of cases) {
    assert.ok(typeof item.id === 'string' && typeof item.text === 'string' && item.text.length <= 256 && typeof item.language === 'string')
    const sentence = item.sentence || item.text, start = sentence.indexOf(item.text)
    assert.ok(start >= 0, `Case ${item.id} has no exact source selection`)
    item.source = { text: sentence, span: { start, end: start + item.text.length, exact: item.text } }
  }
  const directory = mkdtempSync(join(tmpdir(), 'lingobar-dictionary-scale-'))
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), runtime: { node: process.versions.node, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch },
    scope: 'Actual production OfflinePacks + DictionaryLearning + DictionaryStore + export modules in Node; no Electron/renderer/native hardware measurement.',
    cacheBoundary: 'Cold means a new production manager/SQLite connection. Copying, hashing and OS filesystem caches are not flushed; this is not a cold-disk benchmark.',
    qualityBoundary: 'Hits and expected-headword candidates are lexical retrieval observations, not semantic correctness or representative language coverage.',
    fixture: { path: options.cases, sha256: sha256(readFileSync(options.cases)), description: casesFile.description, count: cases.length, rounds: options.rounds }, scriptSha256: sha256(readFileSync(__filename)), installs: [], checks: [], network: { attempts: 0, providerCalls: 0 }, memory: {} }
  let packs, learning
  const memory = label => {
    const value = { label, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, maxRssKiB: process.resourceUsage().maxRSS }
    report.memory.samples ||= []; report.memory.samples.push(value)
    report.memory.sampledPeakRssBytes = Math.max(report.memory.sampledPeakRssBytes || 0, value.rssBytes)
    return value
  }
  const check = (condition, label) => { assert.ok(condition, label); report.checks.push(label) }
  const failure = () => { report.network.attempts++; throw new Error('External network forbidden during offline scale validation') }
  try {
    const bundle = join(directory, 'production.cjs')
    await build({ stdin: { contents: `export {OfflinePacks} from ${JSON.stringify(join(root, 'src/main/offline-packs.ts'))}; export {DictionaryLearning} from ${JSON.stringify(join(root, 'src/main/dictionary-learning.ts'))}; export {DictionaryStore} from ${JSON.stringify(join(root, 'src/main/dictionary-store.ts'))}; export {dictionaryJson,dictionaryMarkdown} from ${JSON.stringify(join(root, 'src/main/dictionary-export.ts'))};`, resolveDir: root }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
    report.bundledProductionSha256 = sha256(readFileSync(bundle))
    // Installed before loading the production modules; no hidden service may be queried.
    globalThis.fetch = failure
    globalThis.WebSocket = class { constructor() { failure() } }
    require('node:http').get = failure; require('node:http').request = failure
    require('node:https').get = failure; require('node:https').request = failure
    require('node:net').Socket.prototype.connect = failure
    require('node:tls').connect = failure
    syncBuiltinESMExports()
    const { OfflinePacks, DictionaryLearning, DictionaryStore, dictionaryJson, dictionaryMarkdown } = require(bundle)
    memory('before-install')
    const packDirectory = join(directory, 'installed')
    packs = new OfflinePacks(packDirectory)
    for (const path of options.manifests) {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      console.log(`Installing local pack ${raw.packId} (${raw.counts?.entries ?? '?'} entries)...`)
      const started = performance.now(), installed = packs.install(path), milliseconds = performance.now() - started
      report.installs.push({ manifestPath: path, manifest: installed.manifest, databaseBytes: statSync(join(dirname(path), 'entries.sqlite')).size, manifestBytes: statSync(path).size, installMs: milliseconds })
      memory(`installed-${installed.manifest.packId}`)
    }
    const installed = packs.list()
    check(installed.length === options.manifests.length, 'Each requested source is installed as its own versioned package')
    const counts = installed.reduce((value, pack) => {
      value.entries += pack.manifest.counts.entries; value.senses += pack.manifest.counts.senses; value.forms += pack.manifest.counts.forms
      if (pack.manifest.glossLanguage.split('-')[0].toLowerCase() === 'zh') { value.chineseEntries += pack.manifest.counts.entries; value.chineseSenses += pack.manifest.counts.senses }
      return value
    }, { entries: 0, senses: 0, forms: 0, chineseEntries: 0, chineseSenses: 0 })
    report.installedCoverage = { ...counts, entryDenominator: counts.entries, senseDenominator: counts.senses,
      chineseEntryShare: counts.chineseEntries / counts.entries, chineseSenseShare: counts.chineseSenses / counts.senses,
      meaning: 'Share of installed source records whose declared gloss language is Chinese. Sources overlap and are not deduplicated or sense-aligned; this is not translation quality or all-Japanese vocabulary coverage.' }
    const observations = []
    for (const item of cases) {
      const started = performance.now(), result = packs.lookup({ text: item.text, language: item.language, glossLanguage: 'zh' }), milliseconds = performance.now() - started
      observations.push({ id: item.id, text: item.text, language: item.language, selectedSource: item.source, lookupMs: milliseconds, hitCount: result.results.length,
        expectedHeadword: item.expectedHeadword || null, expectedCandidateFound: item.expectedHeadword ? result.results.some(hit => hit.entry.headword.normalize('NFC') === item.expectedHeadword.normalize('NFC')) : null,
        hits: result.results.map(hit => ({ packId: hit.pack.packId, packVersion: hit.pack.version, glossLanguage: hit.pack.glossLanguage, entryId: hit.entry.id, headword: hit.entry.headword, matchPath: hit.matchPath, senseCount: hit.entry.senses.length })), message: result.message })
    }
    report.queries = observations
    report.connectionColdFirstLookup = { caseId: observations[0].id, milliseconds: observations[0].lookupMs, scope: report.cacheBoundary }
    const warm = [], warmByCase = new Map(cases.map(item => [item.id, []]))
    for (let round = 0; round < options.rounds; round++) for (const item of cases) {
      const started = performance.now()
      packs.lookup({ text: item.text, language: item.language, glossLanguage: 'zh' })
      const milliseconds = performance.now() - started
      warm.push(milliseconds); warmByCase.get(item.id).push(milliseconds)
    }
    report.warmQueries = { ...percentiles(warm), hitsOnly: percentiles(observations.filter(item => item.hitCount).flatMap(item => warmByCase.get(item.id))), byCase: cases.map(item => ({ id: item.id, ...percentiles(warmByCase.get(item.id)) })) }
    memory('after-warm-query-matrix')
    report.retrievalSummary = { cases: cases.length, withAnyResult: observations.filter(item => item.hitCount).length,
      withExpectedHeadwordCandidate: observations.filter(item => item.expectedCandidateFound === true).length,
      expectedCandidateDenominator: observations.filter(item => item.expectedHeadword !== null).length,
      withChineseResult: observations.filter(item => item.hits.some(hit => hit.glossLanguage.split('-')[0].toLowerCase() === 'zh')).length,
      chineseQueryDenominator: cases.length, matchPaths: countBy(observations.flatMap(item => item.hits), hit => hit.matchPath), semanticAccuracyMeasured: false }
    mkdirSync(join(directory, 'learning'), { mode: 0o700 })
    const store = new DictionaryStore(join(directory, 'learning'))
    learning = new DictionaryLearning(store, () => [], () => ({ configured: false, providerLabel: 'Disabled scale test provider', model: 'disabled', offlineDictionaryAvailable: true }), () => { report.network.providerCalls++; throw new Error('Provider forbidden during scale validation') }, () => {}, input => packs.lookup(input))
    const shared = observations.find(item => new Set(item.hits.map(hit => hit.glossLanguage)).size > 1)
    const candidate = shared || observations.find(item => item.hitCount)
    check(Boolean(candidate), 'At least one fixed public test selection has a local result for the learning-chain check')
    const open = learning.openInput(1, { text: candidate.selectedSource.text, language: candidate.language })
    check(Boolean(open.handle), 'Explicit public source receives a production user-input snapshot without a provider')
    const input = { handle: open.handle, span: candidate.selectedSource.span, language: candidate.language, glossLanguage: 'zh' }
    const lookup = learning.offlineLookup(1, input)
    const chosen = []
    for (const hit of lookup.results) if (!chosen.some(previous => previous.pack.packId === hit.pack.packId)) chosen.push(hit)
    const snapshots = chosen.map(hit => learning.saveOffline(1, { ...input, packId: hit.pack.packId, packVersion: hit.pack.version, packSha256: hit.pack.dbSha256, entryId: hit.entry.id, senseId: hit.entry.senses[0].id }))
    check(new Set(snapshots.map(item => item.id)).size === chosen.length, 'Selected source/sense results are separate immutable encounters, never merged across editions')
    if (shared) check(new Set(snapshots.map(item => item.explanations[0].pack.glossLanguage)).size > 1, 'English and Chinese entries keep their own source, selected sense and license')
    else report.checks.push('Cross-gloss-language snapshot comparison unavailable: supplied packs have no shared fixed-case hit in multiple gloss languages')
    for (const item of snapshots) {
      learning.edit(item.id, { note: 'Public scale-validation note; not personal data.' })
      check(learning.get(item.id).encounter.explanations[0].sense.glosses.length > 0, 'Committed local definition is readable without the live package result')
    }
    const exportedJson = JSON.parse(dictionaryJson(store.exportSnapshot())), exportedMarkdown = dictionaryMarkdown(store.exportSnapshot())
    check(exportedJson.entries.length === snapshots.length && exportedJson.entries.every(entry => entry.explanation.providerKind === 'offline-dictionary'), 'Production JSON export contains only the saved offline source snapshots')
    check(snapshots.every(item => exportedMarkdown.includes(item.explanations[0].pack.license)), 'Production Markdown export retains the actual source licenses')
    const review = learning.startReview(1)
    check(review.cards.length === snapshots.length && review.cards.every(card => !Object.hasOwn(card, 'explanation') && !Object.hasOwn(card, 'sense')), 'Production review sends source prompts without an unrevealed definition')
    const card = review.cards[0], reveal = learning.reveal(1, review.sessionId, card.encounterId, card.explanationId)
    check(reveal.explanation.providerKind === 'offline-dictionary', 'Explicit reveal reads the committed source/sense version')
    learning.rate(1, review.sessionId, reveal.revealId, 'recalled')
    check(store.exportSnapshot().reviews.length === 1, 'Explicit self-report commits one review event without a provider')
    learning.endReview(1, review.sessionId)
    for (const pack of installed) packs.uninstall(pack.manifest.packId)
    for (const item of snapshots) assert.deepEqual(learning.get(item.id).encounter.explanations, item.explanations)
    check(packs.list().length === 0, 'Full installed source packages can be uninstalled after connections are used')
    report.checks.push('Uninstalling every package leaves the selected definition/license/context snapshots unchanged')
    check(learning.startReview(2).cards.length === snapshots.length, 'Saved full-pack snapshot cards remain reviewable after uninstall')
    report.learningChain = { sourceCaseId: candidate.id, chosenSources: snapshots.map(item => ({ encounterId: item.id, packId: item.explanations[0].pack.packId, glossLanguage: item.explanations[0].pack.glossLanguage, senseId: item.explanations[0].sense.id })), exportEntries: exportedJson.entries.length, reviewEvents: store.exportSnapshot().reviews.length, snapshotsSurviveUninstall: true }
    memory('after-learning-and-uninstall')
    report.memory.sampledPeakIncreaseFromBeforeInstallBytes = report.memory.sampledPeakRssBytes - report.memory.samples[0].rssBytes
    check(report.network.attempts === 0 && report.network.providerCalls === 0, 'Production query, learning, export and review attempted zero network/provider requests')
    report.finishedAt = new Date().toISOString(); report.status = 'passed'
    mkdirSync(options.output, { recursive: true })
    writeFileSync(join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(options.output, 'learning-export.json'), JSON.stringify(exportedJson, null, 2) + '\n')
    writeFileSync(join(options.output, 'learning-export.md'), exportedMarkdown)
    console.log(JSON.stringify({ status: report.status, packages: report.installs.map(pack => ({ id: pack.manifest.packId, bytes: pack.databaseBytes, installMs: pack.installMs })), retrieval: report.retrievalSummary, cold: report.connectionColdFirstLookup.milliseconds, warm: percentiles(warm), sampledPeakRssBytes: report.memory.sampledPeakRssBytes, checks: report.checks.length, network: report.network, output: options.output }, null, 2))
  } catch (error) {
    report.status = 'failed'; report.error = error.message
    mkdirSync(options.output, { recursive: true }); writeFileSync(join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    throw error
  } finally {
    learning?.close(); packs?.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
