// Test-only bootstrap. Loads the real built application with an isolated empty profile.
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { syncBuiltinESMExports, Module } = require('node:module')
const electron = require('electron')
const { app, BrowserWindow, dialog, session } = electron
// Native tray/menu surfaces need a display server on Linux. Suppress only those
// OS chrome surfaces; the production window, renderer, preload and IPC stay real.
const fixtureTray = class { setTitle() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} }
const fixtureMenu = { buildFromTemplate: value => value, setApplicationMenu() {} }
const electronFacade = new Proxy(electron, { get: (target, key) => key === 'Tray' ? fixtureTray : key === 'Menu' ? fixtureMenu : target[key] })
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  return request === 'electron' ? electronFacade : originalLoad.call(this, request, parent, isMain)
}
const directory = process.env.LINGOBAR_OFFLINE_FIXTURE_DIR
const phase = process.env.LINGOBAR_OFFLINE_FIXTURE_PHASE
if (!directory || !['fresh', 'restart'].includes(phase)) throw new Error('Use scripts/test-offline-dictionaries.cjs.')
const plan = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8'))
assert.equal(process.env.LINGOBAR_TEST_DATA, join(directory, 'profile'))
const checks = [], network = { main: 0, renderer: 0 }, permissions = { policies: 0, requests: 0 }
const check = (value, label) => { assert.ok(value, label); checks.push(label) }
const forbid = () => { network.main++; throw new Error('External network forbidden in offline Electron acceptance') }
globalThis.fetch = forbid
globalThis.WebSocket = class { constructor() { forbid() } }
require('node:http').request = forbid; require('node:http').get = forbid
require('node:https').request = forbid; require('node:https').get = forbid
require('node:net').Socket.prototype.connect = forbid
require('node:tls').connect = forbid
electron.net.request = forbid; electron.net.fetch = forbid
syncBuiltinESMExports()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
const choices = phase === 'fresh' ? [...plan.packs.map(pack => pack.manifest), plan.large, plan.update, null] : []
dialog.showOpenDialog = async () => {
  assert.ok(choices.length, 'No unplanned file chooser in offline test')
  const path = choices.shift()
  return { canceled: path === null, filePaths: path ? [path] : [] }
}
let saveCounter = 0
let largeBoundary = null
dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(directory, `export-${phase}-${++saveCounter}.${saveCounter === 1 ? 'json' : 'md'}`) })
dialog.showMessageBox = async () => ({ response: 0 })
const pause = () => new Promise(resolve => setTimeout(resolve, 25))

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const protocol = new URL(details.url).protocol
    const allowed = ['file:', 'data:', 'blob:', 'about:'].includes(protocol)
    if (!allowed) network.renderer++
    callback({ cancel: !allowed })
  })
  const original = session.defaultSession.setPermissionRequestHandler.bind(session.defaultSession)
  session.defaultSession.setPermissionRequestHandler = handler => {
    permissions.policies++
    return original((contents, permission, respond, details) => {
      permissions.requests++
      return handler(contents, permission, respond, details)
    })
  }
}).catch(fail)

require(join(plan.root, 'out/main/index.js'))

function fail(error) { console.error(error.stack || error.message); app.exit(1) }
async function run() {
  await app.whenReady()
  let window
  const deadline = Date.now() + 25000
  while (!window || window.webContents.isLoading()) {
    assert.ok(Date.now() < deadline, 'Production application startup stayed within its deadline')
    window = BrowserWindow.getAllWindows()[0]
    await pause()
  }
  const evaluate = source => window.webContents.executeJavaScript(source)
  const call = (name, ...args) => evaluate(`window.lingo.dictionary.${name}(...${JSON.stringify(args)})`)
  const waitFor = async source => {
    const end = Date.now() + 10000
    while (!await evaluate(source)) { assert.ok(Date.now() < end, 'Renderer condition deadline: ' + source); await pause() }
  }
  await waitFor('Boolean(window.lingo?.dictionary && document.querySelector(".app-shell"))')
  const sqlite = require('node:sqlite')
  const sqliteProbe = new sqlite.DatabaseSync(':memory:')
  check(sqliteProbe.prepare('SELECT 8 AS languages').get().languages === 8, 'Actual Electron native SQLite is available without an added native dependency')
  sqliteProbe.close()
  check((await call('availability')).configured === false, 'Empty isolated profile has no AI provider configuration')
  const snapshot = await evaluate('window.lingo.getSnapshot()')
  check(!snapshot.settings.hasAsrKey && !snapshot.settings.hasTranslationKey && !snapshot.settings.launchAtLogin, 'No real credentials, ASR or autostart are enabled')
  if (phase === 'fresh') {
    check((await call('packs.list')).length === 0, 'A fresh application starts without installed packages')
    const saved = []
    for (const pack of plan.packs) {
      const installed = await call('packs.install')
      check(installed.installed && installed.pack.manifest.packId === pack.packId, `Actual trusted IPC installs the ${pack.language} sample package`)
      const text = `Public sample: ${pack.word}.`
      const opened = await call('openInput', { text, language: pack.language })
      check(opened.handle && opened.source.provenance === 'user-input', `${pack.language} explicitly entered source gets a user-input snapshot handle`)
      const start = text.indexOf(pack.word), input = { handle: opened.handle, span: { start, end: start + pack.word.length, exact: pack.word }, language: pack.language, glossLanguage: 'zh' }
      const result = await call('offlineLookup', input)
      const hit = result.results.find(hit => hit.pack.packId === pack.packId && hit.entry.headword === pack.word)
      check(hit && hit.entry.senses.length && hit.matchPath === 'exact', `${pack.language} exact source selection returns a genuine local entry and sense`)
      check(hit.pack.glossLanguage === 'en' && result.message.includes('中文'), `${pack.language} absent Chinese glosses are disclosed rather than fabricated`)
      const encounter = await call('saveOffline', { ...input, packId: hit.pack.packId, packVersion: hit.pack.version, packSha256: hit.pack.dbSha256, entryId: hit.entry.id, senseId: hit.entry.senses[0].id })
      check(encounter.favorite && encounter.explanations[0].providerKind === 'offline-dictionary' && encounter.source.text === text, `${pack.language} selected sense is saved with immutable original context and dictionary provenance`)
      saved.push(encounter)
      await call('release', opened.handle)
    }
    check((await call('packs.list')).length === 8, 'All eight real sample packages are installed, not just language menu options')
    const boundaryPack = await call('packs.install')
    check(boundaryPack.installed && boundaryPack.pack.manifest.schemaVersion === 2, 'Actual trusted IPC installs the explicitly synthetic manifest2 sense-boundary package')
    const boundaryText = 'synthetic boundary word'
    const boundaryHandle = await call('openInput', { text: boundaryText, language: 'en' })
    const boundaryInput = { handle: boundaryHandle.handle, span: { start: 0, end: boundaryText.length, exact: boundaryText }, language: 'en', glossLanguage: 'en' }
    const boundaryLookup = await call('offlineLookup', boundaryInput)
    const boundaryHit = boundaryLookup.results.find(hit => hit.pack.packId === boundaryPack.pack.manifest.packId)
    check(boundaryHit && boundaryHit.entry.senses.length === 225, 'Actual Electron SQLite/preload/main path returns all 225 synthetic senses without truncating at 100')
    const sourceReadings = ['[synthetic]', '来源韩文记音（hangeul；标签：["phonetic"]；原标签：["synthetic-region"]）：synthetic-hangeul', '来源中文记音（zh_pron；标签：["synthetic-variety"]；原标签：["synthetic-region"]）：synthetic-notation']
    check(JSON.stringify(boundaryHit.entry.readings) === JSON.stringify(sourceReadings), 'Actual import/SQLite/preload lookup preserves both synthetic notation fields and their original source labels')
    const lastBoundarySense = boundaryHit.entry.senses.at(-1)
    const boundaryEncounter = await call('saveOffline', { ...boundaryInput, packId: boundaryHit.pack.packId, packVersion: boundaryHit.pack.version, packSha256: boundaryHit.pack.dbSha256, entryId: boundaryHit.entry.id, senseId: lastBoundarySense.id })
    const boundaryDetail = await call('get', boundaryEncounter.id)
    check(boundaryDetail.encounter.explanations[0].pack.schemaVersion === 2 && boundaryDetail.encounter.explanations[0].sense.id === lastBoundarySense.id && boundaryDetail.encounter.explanations[0].sense.glosses[0] === 'Self-authored synthetic boundary sense 225', 'Actual history IPC retains manifest2 and the selected 225th synthetic sense')
    check(JSON.stringify(boundaryDetail.encounter.explanations[0].entry.readings) === JSON.stringify(sourceReadings), 'Actual history IPC retains source notations without interpreting them as standard pronunciation')
    await call('export', 'json')
    const boundaryExport = JSON.parse(readFileSync(join(directory, 'export-fresh-1.json'), 'utf8')).entries.find(entry => entry.encounterId === boundaryEncounter.id)
    check(boundaryExport && boundaryExport.explanation.pack.schemaVersion === 2 && boundaryExport.explanation.sense.id === lastBoundarySense.id, 'Actual export IPC preserves manifest2 and the last selected synthetic sense')
    check(JSON.stringify(boundaryExport.explanation.entry.readings) === JSON.stringify(sourceReadings), 'Actual export IPC retains original notation and region-label strings')
    largeBoundary = { synthetic: true, independentCoverageEvidence: false, readableSenses: 225, selectedSenseId: lastBoundarySense.id, savedManifestSchema: boundaryExport.explanation.pack.schemaVersion, exported: true }
    await call('remove', boundaryEncounter.id)
    await call('packs.uninstall', boundaryPack.pack.manifest.packId)
    await call('release', boundaryHandle.handle)
    saveCounter = 0
    check((await call('packs.list')).length === 8 && (await call('list', { pageSize: 50 })).total === 8, 'Removing the synthetic boundary encounter/package restores the original eight-language learning matrix')
    const english = plan.packs[0]
    await call('packs.setEnabled', english.packId, false)
    let handle = await call('openInput', { text: english.word, language: 'en' })
    const englishInput = { handle: handle.handle, span: { start: 0, end: english.word.length, exact: english.word }, language: 'en' }
    check((await call('offlineLookup', englishInput)).results.length === 0, 'Disabling an installed package removes it from actual lookup')
    await call('packs.setEnabled', english.packId, true)
    check((await call('offlineLookup', englishInput)).results.length > 0, 'Re-enabling restores the same local lookup')
    await call('packs.install')
    const updated = await call('offlineLookup', englishInput)
    check(updated.results[0].pack.version === 'lifecycle-v2' && updated.results[0].entry.senses.some(sense => sense.glosses.some(gloss => gloss.includes('synthetic lifecycle update'))), 'Whole-package replacement activates a new version and revised local definition')
    assert.deepEqual((await call('get', saved[0].id)).encounter.explanations, saved[0].explanations)
    checks.push('Package update does not rewrite a previously saved sense/license/source snapshot')
    await call('packs.uninstall', english.packId)
    check((await call('offlineLookup', englishInput)).results.length === 0, 'Uninstall closes/removes the package and it no longer answers queries')
    assert.deepEqual((await call('get', saved[0].id)).encounter.explanations, saved[0].explanations)
    checks.push('A saved entry remains readable after its source package is uninstalled')
    check(!(await call('packs.install')).installed && (await call('packs.list')).length === 7, 'Cancelling the native package chooser leaves installed data unchanged')
    await call('packs.setEnabled', plan.packs.find(pack => pack.language === 'ko').packId, false)
    await call('release', handle.handle)
    const page = await call('list', { page: 1, pageSize: 50 })
    check(page.total === 8, 'Eight independent dictionary encounters are present in the existing learning history')
    check((await call('list', { query: 'cat' })).total > 0, 'Existing history search finds the offline context/entry')
    await evaluate('document.querySelector("button[aria-label=学习历史]").click()')
    await waitFor('Boolean(document.querySelector(".dictionary-query"))')
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "复习收藏").click()')
    await waitFor('Boolean(document.querySelector(".dictionary-review-prompt"))')
    check(await evaluate('document.querySelectorAll(".dictionary-explanation").length === 0'), 'Actual production review DOM has no answer before explicit reveal')
    const prompt = await evaluate('document.querySelector(".dictionary-review-prompt").textContent')
    const current = saved.find(encounter => prompt.includes(encounter.source.text))
    check(Boolean(current), 'Review prompt carries a real saved source context')
    window.webContents.debugger.attach('1.3')
    const ax = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
    window.webContents.debugger.detach()
    const exposed = ax.nodes.filter(node => !node.ignored).flatMap(node => [node.name?.value, node.value?.value, node.description?.value]).filter(value => typeof value === 'string').join('\n')
    check(current.explanations[0].sense.glosses.every(gloss => !exposed.includes(gloss)), 'Actual Electron accessibility tree does not reveal the offline answer early')
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "揭示已保存解释").click()')
    await waitFor('Boolean(document.querySelector(".dictionary-offline-explanation"))')
    const answer = await evaluate('document.querySelector(".dictionary-offline-explanation").textContent')
    check(answer.includes(current.explanations[0].sense.glosses[0]) && !answer.includes('AI生成'), 'Explicit reveal shows the saved offline definition with separate dictionary attribution')
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "记起了").click()')
    await waitFor('document.querySelector(".dictionary-review").textContent.includes("本次自评 1 条")')
    check(JSON.parse(readFileSync(join(directory, 'profile/dictionary-learning-v1.json'), 'utf8')).reviews.length === 1, 'Explicit production self-rating persists exactly one review event')
    await call('export', 'json'); await call('export', 'markdown')
    const json = JSON.parse(readFileSync(join(directory, 'export-fresh-1.json'), 'utf8'))
    check(json.entries.length === 8 && json.entries.every(entry => entry.explanation.providerKind === 'offline-dictionary'), 'Actual export IPC includes committed independent offline source snapshots')
    check(readFileSync(join(directory, 'export-fresh-2.md'), 'utf8').includes(saved[0].explanations[0].pack.license), 'Markdown export keeps dictionary license attribution without a model call')
    writeFileSync(join(directory, 'expected.json'), JSON.stringify({ saved, count: page.total }))
    const output = join(plan.root, 'artifacts/offline-dictionaries'); mkdirSync(output, { recursive: true })
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "返回学习历史").click()')
    await pause()
    const image = await window.webContents.capturePage()
    writeFileSync(join(output, 'actual-electron-public-sample-history.png'), image.toPNG())
  } else {
    const expected = JSON.parse(readFileSync(join(directory, 'expected.json'), 'utf8'))
    const packs = await call('packs.list')
    check(packs.length === 7 && packs.find(pack => pack.manifest.sourceLanguage === 'ko').enabled === false, 'Actual application restart preserves package replacement/removal and disabled state')
    const page = await call('list', { page: 1, pageSize: 50 })
    check(page.total === expected.count, 'Actual application restart restores all saved offline encounters')
    for (const encounter of expected.saved) assert.deepEqual((await call('get', encounter.id)).encounter.explanations, encounter.explanations)
    checks.push('All saved definitions, sense IDs and license versions survive restart unchanged')
    const document = JSON.parse(readFileSync(join(directory, 'profile/dictionary-learning-v1.json'), 'utf8'))
    check(document.reviews.length === 1, 'Review self-report survives restart without an automatic new event')
    const review = await call('startReview')
    check(review.cards.length === 8, 'Uninstalled or disabled packages do not prevent reviewing saved snapshot cards')
    const card = review.cards[0], revealed = await call('reveal', review.sessionId, card.encounterId, card.explanationId)
    check(revealed.explanation.providerKind === 'offline-dictionary', 'Restarted offline review reveals only the committed dictionary snapshot')
    await call('endReview', review.sessionId)
  }
  check(permissions.policies === 1 && permissions.requests === 0, 'Production permission policy installs, but offline use requests no media or new permission')
  check(network.main === 0 && network.renderer === 0, 'Actual main and renderer paths attempted zero external requests while offline')
  console.log('LINGOBAR_OFFLINE_RESULT:' + JSON.stringify({ phase, electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite, chromium: process.versions.chrome, platform: process.platform, arch: process.arch, checks, network, permissions, syntheticLargeBoundary: largeBoundary, hardwareAcceptance: false }))
  app.quit()
}
run().catch(fail)
