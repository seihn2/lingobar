// Real Electron transport benchmark. Synthetic text only; never audio or providers.
const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, relative } = require('node:path')
const assert = require('node:assert/strict')
const { build } = require('esbuild')
const fixtures = require('../test/benchmarks/snapshot-fixtures.cjs')
const root = resolve(__dirname, '..')
const benchmark = join(root, 'test', 'benchmarks')
const sha = value => createHash('sha256').update(value).digest('hex')

function options() {
  const value = { case: 'all', variant: 'both', repeat: 1, durationMs: 1000,
    output: join(root, 'artifacts', 'snapshot-benchmark'), ref: fixtures.sourceRef, plan: false, criticalUnderLoad: false }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan') { value.plan = true; continue }
    if (args[i] === '--critical-under-load') { value.criticalUnderLoad = true; continue }
    const key = { '--case': 'case', '--variant': 'variant', '--repeat': 'repeat', '--duration-ms': 'durationMs', '--output': 'output', '--ref': 'ref' }[args[i]]
    assert.ok(key && args[i + 1], `Unknown or incomplete argument: ${args[i]}`)
    value[key] = ['repeat', 'durationMs'].includes(key) ? Number(args[++i]) : args[++i]
  }
  assert.ok(['all', 'reference', 'control', 'stress'].includes(value.case))
  assert.ok(['both', 'baseline', 'single-publish-control'].includes(value.variant))
  assert.ok(Number.isInteger(value.repeat) && value.repeat >= 1 && value.repeat <= 3)
  assert.ok(value.case !== 'all' || value.repeat === 1, 'Repeat only selected cases, not the full matrix')
  assert.ok(value.durationMs === 1000, 'Timed input windows are fixed at 1000ms')
  assert.ok(/^[0-9a-f]{40}$/i.test(value.ref), '--ref must be a full immutable commit SHA')
  value.output = resolve(value.output)
  return value
}

async function main() {
  const opt = options()
  const cases = opt.case === 'all' ? (opt.criticalUnderLoad ? [fixtures.budgets.reference, fixtures.budgets.stress] : fixtures.matrix) : [fixtures.budgets[opt.case]]
  const variants = opt.variant === 'both' ? ['baseline', 'single-publish-control'] : [opt.variant]
  const plan = { sourceRef: opt.ref, cases, variants, repeats: opt.repeat, durationMs: opt.durationMs,
    warmupMs: 100, criticalUnderLoad: opt.criticalUnderLoad, budgets: fixtures.budgets,
    note: 'One-second paced logical partials; no audio, React rendering, provider or hardware acceptance.' }
  if (opt.plan) { console.log(JSON.stringify(plan, null, 2)); return }
  const stem = opt.criticalUnderLoad ? 'ipc-critical' : 'ipc'
  // Preserve the intended matrix before build, child startup, or any warmup.
  mkdirSync(opt.output, { recursive: true })
  writeFileSync(join(opt.output, `${stem}-plan.json`), JSON.stringify(plan, null, 2))
  const temporary = mkdtempSync(join(tmpdir(), 'lingobar-snapshot-ipc-'))
  const source = new Map()
  const sourceAt = path => {
    const key = relative(root, path).replaceAll('\\', '/')
    if (!source.has(key)) source.set(key, execFileSync('git', ['show', `${opt.ref}:${key}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
    return source.get(key)
  }
  let server, child
  const startedAt = new Date().toISOString(), results = []
  try {
    const { createServer } = await import('vite')
    server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0, hmr: false } })
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const prepend = readFileSync(join(benchmark, 'snapshot-ipc-preload.cjs'), 'utf8')
    // Production preload is exact git source, not a rewritten bridge implementation.
    const preloadSource = sourceAt(join(root, 'src', 'preload', 'index.ts'))
    await build({ stdin: { contents: prepend + '\n' + preloadSource, resolveDir: join(root, 'src', 'preload'), loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(temporary, 'preload.cjs'), logLevel: 'silent' })
    for (const variant of variants) {
      const output = join(temporary, `${variant}.cjs`)
      let compiledMainHash
      const plugin = { name: 'snapshot-benchmark-only-facades', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, args => args.importer === join(benchmark, 'snapshot-ipc-electron.cjs')
          ? { path: 'electron', external: true } : { path: join(benchmark, 'snapshot-ipc-electron.cjs') })
        builder.onResolve({ filter: /^\.\/audio$/ }, args => args.importer === join(root, 'src', 'main', 'index.ts')
          ? { path: join(benchmark, 'snapshot-ipc-audio.cjs') } : undefined)
        builder.onLoad({ filter: /\.(ts|tsx)$/ }, args => {
          if (!args.path.startsWith(join(root, 'src') + require('node:path').sep)) return
          let contents = sourceAt(args.path)
          if (args.path === join(root, 'src', 'main', 'index.ts')) {
            const target = '          queue.updatePartial(text, source, utteranceId)\n        }\n        publish()\n'
            assert.equal(contents.split(target).length, 2, 'Expected exactly one production onPartial trailing publish')
            if (variant === 'single-publish-control') contents = contents.replace(target,
              '          queue.updatePartial(text, source, utteranceId)\n        }\n        if (!text.trim()) publish()\n')
            compiledMainHash = sha(contents)
            contents += '\n' + readFileSync(join(benchmark, 'snapshot-ipc-hooks.cjs'), 'utf8')
          }
          if (args.path === join(root, 'src', 'main', 'translation.ts')) contents += `
translateCaption = function (_text, _config, signal) {
  globalThis.__snapshotBlockedTranslationStarts = (globalThis.__snapshotBlockedTranslationStarts || 0) + 1
  return new Promise((_resolve, reject) => {
    const abort = () => { const error = new Error('Synthetic benchmark cancellation'); error.name = 'AbortError'; reject(error) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}
`
          return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: require('node:path').dirname(args.path) }
        })
      } }
      await build({ entryPoints: [join(root, 'src', 'main', 'index.ts')], bundle: true, platform: 'node', format: 'cjs',
        outfile: output, logLevel: 'silent', plugins: [plugin] })
      const config = { ...plan, cases, variant, bundle: output, root, compiledMainHash,
        compiledBundleHash: sha(readFileSync(output)),
        harnessSources: Object.fromEntries(['scripts/benchmark-snapshot-ipc.cjs',
          ...['snapshot-ipc-main.cjs', 'snapshot-ipc-electron.cjs', 'snapshot-ipc-audio.cjs', 'snapshot-ipc-hooks.cjs',
            'snapshot-ipc-preload.cjs', 'snapshot-ipc-renderer.js', 'snapshot-ipc.html', 'snapshot-fixtures.cjs'].map(name => `test/benchmarks/${name}`)]
          .map(path => [path, sha(readFileSync(join(root, path)))])),
        productionMainHash: sha(sourceAt(join(root, 'src', 'main', 'index.ts'))),
        productionPreloadHash: sha(preloadSource), productionSources: Object.fromEntries([...source].map(([path, text]) => [path, sha(text)])) }
      writeFileSync(join(temporary, 'config.json'), JSON.stringify(config))
      const env = { ...process.env, LINGOBAR_SNAPSHOT_DIR: temporary, LINGOBAR_SNAPSHOT_ORIGIN: origin,
        LINGOBAR_SNAPSHOT_PRELOAD: join(temporary, 'preload.cjs'), LINGOBAR_TEST_DATA: join(temporary, `profile-${variant}`),
        ELECTRON_RENDERER_URL: `${origin}/test/benchmarks/snapshot-ipc.html`, XDG_CACHE_HOME: join(temporary, 'cache') }
      delete env.ELECTRON_RUN_AS_NODE
      let stdout = '', diagnostics = ''
      const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), join(benchmark, 'snapshot-ipc-main.cjs')]
      const result = await new Promise((resolveRun, reject) => {
        child = spawn(require('electron'), args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const deadline = setTimeout(() => { child.kill(); reject(new Error(`Snapshot benchmark safety deadline: ${diagnostics}`)) }, 170000)
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
        child.stdout.on('data', data => {
          stdout = (stdout + data).slice(-4 * 1024 * 1024)
          for (const line of data.split('\n')) if (line.startsWith('SNAPSHOT_PROGRESS:')) console.log(line)
        })
        child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-10000) })
        child.once('error', error => { clearTimeout(deadline); reject(error) })
        child.once('close', code => {
          clearTimeout(deadline)
          try {
            assert.equal(code, 0, `Electron benchmark failed: ${diagnostics}\n${stdout.slice(-5000)}`)
            const line = stdout.split('\n').find(line => line.startsWith('SNAPSHOT_RESULT:'))
            assert.ok(line, 'No structured Electron benchmark result')
            resolveRun(JSON.parse(line.slice('SNAPSHOT_RESULT:'.length)))
          } catch (error) { reject(error) }
        })
      })
      results.push(result)
    }
    mkdirSync(opt.output, { recursive: true })
    const report = { startedAt, finishedAt: new Date().toISOString(), plan, results,
      boundaries: [
        'Real Electron main send, IPC, production preload, contextBridge and one passive main-world callback; no React render or DOM timing.',
        'Raw and bridge ACK RTTs use only the main process performance clock and include main-thread busy time plus the tiny ACK return path.',
        'Bridge ACK is a preload microtask after its production listener and scalar-summary callback observation; no second full-snapshot bridge subscriber.',
        'JSON UTF-8 and V8 serialization sizes are untimed representative payload proxies, not Electron/Mojo wire bytes.',
        'Benchmark-only AudioEngine/OS facades and abortable pending translator replace devices/providers; CaptionQueue timers and production callbacks remain real.',
        'Diagnostic budgets never fail machine performance; count/ordering/terminal correctness failures do fail.',
        'The real hidden transparent window uses backgroundThrottling:false and disable-renderer-backgrounding as a foreground-like experiment, not hidden-window default behavior.',
        'Nearest-rank descriptive percentiles; 5Hz windows have about five logical samples, without cross-machine confidence claims.'
      ] }
    writeFileSync(join(opt.output, `${stem}-results.json`), JSON.stringify(report, null, 2))
    writeFileSync(join(opt.output, `${stem}-plan.json`), JSON.stringify(plan, null, 2))
    const rows = results.flatMap(result => result.cases.map(row => ({ variant: result.variant, ...row })))
    const columns = ['variant', 'repeat', 'historyCount', 'targetCount', 'partialHz', 'requestedInputCount', 'logicalInputs', 'timedWindowMs', 'achievedLogicalHz', 'partialSends', 'bridgeAcksWithinWindow', 'sendThroughputPerSecond', 'bridgeAckThroughputPerSecondWithinWindow', 'representativeJsonUtf8Bytes', 'representativeV8Bytes', 'estimatedJsonPayloadBytesSent', 'estimatedV8PayloadBytesSent', 'mainPartialP95Ms', 'sendP95Ms', 'rawAckRttP95Ms', 'bridgeAckRttP95Ms', 'terminalAckMaxMs', 'drainAfterLastInputMs']
    writeFileSync(join(opt.output, `${stem}-results.csv`), columns.join(',') + '\n' + rows.map(row => columns.map(key => row[key]).join(',')).join('\n') + '\n')
    console.log(`Snapshot IPC benchmark complete: ${rows.length} windows; ${join(opt.output, `${stem}-results.json`)}`)
  } finally {
    if (child && child.exitCode === null) child.kill()
    if (server) await server.close()
    rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
