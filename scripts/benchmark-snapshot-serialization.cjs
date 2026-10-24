// CPU/wall-clock proxies only: this script never launches Electron or connects to a service.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { serialize, deserialize } = require('node:v8')
const { makeSnapshot, serializationMatrix, partialRates, budgets, fixtureMetadata, sourceRef } = require('../test/benchmarks/snapshot-fixtures.cjs')

const root = resolve(__dirname, '..')
const output = join(root, 'artifacts', 'snapshot-benchmark')
const warmups = 5, samples = 30
const hash = value => createHash('sha256').update(value).digest('hex')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
let forbiddenNetworkCalls = 0
globalThis.fetch = () => { forbiddenNetworkCalls++; throw new Error('Network forbidden in snapshot serialization benchmark') }
globalThis.WebSocket = class { constructor() { forbiddenNetworkCalls++; throw new Error('WebSocket forbidden in snapshot serialization benchmark') } }

function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1]
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) }
}

function validate(snapshot, row) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['settings', 'state', 'message', 'captions', 'partial', 'collapsed'].sort())
  assert.equal(snapshot.captions.length, row.historyCount + 1)
  assert.equal(snapshot.captions.filter(caption => caption.saved).length, Math.max(0, row.historyCount - 150))
  assert.equal(snapshot.settings.hasAsrKey, false)
  assert.equal(snapshot.settings.hasTranslationKey, false)
  const arrays = new Set([snapshot.settings.targetLanguages])
  const translations = new Set()
  for (const caption of snapshot.captions) {
    assert.equal(caption.original.length, 96)
    assert.ok(!/[\uD800-\uDFFF]/u.test(caption.original), 'Unpaired surrogate in original')
    assert.equal(caption.targetLanguages.length, row.targetCount)
    assert.ok(!arrays.has(caption.targetLanguages), 'Aliased target language array')
    arrays.add(caption.targetLanguages)
    assert.ok(!translations.has(caption.translations), 'Aliased translation object')
    translations.add(caption.translations)
    assert.deepEqual(Object.keys(caption.translations), caption.targetLanguages)
    for (const text of Object.values(caption.translations)) {
      assert.equal(text.length, 160)
      assert.ok(!/[\uD800-\uDFFF]/u.test(text), 'Unpaired surrogate in translation')
    }
    for (const code of ['zh', 'en', 'ja']) assert.equal(caption[code], caption.translations[code] || '')
    if (caption.jaSegments) assert.equal(caption.jaSegments.map(segment => segment.text).join(''), caption.ja)
  }
  assert.ok(!Object.keys(snapshot.settings).some(key => /apiKey|asrKey|translationKey/.test(key)), 'Key field in synthetic settings')
}

function main() {
  mkdirSync(output, { recursive: true })
  assert.equal(git(['rev-parse', sourceRef]).trim(), sourceRef)
  const pinnedSources = Object.fromEntries(['src/shared/types.ts', 'src/main/index.ts', 'src/preload/index.ts', 'package.json', 'package-lock.json'].map(path => {
    const pinned = git(['show', `${sourceRef}:${path}`])
    return [path, { gitBlob: git(['rev-parse', `${sourceRef}:${path}`]).trim(), pinnedSha256: hash(pinned), worktreeSha256: hash(readFileSync(join(root, path))) }]
  }))
  const report = readFileSync(join(root, 'docs/snapshot-benchmark.md'), 'utf8')
  const budgetSection = report.split('## 数据采集前确定的工程预算\n')[1]?.split('## 固定来源与共享 fixture')[0]
  assert.ok(budgetSection, 'Write the pre-measurement budget before timing')
  const plan = {
    startedAt: new Date().toISOString(), sourceRef, pinnedSources, warmups, samples,
    fixtureMetadata, budgets, budgetSectionSha256: hash(budgetSection),
    fixtureSha256: hash(readFileSync(join(root, 'test/benchmarks/snapshot-fixtures.cjs'))),
    driverSha256: hash(readFileSync(__filename)),
    environment: { platform: process.platform, arch: process.arch, node: process.version, v8: process.versions.v8, electronPackage: require('../package.json').devDependencies.electron, reactPackage: require('../package.json').devDependencies.react },
    percentile: 'Nearest rank: sorted[ceil(n*p)-1]; 30 samples, p95 is sample rank 29.',
    measurements: {
      jsonUtf8: 'JSON.stringify(snapshot), then Buffer.from(json, utf8); payload is actual Buffer length.',
      v8Serialize: 'node:v8.serialize(snapshot); payload is actual Buffer length.',
      structuredClone: 'global structuredClone(snapshot); no serialized byte buffer or wire payload measured.',
      wall: 'performance.now() around one synchronous operation; includes allocation/GC/preemption.',
      processCpu: 'process.cpuUsage delta (user + system); a process-wide proxy, not an exclusive main-thread counter.',
      cadence: '5/20/60 payload-byte rates are arithmetic extrapolations, not scheduled sends or wire measurements.',
    },
    license: 'CC-BY-NC-4.0; original benchmark code and synthetic fixtures; no third-party implementation copied.',
  }
  // Persist the budget and method before the first warmup/sample.
  writeFileSync(join(output, 'serialization-plan.json'), JSON.stringify(plan, null, 2) + '\n')
  const operations = [
    { id: 'json-utf8', encode: value => Buffer.from(JSON.stringify(value), 'utf8'), decode: value => JSON.parse(value.toString('utf8')) },
    { id: 'v8-serialize', encode: value => serialize(value), decode: value => deserialize(value) },
    { id: 'structured-clone', encode: value => structuredClone(value), decode: value => value },
  ]
  const rows = [], payloads = []
  let sink = 0
  for (const row of serializationMatrix) {
    const snapshot = makeSnapshot(row)
    validate(snapshot, row)
    const original = structuredClone(snapshot)
    const jsonBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    const v8Bytes = serialize(snapshot).length
    payloads.push({ ...row, totalCaptions: snapshot.captions.length, jsonBytes, v8Bytes,
      derivedPayloadBytesPerSecond: partialRates.map(partialHz => ({ partialHz, json: jsonBytes * partialHz, v8: v8Bytes * partialHz })) })
    for (const operation of operations) {
      const consume = value => { sink ^= Buffer.isBuffer(value) ? value.length : value.captions.length + value.settings.targetLanguages.length }
      assert.deepEqual(operation.decode(operation.encode(snapshot)), snapshot)
      for (let index = 0; index < warmups; index++) consume(operation.encode(snapshot))
      const wall = [], cpu = []
      for (let index = 0; index < samples; index++) {
        const cpuStart = process.cpuUsage()
        const start = performance.now()
        const encoded = operation.encode(snapshot)
        wall.push(performance.now() - start)
        const elapsedCpu = process.cpuUsage(cpuStart)
        cpu.push((elapsedCpu.user + elapsedCpu.system) / 1000)
        consume(encoded)
      }
      assert.deepEqual(snapshot, original, 'Serialization benchmark mutated its input')
      rows.push({ ...row, totalCaptions: snapshot.captions.length, operation: operation.id,
        payloadBytes: operation.id === 'json-utf8' ? jsonBytes : operation.id === 'v8-serialize' ? v8Bytes : null,
        wallMs: summary(wall), processCpuMs: summary(cpu), rawWallMs: wall, rawProcessCpuMs: cpu })
    }
  }
  assert.equal(forbiddenNetworkCalls, 0)
  const results = { ...plan, completedAt: new Date().toISOString(), forbiddenNetworkCalls, sink, payloads, rows }
  writeFileSync(join(output, 'serialization-results.json'), JSON.stringify(results, null, 2) + '\n')
  const columns = ['historyCount', 'targetCount', 'totalCaptions', 'operation', 'payloadBytes', 'wallMeanMs', 'wallP50Ms', 'wallP95Ms', 'wallMaxMs', 'cpuMeanMs', 'cpuP50Ms', 'cpuP95Ms', 'cpuMaxMs']
  const values = rows.map(row => [row.historyCount, row.targetCount, row.totalCaptions, row.operation, row.payloadBytes ?? '', ...['mean', 'p50', 'p95', 'max'].map(key => row.wallMs[key]), ...['mean', 'p50', 'p95', 'max'].map(key => row.processCpuMs[key])])
  writeFileSync(join(output, 'serialization-results.csv'), [columns.join(','), ...values.map(row => row.join(','))].join('\n') + '\n')
  const table = [
    '| History | Targets | Total captions | Operation | Payload bytes | Mean ms | p50 ms | p95 ms | Max ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.historyCount} | ${row.targetCount} | ${row.totalCaptions} | ${row.operation} | ${row.payloadBytes ?? '—'} | ${['mean', 'p50', 'p95', 'max'].map(key => row.wallMs[key].toFixed(3)).join(' | ')} |`),
  ].join('\n')
  writeFileSync(join(output, 'serialization-table.md'), table + '\n')
  for (const name of ['LICENSE', 'NOTICE.md']) writeFileSync(join(output, name), git(['show', `${sourceRef}:${name}`]))
  console.log(`Snapshot serialization: ${rows.length} rows, ${rows.length * warmups} warmups, ${rows.length * samples} timed samples; network calls ${forbiddenNetworkCalls}.`)
  console.log('CPU/wall proxies only; JSON/V8 byte lengths are not Electron Mojo wire or network bytes.')
  console.log(table)
}

try { main() } catch (error) { console.error(error.stack || error.message); process.exitCode = 1 }
