// Real Electron main-process orchestrator. Only benchmark facades touch test state.
const { app, ipcMain, session } = require('electron')
const { join } = require('node:path')
const { readFileSync } = require('node:fs')
const { serialize } = require('node:v8')
const { performance } = require('node:perf_hooks')
const assert = require('node:assert/strict')
const os = require('node:os')
const directory = process.env.LINGOBAR_SNAPSHOT_DIR
const origin = process.env.LINGOBAR_SNAPSHOT_ORIGIN
if (!directory || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Use scripts/benchmark-snapshot-ipc.cjs')
const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
const { makeSnapshot, fixtureMetadata, budgets } = require(join(config.root, 'test/benchmarks/snapshot-fixtures.cjs'))
app.setPath('userData', process.env.LINGOBAR_TEST_DATA)
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
let fetchAttempts = 0
globalThis.fetch = () => { fetchAttempts++; throw new Error('Provider/network fetch is disabled in the snapshot benchmark') }
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
const round = value => Math.round(value * 100000) / 100000
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = p => sorted.length ? round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]) : null
  return { n: sorted.length, min: rank(0), p50: rank(.5), p95: rank(.95), max: rank(1),
    mean: sorted.length ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null }
}
let hooks, window, ready = false, ordinal = 0, rawOrdinal = 0, bridgeOrdinal = 0, current = null
const records = new Map(), unexpected = []
const fixtureUrl = `${origin}/test/benchmarks/snapshot-ipc.html`
const trusted = event => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === fixtureUrl
ipcMain.handle('snapshot-bench:ready', event => { assert.ok(trusted(event)); ready = true; return true })
ipcMain.on('snapshot-bench:ack', (event, ack) => {
  assert.ok(trusted(event), 'Only the benchmark main frame may acknowledge')
  assert.ok(ack && Number.isSafeInteger(ack.ordinal), 'Invalid ACK')
  const record = records.get(ack.ordinal)
  assert.ok(record, `ACK without a matching send: ${ack.ordinal}`)
  if (ack.kind === 'raw') {
    assert.equal(ack.ordinal, ++rawOrdinal, 'Raw ACK FIFO/count mismatch')
    assert.equal(record.rawAt, undefined, 'Duplicate raw ACK')
    record.rawAt = performance.now()
  } else {
    assert.equal(ack.kind, 'bridge')
    assert.equal(ack.ordinal, ++bridgeOrdinal, 'Bridge ACK FIFO/count mismatch')
    assert.equal(record.bridgeAt, undefined, 'Duplicate bridge ACK')
    assert.equal(ack.observed, true, 'ACK microtask preceded the real production bridge callback')
    assert.equal(ack.summary.count, ack.ordinal, 'Expected exactly one main-world callback per send')
    record.bridgeAt = performance.now()
    record.summary = ack.summary // Synthetic and transient; never emitted per-frame in artifacts.
  }
})

async function drained(caseState, timeout = 30000) {
  const deadline = performance.now() + timeout
  while (caseState.records.some(record => record.rawAt === undefined || record.bridgeAt === undefined)) {
    assert.ok(performance.now() < deadline, `Unacknowledged snapshot messages in ${caseState.label}`)
    await delay(5)
  }
}

async function terminal(caseState, label, invoke, predicate) {
  caseState.phase = `terminal-${label}`
  const before = caseState.records.length
  const started = performance.now()
  invoke()
  await drained(caseState)
  const sent = caseState.records.slice(before)
  const matching = sent.filter(record => predicate(record.summary))
  assert.ok(matching.length, `Lost terminal ${label} snapshot`)
  assert.equal(sent.length, sent.filter(record => record.bridgeAt !== undefined && record.rawAt !== undefined).length)
  return { label, sendCount: sent.length, ackCount: sent.length,
    firstMatchingBridgeAckMs: round(Math.min(...matching.map(record => record.bridgeAt)) - started),
    lastBridgeAckMs: round(Math.max(...sent.map(record => record.bridgeAt)) - started) }
}

function pendingCounts(records) {
  return { raw: records.filter(record => record.rawAt === undefined).length,
    bridge: records.filter(record => record.bridgeAt === undefined).length }
}

// Keep all critical calls synchronous in one main-process turn. Only their own
// synchronous send ranges are attributed to them; later timer sends are separate.
async function criticalTerminals(caseState, calls) {
  const boundary = { pendingAtTerminal: pendingCounts(caseState.records),
    sendsBeforeTerminal: caseState.records.length, synchronousSendCount: 0, asynchronousExtraSendCount: 0 }
  const invoked = []
  for (const [label, invoke, predicate] of calls) {
    caseState.phase = `critical-${label}`
    const before = caseState.records.length, pendingAtCall = pendingCounts(caseState.records), started = performance.now()
    invoke()
    const callDurationMs = performance.now() - started
    const sent = caseState.records.slice(before)
    assert.ok(sent.length, `No synchronous send for critical ${label}`)
    invoked.push({ label, started, callDurationMs, sent, predicate, pendingAtCall })
    boundary.synchronousSendCount += sent.length
  }
  const synchronousEnd = caseState.records.length
  caseState.phase = 'critical-terminal-drain'
  await drained(caseState)
  boundary.asynchronousExtraSendCount = caseState.records.length - synchronousEnd
  boundary.pendingAfterDrain = pendingCounts(caseState.records)
  return { boundary, results: invoked.map(({ label, started, callDurationMs, sent, predicate, pendingAtCall }) => {
    const matching = sent.filter(record => predicate(record.summary))
    assert.ok(matching.length, `Lost critical terminal ${label} snapshot within its synchronous send range`)
    assert.ok(sent.every(record => record.rawAt !== undefined && record.bridgeAt !== undefined))
    return { label, sendCount: sent.length, ackCount: sent.length,
      firstSendOrdinal: sent[0].ordinal, lastSendOrdinal: sent.at(-1).ordinal,
      pendingAtCall, callDurationMs: round(callDurationMs),
      firstMatchingBridgeAckMs: round(Math.min(...matching.map(record => record.bridgeAt)) - started),
      lastBridgeAckMs: round(Math.max(...sent.map(record => record.bridgeAt)) - started) }
  }) }
}

async function runCase(row, repeat, index) {
  const label = `${config.variant}:${row.historyCount}/${row.targetCount}/${row.partialHz}:r${repeat}`
  const caseState = { label, phase: 'setup', records: [], snapshotBuildMs: [], partialMs: [] }
  current = caseState
  globalThis.__snapshotMeasurement = caseState
  hooks.reset(makeSnapshot({ ...row, includeLive: false, state: 'listening' }))
  const textFor = revision => makeSnapshot({ historyCount: 0, targetCount: row.targetCount, includeLive: true, revision }).captions[0].original
  const texts = Array.from({ length: row.partialHz + 1 }, (_, revision) => textFor(revision))
  const utterance = `synthetic-case-${index}-r${repeat}`
  caseState.phase = 'warmup'
  hooks.partial(texts[0], utterance)
  await delay(config.warmupMs)
  await drained(caseState)
  const representative = hooks.snapshot()
  assert.equal(representative.captions.length, row.historyCount + 1)
  const liveId = representative.captions.at(-1).id
  const representativeJsonUtf8Bytes = Buffer.byteLength(JSON.stringify(representative))
  const representativeV8Bytes = serialize(representative).byteLength
  const partialStart = caseState.records.length
  caseState.phase = 'partial'
  const started = performance.now(), deadline = started + config.durationMs
  let lastInputEnd = started, logicalInputs = 0
  const inputLatenessMs = []
  for (let index = 0; index < row.partialHz; index++) {
    const scheduled = started + index * 1000 / row.partialHz
    await delay(scheduled - performance.now())
    if (performance.now() >= deadline && index > 0) break
    inputLatenessMs.push(Math.max(0, performance.now() - scheduled))
    const before = caseState.records.length, callStarted = performance.now()
    hooks.partial(texts[index + 1], utterance)
    lastInputEnd = performance.now()
    caseState.partialMs.push(lastInputEnd - callStarted)
    logicalInputs++
    assert.equal(caseState.records.length - before, config.variant === 'baseline' ? 2 : 1,
      'Only the trailing synchronous nonempty onPartial publish may differ in the control')
  }
  await delay(deadline - performance.now())
  const windowEnded = performance.now()
  caseState.phase = 'drain'
  const partialRecords = caseState.records.slice(partialStart)
  const bridgeAcksWithinWindow = partialRecords.filter(record => record.bridgeAt !== undefined && record.bridgeAt <= windowEnded).length
  if (!config.criticalUnderLoad) await drained(caseState)

  const beforeStale = caseState.records.length
  hooks.partial('', 'stale-synthetic-utterance')
  assert.equal(caseState.records.length, beforeStale, 'A stale empty partial must keep its production early return')
  const finalText = texts[Math.min(logicalInputs, texts.length - 1)] + ' synthetic final boundary'
  const statusMessage = `Synthetic terminal status ${index}`
  const errorMessage = `Synthetic terminal error ${index}`
  const terminalCalls = [
    ['empty-partial', () => hooks.partial('', utterance), summary => summary.partial === ''],
    ['final', () => hooks.final(finalText, utterance), summary => summary.captionId === liveId && summary.original === finalText && summary.live === false],
    ['status', () => hooks.status('idle', statusMessage), summary => summary.state === 'idle' && summary.message === statusMessage],
    ['error', () => hooks.error(errorMessage), summary => summary.state === 'error' && summary.message === errorMessage]
  ]
  let terminalResults, criticalUnderLoad
  if (config.criticalUnderLoad) {
    const batch = await criticalTerminals(caseState, terminalCalls)
    terminalResults = batch.results
    criticalUnderLoad = batch.boundary
  } else {
    terminalResults = []
    for (const call of terminalCalls) terminalResults.push(await terminal(caseState, ...call))
  }
  const lastBridge = Math.max(lastInputEnd, ...partialRecords.map(record => record.bridgeAt))
  const drainAfterLastInputMs = round(lastBridge - lastInputEnd)
  caseState.phase = 'cleanup'
  hooks.close()
  await delay(20)
  await drained(caseState)
  const countAfterClose = caseState.records.length
  await delay(10)
  assert.equal(caseState.records.length, countAfterClose, 'Closed queue leaked callbacks into the next case')

  const mainPartialMs = distribution(caseState.partialMs)
  const snapshotBuildMs = distribution(caseState.snapshotBuildMs)
  const sendMs = distribution(partialRecords.map(record => record.sendMs))
  const rawAckRttMs = distribution(partialRecords.map(record => record.rawAt - record.started))
  const bridgeAckRttMs = distribution(partialRecords.map(record => record.bridgeAt - record.started))
  const terminalAckMaxMs = Math.max(...terminalResults.map(result => result.lastBridgeAckMs))
  const achieved = logicalInputs / ((windowEnded - started) / 1000)
  const result = { repeat, historyCount: row.historyCount, targetCount: row.targetCount, partialHz: row.partialHz,
    logicalInputs, requestedInputCount: row.partialHz, timedWindowMs: round(windowEnded - started), achievedLogicalHz: round(achieved),
    partialSends: partialRecords.length, bridgeAcksWithinWindow, partialRawAckCount: partialRecords.length,
    partialBridgeAckCount: partialRecords.length, allSendCount: caseState.records.length,
    sendThroughputPerSecond: round(partialRecords.length / ((windowEnded - started) / 1000)),
    bridgeAckThroughputPerSecondWithinWindow: round(bridgeAcksWithinWindow / ((windowEnded - started) / 1000)),
    representativeJsonUtf8Bytes, representativeV8Bytes,
    estimatedJsonPayloadBytesSent: representativeJsonUtf8Bytes * partialRecords.length,
    estimatedV8PayloadBytesSent: representativeV8Bytes * partialRecords.length,
    mainPartialMs, snapshotBuildMs, sendMs, rawAckRttMs, bridgeAckRttMs, inputLatenessMs: distribution(inputLatenessMs),
    mainPartialP95Ms: mainPartialMs.p95, sendP95Ms: sendMs.p95, rawAckRttP95Ms: rawAckRttMs.p95,
    bridgeAckRttP95Ms: bridgeAckRttMs.p95, terminalAckMaxMs: round(terminalAckMaxMs), drainAfterLastInputMs,
    terminals: terminalResults, ...(criticalUnderLoad ? { criticalUnderLoad } : {}),
    correctness: { lostTerminalEvents: 0, duplicateAcks: 0, fifo: true, oneBridgeCallbackPerSend: true, staleEmptyPartialDropped: true },
    diagnostics: { mainPartialWithinBudget: mainPartialMs.p95 <= budgets.mainPublishPerPartialMs,
      bridgeAckWithinBudget: bridgeAckRttMs.p95 <= budgets.bridgeAckP95Ms,
      terminalAckWithinBudget: terminalAckMaxMs <= budgets.terminalAckMs,
      drainWithinBudget: drainAfterLastInputMs <= budgets.drainAfterLastInputMs,
      encodeBudget: 'Not isolated from Electron send; use separate serialization proxy results.' } }
  current = null
  globalThis.__snapshotMeasurement = null
  return result
}

async function main() {
  assert.equal(process.versions.electron, '43.8.3', 'Re-review bridge instrumentation when updating Electron')
  for (const forbidden of ['use-fake-ui-for-media-stream', 'auto-accept-camera-and-microphone-capture', 'use-fake-device-for-media-stream'])
    assert.equal(app.commandLine.hasSwitch(forbidden), false, 'No media device/UI switches are used')
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, respond) => {
    let allowed = false
    try { const url = new URL(details.url); allowed = url.origin === origin } catch {}
    respond({ cancel: !allowed })
  })
  session.defaultSession.setPermissionRequestHandler((_c, _p, respond) => respond(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  require(config.bundle)
  const startupDeadline = performance.now() + 20000
  while (!globalThis.__snapshotBenchHooks?.ready()) { assert.ok(performance.now() < startupDeadline); await delay(5) }
  hooks = globalThis.__snapshotBenchHooks
  window = hooks.window()
  const originalSend = window.webContents.send.bind(window.webContents)
  window.webContents.send = (channel, ...args) => {
    if (channel !== 'lingo:changed') return originalSend(channel, ...args)
    const record = { ordinal: ++ordinal, started: performance.now(), phase: current?.phase || 'unexpected' }
    records.set(record.ordinal, record)
    if (current) current.records.push(record)
    else unexpected.push(record.ordinal)
    try { return originalSend(channel, ...args) }
    finally { record.sendMs = performance.now() - record.started }
  }
  while (!ready) { assert.ok(performance.now() < startupDeadline, 'Renderer/preload startup failed'); await delay(5) }
  const cases = []
  for (let repeat = 1; repeat <= config.repeats; repeat++) {
    for (const [index, row] of config.cases.entries()) {
      cases.push(await runCase(row, repeat, index))
      console.log(`SNAPSHOT_PROGRESS:${config.variant} ${cases.length}/${config.cases.length * config.repeats} ${row.historyCount}/${row.targetCount}/${row.partialHz}`)
    }
  }
  assert.equal(unexpected.length, 0, 'Unexpected publish outside case isolation')
  assert.equal(rawOrdinal, ordinal)
  assert.equal(bridgeOrdinal, ordinal)
  assert.equal(fetchAttempts, 0)
  console.log('SNAPSHOT_RESULT:' + JSON.stringify({ variant: config.variant, sourceRef: config.sourceRef,
    compiledBundleHash: config.compiledBundleHash, harnessSources: config.harnessSources,
    productionMainHash: config.productionMainHash, compiledMainHash: config.compiledMainHash,
    productionPreloadHash: config.productionPreloadHash, productionSources: config.productionSources,
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      platform: process.platform, arch: process.arch, osRelease: os.release(), cpuModel: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, hiddenWindow: true, transparentWindow: true, backgroundThrottling: false,
      disableRendererBackgrounding: true, scope: 'Container synthetic real IPC; no React render, hardware, audio, provider or ASR network.' },
    instrumentation: { source: 'Exact git modules plus appended hooks; real production snapshot/publish/onPartial and preload',
      control: config.variant === 'baseline' ? 'Unmodified production onPartial' : 'Only trailing publish becomes if (!text.trim()) publish(); no frame merging',
      facades: ['AudioEngine callback capture/idle stop callback', 'Tray/menu/shortcut/display/clipboard/export', 'abortable pending translator', 'permission requests/checks forced deny'],
      blockedTranslationStarts: globalThis.__snapshotBlockedTranslationStarts || 0, providerFetchAttempts: fetchAttempts,
      fullSnapshotBridgeSubscribers: 1, rawIpcListeners: 1, ackClock: 'main performance.now() only; RTT includes main busy queue and tiny return ACK',
      bridgeObservation: 'Production main-world listener, then tiny summary crossing and preload post-listener microtask ACK',
      percentiles: 'nearest-rank; low-N one-second descriptive samples', payloadSizes: 'Representative JSON UTF-8/V8 proxies only; not Electron wire bytes' },
    fixtureMetadata, ackSummary: { sends: ordinal, rawAcks: rawOrdinal, bridgeAcks: bridgeOrdinal, fifo: true, unexpectedPublishes: unexpected.length }, cases }))
  window.destroy()
  app.quit()
}
main().catch(error => { console.error(error.stack || error.message); app.exit(1) })
