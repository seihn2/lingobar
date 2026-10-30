// Real Electron + production main/preload/renderer, public tiny source samples only.
// No network, credentials, user profile, native capture or provider is used.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { buildDictionaryPack } = require('./build-dictionary-pack.cjs')
const root = resolve(__dirname, '..')
const cases = [['en', 'cat'], ['ja', '猫'], ['ko', '고양이'], ['fr', 'chat'], ['de', 'Katze'], ['es', 'gato'], ['ru', 'кошка'], ['zh', '貓']]

async function main() {
  assert.ok(existsSync(join(root, 'out/main/index.js')), 'Run npm run build before the actual Electron offline test.')
  const directory = mkdtempSync(join(tmpdir(), 'lingobar-offline-electron-'))
  let child
  try {
    const packs = []
    for (const [language, word] of cases) {
      const source = join(root, 'test/fixtures/offline-dictionaries', `${language}.jsonl`)
      const metadata = JSON.parse(readFileSync(join(root, 'test/fixtures/offline-dictionaries', `${language}.metadata.json`), 'utf8'))
      const output = join(directory, 'packs', language)
      const manifest = await buildDictionaryPack({ input: source, output, manifest: metadata })
      packs.push({ language, word, manifest: join(output, 'manifest.json'), packId: manifest.packId })
    }
    // A clearly synthetic lifecycle update exercises replacement; it is not a source-data quality claim.
    const input = join(directory, 'synthetic-update.jsonl')
    const records = readFileSync(join(root, 'test/fixtures/offline-dictionaries/en.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    for (const record of records) for (const sense of record.senses || []) if (sense.glosses?.length) sense.glosses = sense.glosses.map(value => value + ' [synthetic lifecycle update]')
    writeFileSync(input, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const metadata = JSON.parse(readFileSync(join(root, 'test/fixtures/offline-dictionaries/en.metadata.json'), 'utf8'))
    const largeInput = join(directory, 'synthetic-many-senses.jsonl')
    writeFileSync(largeInput, JSON.stringify({ word: 'synthetic boundary word', lang_code: 'en', pos: 'noun',
      sounds: [{ ipa: '[synthetic]', hangeul: 'synthetic-hangeul', tags: ['phonetic'], raw_tags: ['synthetic-region'] }, { zh_pron: 'synthetic-notation', tags: ['synthetic-variety'], raw_tags: ['synthetic-region'] }],
      senses: Array.from({ length: 225 }, (_, index) => ({ glosses: [`Self-authored synthetic boundary sense ${index + 1}`] })) }) + '\n')
    const large = join(directory, 'packs', 'synthetic-many-senses')
    const largeManifest = await buildDictionaryPack({ input: largeInput, output: large, manifest: {
      packId: 'synthetic-many-senses-boundary', version: 'boundary-v2', sourceLanguage: 'en', glossLanguage: 'en',
      sourceName: 'Self-authored synthetic sense-boundary fixture', sourceUrl: 'https://example.invalid/synthetic-boundary',
      sourceRevision: 'synthetic-boundary-v2', license: 'CC0-1.0 (self-authored synthetic fixture)', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: 'Self-authored test strings only; no real dictionary coverage or semantic quality claim.'
    } })
    assert.equal(largeManifest.schemaVersion, 2)
    const updated = join(directory, 'packs', 'en-updated')
    await buildDictionaryPack({ input, output: updated, manifest: { ...metadata, version: 'lifecycle-v2', sourceRevision: `${metadata.sourceRevision}; synthetic lifecycle test modification` } })
    writeFileSync(join(directory, 'plan.json'), JSON.stringify({ root, directory, packs, large: join(large, 'manifest.json'), update: join(updated, 'manifest.json') }))
    const results = []
    for (const phase of ['fresh', 'restart']) {
      const env = { ...process.env, LINGOBAR_OFFLINE_FIXTURE_DIR: directory, LINGOBAR_OFFLINE_FIXTURE_PHASE: phase,
        LINGOBAR_TEST_DATA: join(directory, 'profile'), XDG_CACHE_HOME: join(directory, 'cache') }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const args = [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), join(root, 'test/fixtures/offline-main.cjs')]
      const result = await new Promise((resolveResult, reject) => {
        let output = '', diagnostics = ''
        child = spawn(require('electron'), args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const deadline = setTimeout(() => { child.kill(); reject(new Error(`Offline Electron ${phase} timed out: ${diagnostics}\n${output}`)) }, 90000)
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
        child.stdout.on('data', data => { output = (output + data).slice(-131072) })
        child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-16384) })
        child.once('error', error => { clearTimeout(deadline); reject(error) })
        child.once('close', code => {
          clearTimeout(deadline)
          try {
            assert.equal(code, 0, `Offline Electron ${phase} failed: ${diagnostics}\n${output}`)
            const line = output.split('\n').find(line => line.startsWith('LINGOBAR_OFFLINE_RESULT:'))
            assert.ok(line, `Missing offline result: ${diagnostics}`)
            resolveResult(JSON.parse(line.slice('LINGOBAR_OFFLINE_RESULT:'.length)))
          } catch (error) { reject(error) }
        })
      })
      results.push(result)
    }
    const destination = join(root, 'artifacts/offline-dictionaries')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'electron-results.json'), JSON.stringify({ actualProductionPaths: true, sourceData: 'Eight public Kaikki tiny samples; update only is synthetic', hardwareAcceptance: false, results }, null, 2) + '\n')
    console.log(`Actual Electron offline main/preload/renderer: ${results.reduce((count, value) => count + value.checks.length, 0)} checks in two application processes; zero external requests/media/provider calls.`)
  } finally {
    if (child && child.exitCode === null) child.kill()
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
