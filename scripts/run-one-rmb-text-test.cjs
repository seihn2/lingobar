// Dedicated one-shot operator CLI, never imported by the ordinary HTTP/WS gateway.
// No SDK retries, arbitrary input, environment credential lookup or automatic initialization.
const fs = require('node:fs')
const path = require('node:path')
const { textRequest, OneRmbTestLedger } = require('./plan-one-rmb-test.cjs')
const defaultInstallation = require('./text-test-installation.json')
const BATCH = 'lingobar-test-2026-10-28', MAX_BYTES = 32 * 1024, DEADLINE_MS = 25_000
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max
const fail = category => { const e = new Error('Restricted text test unavailable'); e.category = category; throw e }
function validateInstallation(v, now = Date.now()) {
  if (!exact(v, ['schemaVersion','batchId','executionEnabled','ledgerDirectory','credentialsFile','account','price','otherBatchSpend']) ||
      v.schemaVersion !== 1 || v.batchId !== BATCH || v.executionEnabled !== true || !integer(now, 0, Number.MAX_SAFE_INTEGER)) fail('installation')
  for (const name of ['ledgerDirectory','credentialsFile']) if (typeof v[name] !== 'string' || v[name].length > 4096 || !path.isAbsolute(v[name]) || v[name].includes('\0')) fail('installation')
  if (!exact(v.account, ['currency','cnyConfirmed','confirmedOn','catalogTermsConfirmed']) || v.account.currency !== 'CNY' || v.account.cnyConfirmed !== true || v.account.catalogTermsConfirmed !== true ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.account.confirmedOn) || !Number.isFinite(Date.parse(v.account.confirmedOn)) || Date.parse(v.account.confirmedOn) > now) fail('account')
  const p = v.price
  if (!exact(p, ['modelVersion','inputMicroCnyPerToken','outputMicroCnyPerToken','checkedOn','validUntil','confirmed']) || p.modelVersion !== 'DeepSeek-V4.1-Flash-1017' ||
      p.inputMicroCnyPerToken !== 2 || p.outputMicroCnyPerToken !== 8 || p.confirmed !== true || !/^\d{4}-\d{2}-\d{2}$/.test(p.checkedOn) ||
      !Number.isFinite(Date.parse(p.checkedOn)) || Date.parse(p.checkedOn) > now || !Number.isFinite(Date.parse(p.validUntil)) ||
      Date.parse(p.validUntil) <= now || Date.parse(p.validUntil) - Date.parse(p.checkedOn) > 86_400_000) fail('price')
  const s = v.otherBatchSpend
  // Nonzero/unknown outside spend requires an explicit reconciled ledger design; never silently treat it as zero.
  if (!exact(s, ['known','reservedMicroCny','evidenceId']) || s.known !== true || s.reservedMicroCny !== 0 ||
      typeof s.evidenceId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(s.evidenceId)) fail('other_spend')
  return v
}
function readOperatorJson(filename, maximum, privateFile = false) {
  const st = fs.lstatSync(filename)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > maximum || (st.mode & (privateFile ? 0o077 : 0o022)) ||
      (privateFile && typeof process.getuid === 'function' && st.uid !== process.getuid())) fail('operator_file')
  if (fs.realpathSync(filename) !== path.resolve(filename)) fail('operator_file')
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (opened.ino !== st.ino || opened.dev !== st.dev || opened.size > maximum) fail('operator_file')
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } finally { fs.closeSync(fd) }
}
function readCredential(filename) {
  const value = readOperatorJson(filename, 8192, true)
  if (!exact(value, ['apiKey']) || typeof value.apiKey !== 'string' || value.apiKey.length < 16 || value.apiKey.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.apiKey)) fail('credential_error')
  return value.apiKey
}
function safeEnvironment() {
  return !['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].some(k => Boolean(process.env[k]))
}
async function boundedJson(response, signal) {
  if (!response.body || !response.headers?.get('content-type')?.toLowerCase().includes('application/json')) fail('response_error')
  const reader = response.body.getReader(), chunks = []; let length = 0
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelReader, { once: true })
  try {
    if (signal.aborted) { cancelReader(); fail('cancelled') }
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      if (!(value instanceof Uint8Array)) fail('response_error')
      length += value.byteLength; if (length > MAX_BYTES) fail('response_error'); chunks.push(value)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { fail('response_error') }
  } finally {
    signal.removeEventListener('abort', cancelReader)
    // Cancellation must not wait indefinitely for an upstream stream's cleanup.
    cancelReader(); reader.releaseLock()
  }
}
function resultUsage(value, bound) {
  const u = value?.usage
  if (!u || typeof u !== 'object' || !integer(u.prompt_tokens, 1, bound) || !integer(u.completion_tokens, 0, 128) ||
      !integer(u.total_tokens, 1, bound + 128) || u.total_tokens !== u.prompt_tokens + u.completion_tokens) fail('usage_anomaly')
  return { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens }
}
function validateResponse(value, step) {
  // A different/absent billed model contradicts the price proof, not just output formatting.
  if (!value || !['deepseek-flash','DeepSeek-V4.1-Flash-1017'].includes(value.model)) fail('usage_anomaly')
  if (!Array.isArray(value.choices) || value.choices.length !== 1) fail('response_error')
  const c = value.choices[0], m = c?.message
  if (c.finish_reason !== 'stop' || !m || m.role !== 'assistant' || m.tool_calls || m.function_call || (m.reasoning_content != null && m.reasoning_content !== '') || typeof m.content !== 'string' || !m.content.trim()) fail('response_error')
  let content; try { content = JSON.parse(m.content) } catch { fail('response_error') }
  if (step === 'translation') {
    if (!exact(content, ['ja']) || typeof content.ja !== 'string' || !content.ja.trim() || content.ja.length > 1024) fail('response_error')
  } else if (!exact(content, ['readings']) || !Array.isArray(content.readings) || content.readings.length !== 1 ||
      !exact(content.readings[0], ['id','reading']) || content.readings[0].id !== 'h0' || typeof content.readings[0].reading !== 'string' ||
      !/^[\u3041-\u3096ー]{1,64}$/.test(content.readings[0].reading)) fail('response_error')
}
/** Dependency injection is an offline test seam. The CLI never takes overrides, URLs, proofs or credentials from arguments. */
async function executeTextStep(step, dependencies) {
  let calls = 0, ledger, reserved = false, hash, timer, onAbort, controller, activeResponse, status = 'blocked', category = 'admission', usage
  const result = () => ({ step: ['translation','ruby'].includes(step) ? step : 'invalid', status, executionAllowed: reserved, providerCalls: calls,
    reservedMicroCny: reserved ? 20_000 : 0, ...(hash ? { requestSha256: hash } : {}), ...(category ? { category } : {}), ...(usage ? { usage } : {}),
    ...(reserved ? { reservationRetained: true, mayHaveStarted: true } : {}) })
  try {
    if (!['translation','ruby'].includes(step)) fail('step')
    const request = textRequest(step); hash = request.requestSha256
    const now = dependencies.now ? dependencies.now() : Date.now()
    const proof = dependencies.inspectProof(step, request, now)
    const expectedBound = step === 'translation' ? 225 : 325
    if (!proof?.admitted || proof.requestSha256 !== hash || proof.inputTokenUpperBound !== expectedBound ||
        proof.conditionalMaximumMicroCny !== expectedBound * 2 + 128 * 8 || proof.conditionalMaximumMicroCny > 20_000) fail('proof')
    const installation = validateInstallation(dependencies.readInstallation(), now)
    if (request.endpoint !== ENDPOINT || request.attempts !== 1 || request.method !== 'POST') fail('request')
    ledger = dependencies.createLedger(installation.ledgerDirectory)
    ledger.reserve(step); reserved = true
    // No secret loading, account preflight or network path occurs before durable reservation.
    if (dependencies.signal?.aborted) fail('cancelled')
    let key; try { key = dependencies.readCredential(installation.credentialsFile) } catch { fail('credential_error') }
    if (typeof key !== 'string' || key.length < 16 || key.length > 2048 || /[\u0000-\u0020\u007f]/.test(key)) fail('credential_error')
    controller = new AbortController()
    onAbort = () => controller.abort(); dependencies.signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(Object.assign(new Error('Deadline'), { category: 'timeout' })) }, dependencies.deadlineMs ?? DEADLINE_MS) })
    const work = (async () => {
      try {
        calls++
        const response = await dependencies.fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(request.body), signal: controller.signal })
        activeResponse = response
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); fail('cancelled') }
        if (response.redirected || response.status >= 300 && response.status < 400) fail('redirect')
        if (!response.ok) fail(response.status === 429 ? 'http_429' : 'http_error')
        const value = await boundedJson(response, controller.signal)
        usage = resultUsage(value, expectedBound)
        validateResponse(value, step)
      } catch (error) {
        if (timedOut) fail('timeout')
        if (dependencies.signal?.aborted) fail('cancelled')
        throw error
      }
    })()
    // Abort is also a local deadline: a fake/slow reader cannot keep the lock forever.
    const cancellation = new Promise((_, reject) => {
      const previous = onAbort
      onAbort = () => { previous(); reject(Object.assign(new Error('Cancelled'), { category: 'cancelled' })) }
      dependencies.signal?.removeEventListener('abort', previous); dependencies.signal?.addEventListener('abort', onAbort, { once: true })
      if (dependencies.signal?.aborted) onAbort()
    })
    await Promise.race([work, deadline, cancellation])
    status = 'succeeded'; category = null
  } catch (error) {
    const allowed = ['step','proof','installation','account','price','other_spend','request','credential_error','http_429','http_error','redirect','timeout','cancelled','response_error','usage_anomaly']
    category = allowed.includes(error?.category) ? error.category : reserved ? 'transport' : 'persistence'
    status = !reserved ? 'blocked' : category === 'timeout' ? 'timeout' : category === 'cancelled' ? 'cancelled' : category === 'usage_anomaly' ? 'usage_anomaly' : category === 'response_error' ? 'response_error' : 'service_error'
  } finally {
    clearTimeout(timer)
    controller?.abort()
    try { void activeResponse?.body?.cancel().catch(() => {}) } catch {}
    if (onAbort) dependencies.signal?.removeEventListener('abort', onAbort)
    if (reserved) {
      const auditCategory = ['http_429','http_error','redirect','timeout','cancelled','transport','response_error','usage_anomaly','credential_error'].includes(category) ? category : null
      try { ledger.recordOutcome(step, status, hash, auditCategory, status === 'usage_anomaly') }
      catch { status = 'persist_error'; category = 'persistence' }
    }
    if (ledger) { try { ledger.close(status === 'persist_error' ? { retainLock: true } : undefined) } catch { status = 'persist_error'; category = 'persistence' } }
  }
  return result()
}
async function main() {
  const step = process.argv[2]
  if (process.argv.length !== 3 || !['translation','ruby'].includes(step)) { console.log(JSON.stringify({ status: 'blocked', executionAllowed: false, providerCalls: 0, category: 'step' })); return 2 }
  const abort = new AbortController(), stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const { inspectProof } = require('./text-test-proof.cjs')
    const output = await executeTextStep(step, {
      inspectProof,
      readInstallation: () => { if (!safeEnvironment()) fail('installation'); return readOperatorJson(path.join(__dirname, 'text-test-installation.json'), 8192) },
      createLedger: dir => new OneRmbTestLedger(dir), readCredential, fetchImpl: globalThis.fetch, signal: abort.signal
    })
    console.log(JSON.stringify(output)); return output.status === 'succeeded' ? 0 : output.status === 'blocked' ? 2 : 1
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
module.exports = { executeTextStep, validateInstallation, defaultInstallation }
if (require.main === module) main().then(code => { process.exitCode = code }).catch(() => { console.log(JSON.stringify({ status: 'blocked', executionAllowed: false, providerCalls: 0, category: 'startup' })); process.exitCode = 2 })
