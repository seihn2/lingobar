// Independently project local Kaikki JSONL to redistributable lexical text.
// No downloads, source-code execution, model calls or external dependencies.
const { createReadStream, openSync, closeSync, fsyncSync, existsSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { createInterface } = require('node:readline')
const { createHash, randomUUID } = require('node:crypto')

const CHANGES = 'Kept word/language/part-of-speech, recorded form text/tags, redirects, written pronunciation fields, and sense glosses/raw_glosses/tags/form_of/alt_of. Removed all examples and quotations, media/audio fields and URLs, etymology, linkages and unrelated fields. No definitions, readings or translations generated; no Unicode normalization.'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : null
function copyText(input, keys) { return Object.fromEntries(keys.filter(key => typeof input[key] === 'string').map(key => [key, input[key]])) }
function withStrings(output, input, keys) { for (const key of keys) { const value = strings(input[key]); if (value !== null) output[key] = value }; return output }
function references(value) {
  return Array.isArray(value) ? value.filter(object).map(item => copyText(item, ['word', 'extra'])).filter(item => typeof item.word === 'string') : null
}
function projectKaikkiText(record) {
  if (!object(record)) throw new Error('Every source JSONL row must be an object.')
  const result = withStrings(copyText(record, ['word', 'lang', 'lang_code', 'pos']), record, ['redirects'])
  if (Array.isArray(record.forms)) result.forms = record.forms.filter(object).map(form => withStrings(copyText(form, ['form']), form, ['tags'])).filter(form => typeof form.form === 'string')
  if (Array.isArray(record.sounds)) result.sounds = record.sounds.filter(object).map(sound => withStrings(copyText(sound, ['ipa', 'enpr', 'enPR', 'roman', 'hangeul', 'other', 'zh-pron', 'zh_pron']), sound, ['tags']))
  if (Array.isArray(record.senses)) result.senses = record.senses.filter(object).map(sense => {
    const output = withStrings({}, sense, ['glosses', 'raw_glosses', 'tags'])
    for (const key of ['form_of', 'alt_of']) { const value = references(sense[key]); if (value !== null) output[key] = value }
    return output
  })
  return result
}

async function prepareKaikkiText({ input, output, source }) {
  if (!object(source) || typeof source.url !== 'string' || typeof source.edition !== 'string' || typeof source.label !== 'string' || typeof source.revision !== 'string' || typeof source.license !== 'string' || typeof source.licenseUrl !== 'string' || typeof source.attribution !== 'string') throw new Error('Explicit source URL, edition, label, revision, license and attribution are required.')
  input = resolve(input); output = resolve(output)
  const proofPath = output + '.provenance.json'
  if (input === output || existsSync(output) || existsSync(proofPath)) throw new Error('Choose a new text output path; existing source/output/provenance will not be overwritten.')
  const temporary = output + '.' + randomUUID() + '.tmp'
  let file, stream, lines
  const rawHash = createHash('sha256'), projectedHash = createHash('sha256')
  const statistics = { inputBytes: 0, outputBytes: 0, inputRecords: 0, outputRecords: 0, blankLines: 0, removedExamples: 0, recordsWithGlosses: 0, sensesWithGlosses: 0, languageCounts: {}, maxInputRecordUtf8Bytes: 0, maxOutputRecordUtf8Bytes: 0 }
  try {
    file = openSync(temporary, 'wx', 0o600)
    stream = createReadStream(input)
    stream.on('data', chunk => { rawHash.update(chunk); statistics.inputBytes += chunk.length })
    lines = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) { statistics.blankLines++; continue }
      statistics.inputRecords++
      let raw
      try { raw = JSON.parse(line) } catch { throw new Error('Invalid JSON at source record ' + statistics.inputRecords + '.') }
      const projected = projectKaikkiText(raw), encoded = JSON.stringify(projected) + '\n'
      const bytes = Buffer.from(encoded, 'utf8')
      projectedHash.update(bytes); writeFileSync(file, bytes); statistics.outputBytes += bytes.length; statistics.outputRecords++
      statistics.maxInputRecordUtf8Bytes = Math.max(statistics.maxInputRecordUtf8Bytes, Buffer.byteLength(line, 'utf8'))
      statistics.maxOutputRecordUtf8Bytes = Math.max(statistics.maxOutputRecordUtf8Bytes, bytes.length)
      const language = typeof projected.lang_code === 'string' ? projected.lang_code : '(missing)'
      statistics.languageCounts[language] = (statistics.languageCounts[language] || 0) + 1
      const glosses = (projected.senses || []).filter(sense => sense.glosses?.length).length
      statistics.recordsWithGlosses += Number(glosses > 0); statistics.sensesWithGlosses += glosses
      const examples = Array.isArray(raw.examples) ? raw.examples.length : 0
      const etymologyExamples = Array.isArray(raw.etymology_examples) ? raw.etymology_examples.length : 0
      statistics.removedExamples += examples + etymologyExamples + (Array.isArray(raw.senses) ? raw.senses.reduce((count, sense) => count + (Array.isArray(sense?.examples) ? sense.examples.length : 0), 0) : 0)
    }
    fsyncSync(file); closeSync(file); file = undefined
    const proof = { schemaVersion: 1, kind: 'kaikki-lexical-text-projection', source: Object.fromEntries(['url', 'edition', 'label', 'revision', 'license', 'licenseUrl', 'attribution'].map(key => [key, source[key]])), changes: CHANGES,
      rawSha256: rawHash.digest('hex'), projectionSha256: projectedHash.digest('hex'), ...statistics }
    writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, output)
    return { output, provenance: proofPath, ...proof }
  } catch (error) {
    if (file !== undefined) closeSync(file)
    rmSync(temporary, { force: true })
    // The source is immutable and retained even when parsing/publication fails.
    throw error
  } finally { lines?.close(); stream?.destroy() }
}
module.exports = { projectKaikkiText, prepareKaikkiText, CHANGES }
if (require.main === module) {
  const { readFileSync } = require('node:fs')
  const args = process.argv.slice(2), options = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!['--input', '--output', '--source'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index].slice(2))) { console.error('Usage: node scripts/prepare-kaikki-text.cjs --input source.jsonl --output new-text.jsonl --source source-description.json'); process.exit(1) }
    options[args[index].slice(2)] = args[index + 1]
  }
  if (Object.keys(options).length !== 3) { console.error('Input, output and source-description paths are required.'); process.exit(1) }
  Promise.resolve().then(() => prepareKaikkiText({ input: options.input, output: options.output, source: JSON.parse(readFileSync(options.source, 'utf8')) }))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
