// Offline fake-clock comparison. Reads pinned git source, never mutates production src.
const { build } = require('esbuild')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve, posix } = require('node:path')
const experiments = require('../test/benchmarks/experiments.cjs')

const root = resolve(__dirname, '..')
const ref = '2a42a485ec177f320823773afdd2bf13b03770f1'
const output = join(root, 'artifacts', 'caption-benchmark')
const hash = text => createHash('sha256').update(text).digest('hex')
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const sources = new Map()
const sourceAt = path => {
  if (!sources.has(path)) sources.set(path, git(['show', `${ref}:${path}`]))
  return sources.get(path)
}

async function main() {
  mkdirSync(output, { recursive: true })
  if (git(['rev-parse', ref]).trim() !== ref) throw new Error('Pinned baseline commit is unavailable')
  const original = sourceAt('src/main/captions.ts')
  const worktreeSourceHash = hash(readFileSync(join(root, 'src/main/captions.ts')))
  const variants = []
  for (const experiment of experiments) {
    let source = original
    if (experiment.insertion) {
      if (source.split(experiment.needle).length !== 2) throw new Error('Experiment insertion anchor must match exactly once')
      source = source.replace(experiment.needle, experiment.needle + experiment.insertion)
    }
    const modulePath = join(output, `${experiment.id}.cjs`)
    const result = await build({
      entryPoints: ['benchmark:captions'], bundle: true, platform: 'node', format: 'cjs', write: false,
      plugins: [{
        name: 'pinned-offline-source',
        setup(builder) {
          builder.onResolve({ filter: /^benchmark:captions$/ }, () => ({ path: 'src/main/captions.ts', namespace: 'pinned' }))
          builder.onResolve({ filter: /^\./, namespace: 'pinned' }, args => {
            let path = posix.normalize(posix.join(posix.dirname(args.importer), args.path))
            if (!path.endsWith('.ts')) path += '.ts'
            return { path, namespace: 'pinned' }
          })
          builder.onLoad({ filter: /.*/, namespace: 'pinned' }, args => ({
            loader: 'ts', contents: args.path === 'src/main/diagnostics.ts'
              ? 'export function trace(event, fields) { globalThis.__captionBenchmarkTrace?.(event, fields) }'
              : args.path === 'src/main/captions.ts' ? source : sourceAt(args.path),
          }))
        },
      }],
    })
    writeFileSync(modulePath, result.outputFiles[0].text)
    variants.push({ id: experiment.id, label: experiment.label, modulePath, sourceSha256: hash(source), insertionSha256: hash(experiment.insertion) })
  }
  // Keep attribution with generated source modules when the evidence is shared as an artifact.
  for (const name of ['LICENSE', 'NOTICE.md']) writeFileSync(join(output, name), sourceAt(name))
  const manifest = {
    baselineRef: ref, captionGitBlob: git(['rev-parse', `${ref}:src/main/captions.ts`]).trim(),
    captionSourceSha256: hash(original), variants,
    pinnedSources: Object.fromEntries([...sources].map(([path, text]) => [path, hash(text)])),
    environment: { node: process.version, platform: process.platform, arch: process.arch, esbuild: require('esbuild').version, vitest: require('vitest/package.json').version },
    note: 'Deterministic fake-clock service models only. No provider requests, audio, tokens or billing measurement.',
  }
  const manifestPath = join(output, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  execFileSync(process.execPath, [vitest, 'run', '--config', 'test/benchmarks/vitest.config.ts'], {
    cwd: root, stdio: 'inherit', timeout: 120000,
    env: { ...process.env, LINGOBAR_CAPTION_BENCHMARK_MANIFEST: manifestPath },
  })
  const report = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8'))
  const headers = ['model', 'scenario', 'variant', 'draftRequests', 'liveFinalRequests', 'liveRequests', 'allRequests', 'sourceUtf16', 'sourceUtf8Bytes', 'firstAnyMs', 'firstFreshMs', 'firstPublishedAnyLanguageMs', 'lastPartialFreshMs', 'finalMs', 'maxActive', 'maxWaiting', 'idleActive', 'idleWaiting', 'idleRunning', 'idleTimers', 'sourcePairing', 'providerCalls', 'duplicateRevisionRequests']
  const csv = [headers.join(','), ...report.results.map(row => headers.map(key => row[key] ?? '').join(','))].join('\n') + '\n'
  writeFileSync(join(output, 'results.csv'), csv)
  const groups = []
  for (const row of report.results) if (row.variant === 'baseline') groups.push(report.results.filter(other => other.model === row.model && other.scenario === row.scenario))
  const values = (group, key) => group.map(row => row[key] === null ? '—' : row[key]).join(' / ')
  const latency = ['| Model | Scenario | Draft requests B / S / M | First any ms B / S / M | First fresh ms B / S / M | Last-partial fresh ms B / S / M | Final ms B / S / M |', '| --- | --- | --- | --- | --- | --- | --- |', ...groups.map(group => `| ${group[0].model} | ${group[0].scenario} | ${['draftRequests', 'firstAnyMs', 'firstFreshMs', 'lastPartialFreshMs', 'finalMs'].map(key => values(group, key)).join(' | ')} |`)].join('\n')
  const volume = ['| Model | Scenario | Live requests B / S / M | Source UTF-16 B / S / M | Source UTF-8 bytes B / S / M | Duplicate revision requests B / S / M | Max active B / S / M | Max waiting B / S / M |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...groups.map(group => `| ${group[0].model} | ${group[0].scenario} | ${['liveRequests', 'sourceUtf16', 'sourceUtf8Bytes', 'duplicateRevisionRequests', 'maxActive', 'maxWaiting'].map(key => values(group, key)).join(' | ')} |`)].join('\n')
  writeFileSync(join(output, 'tables.md'), latency + '\n\n' + volume + '\n')
  if (hash(readFileSync(join(root, 'src/main/captions.ts'))) !== worktreeSourceHash) throw new Error('Production CaptionQueue changed during the benchmark')
  console.log(`Caption benchmark: ${report.results.length} runs; baseline ${ref}; source SHA-256 ${manifest.captionSourceSha256}`)
  console.log('Evidence: artifacts/caption-benchmark/{manifest.json,results.json,results.csv,tables.md}')
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
