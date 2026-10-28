// Fixed, offline admission evidence only. No credential reads, network or tokenizer execution.
// Source derivation and licenses are recorded in ../evidence/text-test-proof.json.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { textRequest } = require('./plan-one-rmb-test.cjs')

const PROOF_ANCHOR = '41ba04e6157c69ba02e75f29c2f027a102f23204cede957dd5819dcfe5de918b'
const SUFFIX = '\n\n## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n{"type": "json_object"}'
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  throw new Error('Invalid proof shape')
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function readBundledProof() {
  let fd
  try {
    const filename = path.resolve(__dirname, '../evidence/text-test-proof.json')
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 32_768) return null
    return freeze(JSON.parse(fs.readFileSync(fd, 'utf8')))
  } catch { return null }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
const bundledProof = readBundledProof()

/** Validate a fixed reviewed manifest, not a caller-supplied token count or arbitrary alias.
 * Production only invokes inspectProof with the bundled immutable manifest. The explicit
 * argument exists for offline mutation tests; it is not a CLI/HTTP/environment override.
 */
function validateProof(proof, step, request, now = Date.now()) {
  const blockers = []
  const known = step === 'translation' || step === 'ruby'
  const upper = step === 'translation' ? 225 : step === 'ruby' ? 325 : null
  const result = { admitted: false, blockers, inputTokenUpperBound: upper,
    conditionalMaximumMicroCny: upper === null ? null : upper * 2 + 128 * 8, requestSha256: null }
  if (!known) { blockers.push('unsupported_step'); return result }
  try {
    if (!proof || Object.getPrototypeOf(proof) !== Object.prototype || typeof proof.executionAllowed !== 'boolean' || Buffer.byteLength(JSON.stringify(proof)) > 32_768) throw new Error()
    const { executionAllowed, ...anchored } = proof
    // This digest covers every recursively exact key/value, source/template/configuration
    // hash, byte bound, step, currency, model mapping, price and applicability statement.
    if (hash(canonical(anchored)) !== PROOF_ANCHOR) throw new Error()
    const expected = textRequest(step), serialized = JSON.stringify(request?.body)
    if (canonical(request) !== canonical(expected)) { blockers.push('fixed_request_mismatch'); return result }
    const actualHash = hash(serialized), data = proof.steps[step]
    result.requestSha256 = actualHash
    if (actualHash !== data.requestSha256 || Buffer.byteLength(serialized) !== data.requestUtf8Bytes) throw new Error()
    const system = request.body.messages[0].content + SUFFIX, user = request.body.messages[1].content
    const prompt = '<｜begin▁of▁sentence｜><｜System｜>' + system + '<｜User｜>' + user + '<｜Assistant｜></think>'
    if (Buffer.byteLength(SUFFIX) !== 105 || Buffer.byteLength(system) !== data.renderedSystemUtf8Bytes || Buffer.byteLength(user) !== data.userUtf8Bytes ||
      hash(prompt) !== data.renderedPromptSha256 || Buffer.byteLength(system) + Buffer.byteLength(user) + 5 !== data.inputTokenUpperBound ||
      data.inputTokenUpperBound !== upper || data.conditionalMaximumMicroCny !== result.conditionalMaximumMicroCny ||
      data.conditionalMaximumMicroCny > data.reservationMicroCny || data.outputTokenLimit !== 128 || data.exactInputTokenCount !== null) throw new Error()
    const instant = now instanceof Date ? now.getTime() : now
    if (!Number.isSafeInteger(instant) || instant < Date.parse(proof.checkedAt) || instant >= Date.parse(proof.price.expiresAt)) blockers.push('proof_not_current')
    if (!executionAllowed) blockers.push('reviewed_release_not_enabled')
  } catch { blockers.push('proof_invalid_or_changed') }
  result.admitted = blockers.length === 0
  return result
}
function inspectProof(step, request, now = Date.now()) { return validateProof(bundledProof, step, request, now) }
module.exports = { inspectProof, validateProof, bundledProof }
