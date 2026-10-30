// Independent Kaikki/Wiktextract JSONL -> local SQLite language-pack builder.
// Reads local files only. No downloads, model calls, or upstream executable code.
const { createReadStream } = require('node:fs')
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { createInterface } = require('node:readline')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const METADATA = ['packId', 'version', 'sourceLanguage', 'glossLanguage', 'sourceName', 'sourceUrl', 'sourceRevision', 'license', 'licenseUrl', 'attribution']
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, limit = 16000) => typeof value === 'string' && value.length > 0 && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
const texts = (values, limit = 16000) => Array.isArray(values) ? values.filter(value => text(value, limit)) : []
const unique = values => [...new Set(values)]
const nfc = value => value.normalize('NFC')
async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function metadata(value) {
  if (!plain(value) || Object.keys(value).length !== METADATA.length || !METADATA.every(key => Object.hasOwn(value, key))) throw new Error('Pack metadata requires the exact documented source and license fields.')
  for (const key of METADATA) if (!text(value[key], key === 'attribution' ? 16000 : 2000)) throw new Error(`Invalid metadata field: ${key}`)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.packId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.version)) throw new Error('Invalid pack identity/version.')
  for (const key of ['sourceLanguage', 'glossLanguage']) if (value[key].length > 40 || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value[key])) throw new Error('Pack language must be an explicit language code.')
  for (const key of ['sourceUrl', 'licenseUrl']) {
    let url
    try { url = new URL(value[key]) } catch { throw new Error('Invalid source/license URL.') }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Source/license URL must be public HTTPS metadata.')
  }
  return Object.fromEntries(METADATA.map(key => [key, value[key]]))
}
function formsFor(record) {
  if (!Array.isArray(record.forms)) return []
  return record.forms.filter(plain).filter(item => text(item.form, 1024))
    .map(item => ({ form: item.form, tags: unique(texts(item.tags, 256)) }))
}
function indexableForm(item) {
  // Preserve source metadata above, but classifiers/auxiliaries and unfilled
  // tables/templates are not alternative headwords or inflections of this entry.
  const nonLexical = new Set(['counter', 'table-tags', 'class', 'inflection-template', 'auxiliary'])
  return item.form.trim() !== '-' && !/\+\s*past participle\b/iu.test(item.form) && !item.tags.some(tag => nonLexical.has(tag))
}
function readingsFor(record) {
  const result = []
  if (Array.isArray(record.sounds)) for (const sound of record.sounds.filter(plain)) {
    // Preserve written pronunciations supplied by the source; an audio URL is not an offline reading.
    for (const key of ['ipa', 'enpr', 'roman', 'other']) if (text(sound[key], 1024)) result.push(sound[key])
  }
  return unique(result)
}
function sensesFor(record, entryId) {
  if (!Array.isArray(record.senses)) return []
  return record.senses.filter(plain).flatMap((sense, index) => {
    const glosses = unique(texts(sense.glosses).length ? texts(sense.glosses) : texts(sense.raw_glosses))
    if (!glosses.length) return []
    const examples = Array.isArray(sense.examples) ? sense.examples.filter(plain).filter(example => text(example.text)).map(example => ({ text: example.text, translation: text(example.translation) ? example.translation : text(example.english) ? example.english : null })) : []
    return [{ id: `${entryId}:s${index + 1}`, glosses, tags: unique(texts(sense.tags, 256)), examples }]
  })
}
/** Match the first-batch runtime payload bounds; never build a pack that silently loses later senses. */
function runtimeBounds(record, forms, readings, senses, lineNumber) {
  const reject = field => { throw new Error(`Source line ${lineNumber} exceeds the local runtime limit for ${field}; no truncated pack was produced.`) }
  const length = (value, maximum, field) => { if (typeof value === 'string' && value.length > maximum) reject(field) }
  const column = (value, maximum, field) => { if (value.length > maximum || JSON.stringify(value).length > 1024 * 1024) reject(field) }
  length(record.pos, 256, 'part of speech')
  for (const form of Array.isArray(record.forms) ? record.forms.filter(plain) : []) {
    length(form.form, 1024, 'form text')
    for (const tag of Array.isArray(form.tags) ? form.tags : []) length(tag, 256, 'form tag')
  }
  for (const sound of Array.isArray(record.sounds) ? record.sounds.filter(plain) : []) {
    for (const key of ['ipa', 'enpr', 'roman', 'other']) length(sound[key], 1024, 'reading')
  }
  for (const sense of Array.isArray(record.senses) ? record.senses.filter(plain) : []) {
    for (const key of ['glosses', 'raw_glosses']) for (const gloss of Array.isArray(sense[key]) ? sense[key] : []) length(gloss, 16000, 'gloss text')
    for (const tag of Array.isArray(sense.tags) ? sense.tags : []) length(tag, 256, 'sense tag')
    for (const example of Array.isArray(sense.examples) ? sense.examples.filter(plain) : []) {
      for (const key of ['text', 'translation', 'english']) length(example[key], 16000, 'example text')
    }
  }
  column(forms, 500, 'forms'); column(readings, 100, 'readings')
  if (senses.length > 100) reject('senses')
  for (const form of forms) column(form.tags, 100, 'form tags')
  for (const sense of senses) {
    column(sense.glosses, 100, 'glosses'); column(sense.tags, 100, 'sense tags'); column(sense.examples, 20, 'examples')
  }
}
async function buildDictionaryPack({ input, output, manifest: supplied }) {
  const descriptor = metadata(supplied)
  if (typeof input !== 'string' || typeof output !== 'string') throw new Error('Input/output local paths are required.')
  const source = resolve(input), destination = resolve(output)
  if (!existsSync(source)) throw new Error('JSONL input does not exist.')
  if (existsSync(destination)) throw new Error('Output already exists; choose a new version directory.')
  mkdirSync(dirname(destination), { recursive: true })
  mkdirSync(destination, { mode: 0o700 })
  let db
  try {
    const databasePath = join(destination, 'entries.sqlite')
    db = new DatabaseSync(databasePath)
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA user_version=1;
      CREATE TABLE entries(id TEXT PRIMARY KEY,headword TEXT NOT NULL,headword_nfc TEXT NOT NULL,language TEXT NOT NULL,readings_json TEXT NOT NULL,pos TEXT,forms_json TEXT NOT NULL);
      CREATE TABLE senses(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES entries(id),glosses_json TEXT NOT NULL,tags_json TEXT NOT NULL,examples_json TEXT NOT NULL);
      CREATE TABLE forms(form TEXT NOT NULL,form_nfc TEXT NOT NULL,entry_id TEXT NOT NULL REFERENCES entries(id),tags_json TEXT NOT NULL);
      CREATE TABLE pending_forms(form TEXT NOT NULL,base TEXT NOT NULL,tags_json TEXT NOT NULL);
      CREATE INDEX entries_headword ON entries(language,headword); CREATE INDEX entries_nfc ON entries(language,headword_nfc);
      CREATE INDEX forms_exact ON forms(form); CREATE INDEX forms_nfc ON forms(form_nfc); CREATE INDEX senses_entry ON senses(entry_id);`)
    const insertEntry = db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?)')
    const insertSense = db.prepare('INSERT INTO senses VALUES(?,?,?,?,?)')
    const insertForm = db.prepare('INSERT INTO forms VALUES(?,?,?,?)')
    const pendingForm = db.prepare('INSERT INTO pending_forms VALUES(?,?,?)')
    db.exec('BEGIN')
    let lineNumber = 0
    const lines = createInterface({ input: createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      lineNumber++
      if (!line.trim()) continue
      if (Buffer.byteLength(line, 'utf8') > 4 * 1024 * 1024) throw new Error(`JSONL line ${lineNumber} exceeds the documented 4MiB record limit.`)
      let record
      try { record = JSON.parse(line) } catch { throw new Error(`Invalid JSON at source line ${lineNumber}.`) }
      if (!plain(record)) throw new Error(`Expected an object at source line ${lineNumber}.`)
      if (record.lang_code !== descriptor.sourceLanguage) continue
      if (!text(record.word, 1024)) throw new Error(`Invalid headword at source line ${lineNumber}.`)
      const entryId = `line:${lineNumber}`, forms = formsFor(record), readings = readingsFor(record), senses = sensesFor(record, entryId)
      runtimeBounds(record, forms, readings, senses, lineNumber)
      // Inflection records can contain only form_of; index their explicitly named lemma after all base records exist.
      if (Array.isArray(record.senses)) for (const sense of record.senses.filter(plain)) {
        if (Array.isArray(sense.form_of)) for (const target of sense.form_of.filter(plain)) if (text(target.word, 1024)) pendingForm.run(record.word, target.word, JSON.stringify(unique(texts(sense.tags, 256))))
      }
      if (!senses.length) continue
      insertEntry.run(entryId, record.word, nfc(record.word), record.lang_code, JSON.stringify(readings), text(record.pos, 256) ? record.pos : null, JSON.stringify(forms))
      for (const sense of senses) insertSense.run(sense.id, entryId, JSON.stringify(sense.glosses), JSON.stringify(sense.tags), JSON.stringify(sense.examples))
      for (const form of forms.filter(indexableForm)) insertForm.run(form.form, nfc(form.form), entryId, JSON.stringify(form.tags))
    }
    const pending = db.prepare('SELECT form,base,tags_json FROM pending_forms')
    const bases = db.prepare('SELECT id FROM entries WHERE language=? AND headword=?')
    for (const form of pending.iterate()) for (const base of bases.all(descriptor.sourceLanguage, form.base)) insertForm.run(form.form, nfc(form.form), base.id, form.tags_json)
    db.exec('DROP TABLE pending_forms; COMMIT; VACUUM')
    const counts = Object.fromEntries(['entries', 'senses', 'forms'].map(table => [table, Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)]))
    if (!counts.entries || !counts.senses) throw new Error('No source-language entries with actual glosses were found.')
    db.close(); db = null
    chmodSync(databasePath, 0o600)
    const result = { schemaVersion: 1, ...descriptor, dbSha256: await fileSha256(databasePath), counts }
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return result
  } catch (error) {
    try { db?.close() } catch { /* failed construction owns this fresh output directory */ }
    rmSync(destination, { recursive: true, force: true })
    throw error
  }
}
module.exports = { buildDictionaryPack }
if (require.main === module) {
  const args = process.argv.slice(2), options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!['--input', '--output', '--metadata'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index].slice(2))) { console.error('Usage: node scripts/build-dictionary-pack.cjs --input source.jsonl --output new-pack-dir --metadata source-metadata.json'); process.exit(1) }
    options[args[index].slice(2)] = args[index + 1]
  }
  if (Object.keys(options).length !== 3) { console.error('Input, output and metadata files are required.'); process.exit(1) }
  Promise.resolve().then(() => buildDictionaryPack({ input: options.input, output: options.output, manifest: JSON.parse(readFileSync(options.metadata, 'utf8')) }))
    .then(result => console.log(JSON.stringify({ packId: result.packId, version: result.version, counts: result.counts, dbSha256: result.dbSha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
