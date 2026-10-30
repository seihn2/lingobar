// Offline preparation only: no network, environment/credential reads, recording, deployment or API execution.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const BATCH = 'lingobar-test-2026-10-28'
const LIMIT_MICRO_CNY = 1_000_000 // Total lifetime allowance for this batch, not per day.
const PRICE_CHECKED_ON = '2026-10-28'
const STEPS = Object.freeze({
  asr: Object.freeze({ reservationMicroCny: null }), // Selected3.1 is not priced by PCM duration; reservation is refused.
  translation: Object.freeze({ reservationMicroCny: 20_000 }),
  ruby: Object.freeze({ reservationMicroCny: 20_000 }),
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`web-text-${i + 1}`, Object.freeze({ reservationMicroCny: null })]))
})
const failure = () => { throw new Error('Test budget unavailable; no provider call permitted') }
const whole = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max

/** Catalog calculation only. Account currency, endpoint entitlement and metering must still be confirmed. */
function quote(input) {
  if (!input || input.currency !== 'CNY') failure()
  if (input.provider === 'deepseek' && input.endpoint === 'https://api.deepseek.com/chat/completions' &&
      input.model === 'deepseek-flash' && input.thinking === 'disabled' && input.tools === false &&
      whole(input.fullPromptTokens, 4096) && whole(input.maxTokens, 128)) {
    return { maximumMicroCny: input.fullPromptTokens * 2 + input.maxTokens * 8,
      basis: 'CONDITIONAL: independently verified full prompt token bound, peak uncached CNY prices; not a byte/character estimate' }
  }
  // In particular, a short PCM duration is not proof of a Qwen3.1 input/output token bound.
  failure()
}

/** Exact synthetic payloads for a future one-shot executor. Construction does not send or authorize them. */
function textRequest(step) {
  const tasks = {
    translation: ['Return JSON only: translate source_text into Japanese as {"ja":"..."}. Do not add readings.', { source_text: 'Hello.' }],
    ruby: ['Return JSON only: supply hiragana for the given Japanese slot as {"readings":[{"id":"h0","reading":"..."}]}. Do not rewrite the text.', { source_text: 'school', japanese: '学校', slots: [{ id: 'h0', text: '学校' }] }]
  }
  if (!Object.hasOwn(tasks, step)) failure()
  const [system, data] = tasks[step]
  const body = { model: 'deepseek-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }],
    stream: false, max_tokens: 128, thinking: { type: 'disabled' }, tool_choice: 'none', response_format: { type: 'json_object' } }
  const serialized = JSON.stringify(body)
  return { endpoint: 'https://api.deepseek.com/chat/completions', method: 'POST', body, attempts: 1,
    serializedBytes: Buffer.byteLength(serialized), requestSha256: createHash('sha256').update(serialized).digest('hex'),
    fullPromptBoundProved: false, executionAllowed: false }
}

function plan() {
  const { inspectProof } = require('./text-test-proof.cjs')
  const proofs = Object.fromEntries(['translation', 'ruby'].map(step => [step, inspectProof(step, textRequest(step))]))
  return { batchId: BATCH, limitMicroCny: LIMIT_MICRO_CNY, priceCheckedOn: PRICE_CHECKED_ON, executionAllowed: false,
    actualCallsThisPreparation: 0, actualCostThisPreparationMicroCny: 0,
    profile: { evidence: 'Parent-reported non-secret local metadata; no credential values read',
      asr: { host: 'dashscope.aliyuncs.com', model: 'qwen-audio-3.1-asr-flash-streaming', keyReportedPresent: true },
      translation: { host: 'api.deepseek.com', model: 'deepseek-flash', keyReportedPresent: true },
      credentialMigrationAuthorized: true, credentialMigrationPerformedByThisExecutor: false, accountCurrencyVerified: true,
      currentDeployment: 'Parent reports PR14 disabled gateway on VM loopback8788 Node22; not independently inspected here',
      asrGrant: 'Parent reports565.46K tokens until2026-12-21; user declined free-grant hard-stop changes; no ASR admission' },
    steps: [
      { step: 'asr', model: 'qwen-audio-3.1-asr-flash-streaming', attempts: 1, pcmBytes: 160_000, durationSeconds: 5,
        maximumOutputTokens: null, status: 'blocked', conditionalMaximumMicroCny: null, ...STEPS.asr },
      ...['translation', 'ruby'].map(step => {
        const request = textRequest(step)
        const proof = proofs[step], proved = proof.blockers.every(value => ['reviewed_release_not_enabled', 'proof_not_current'].includes(value))
        return { step, model: 'deepseek-flash', attempts: 1, status: 'blocked', requiredFullPromptCeilingTokens: 4096,
          fullPromptTokenUpperBound: proof.inputTokenUpperBound, exactInputTokenCount: null, fullPromptBoundProved: proved,
          maxTokens: request.body.max_tokens, requestSha256: request.requestSha256, serializedBytes: request.serializedBytes,
          conditionalMaximumMicroCny: proved ? proof.conditionalMaximumMicroCny : null, admissionBlockers: proof.blockers, ...STEPS[step] }
      })
    ], conditionalMaximumMicroCny: null, totalReservationMicroCny: null, // An unknown ASR bound must not turn into a known total.
    conditionalTextMaximumMicroCny: proofs.translation.conditionalMaximumMicroCny + proofs.ruby.conditionalMaximumMicroCny, plannedTextReservationMicroCny: 40_000,
    blockers: ['CNY account confirmed by parent; live catalog applicability/fresh price and this batch outside-spend reconciliation still require operator evidence',
      'Fixed plaintext225/325 source-derived upper bounds are not exact BPE counts; reviewed release is not enabled',
      'Default Qwen3.1 token-priced ASR has no established input/output cost ceiling and is refused',
      'Existing shared helpers use max_tokens=8192 and annotation format retry; they are not this one-shot 128-token harness',
      'Credential configuration is authorized but not migrated here; canonical single persistent ledger and credential paths are not connected',
      'Dedicated one-shot executor is included but default denied; WEB_ENABLED cannot enable it and ordinary gateway remains off'],
    sources: ['https://help.aliyun.com/zh/model-studio/model-pricing',
      'https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events',
      'https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events', 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      'https://api-docs.deepseek.com/api/create-chat-completion/', 'https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/'] }
}

const OUTCOME_STATUSES = Object.freeze(['succeeded', 'service_error', 'cancelled', 'timeout', 'response_error', 'usage_anomaly'])
const OUTCOME_ERROR_CATEGORIES = Object.freeze(['http_429', 'http_error', 'redirect', 'timeout', 'cancelled', 'transport', 'response_error', 'usage_anomaly', 'credential_error', 'unknown'])
const EXACT_LEDGER_KEYS = ['version', 'batchId', 'currency', 'limitMicroCny', 'reservedMicroCny', 'attempts']
function exactKeys(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function owned(stat, mode) {
  return (stat.mode & 0o777) === mode && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
}
function privateDirectory(dir) {
  if (!path.isAbsolute(dir) || fs.realpathSync(dir) !== path.resolve(dir)) failure()
  const s = fs.lstatSync(dir)
  if (!s.isDirectory() || s.isSymbolicLink() || !owned(s, 0o700)) failure()
}
function absent(filename) {
  try { fs.lstatSync(filename) } catch (error) { if (error && error.code === 'ENOENT') return; throw error }
  failure()
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function lock(dir) { return fs.openSync(path.join(dir, 'test-budget.lock'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600) }
function releaseLock(dir, held, identity) {
  fs.closeSync(held)
  const name = path.join(dir, 'test-budget.lock'), current = fs.lstatSync(name)
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) failure()
  fs.unlinkSync(name)
}
function readLedger(dir) {
  const name = path.join(dir, 'test-budget.json')
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd), current = fs.lstatSync(name)
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat, 0o600) || stat.size > 16_384 ||
        current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) failure()
    return fs.readFileSync(fd, 'utf8')
  } finally { fs.closeSync(fd) }
}
function validateLedger(v) {
  if (!exactKeys(v, EXACT_LEDGER_KEYS) || v.version !== 1 || v.batchId !== BATCH || v.currency !== 'CNY' || v.limitMicroCny !== LIMIT_MICRO_CNY ||
      !Number.isSafeInteger(v.reservedMicroCny) || v.reservedMicroCny < 0 || v.reservedMicroCny > LIMIT_MICRO_CNY ||
      !Array.isArray(v.attempts) || v.attempts.length > 22) failure()
  const ids = new Set()
  for (const item of v.attempts) {
    if (!exactKeys(item, ['step', 'reservedMicroCny'], ['outcome']) || typeof item.step !== 'string' || !Object.hasOwn(STEPS, item.step) || item.step === 'asr' || ids.has(item.step) ||
        !whole(item.reservedMicroCny, LIMIT_MICRO_CNY) ||
        (item.step.startsWith('web-text-') ? item.reservedMicroCny > 100_000 : item.reservedMicroCny !== STEPS[item.step].reservationMicroCny)) failure()
    ids.add(item.step)
    if (Object.hasOwn(item, 'outcome')) {
      const o = item.outcome
      if (!exactKeys(o, ['status', 'requestSha256', 'at', 'errorCategory', 'anomaly']) || !OUTCOME_STATUSES.includes(o.status) ||
          typeof o.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.requestSha256) || !whole(o.at, Number.MAX_SAFE_INTEGER) ||
          !(o.errorCategory === null || OUTCOME_ERROR_CATEGORIES.includes(o.errorCategory)) || typeof o.anomaly !== 'boolean' ||
          (o.status === 'usage_anomaly' && !o.anomaly)) failure()
    }
  }
  if (v.attempts.reduce((n, item) => n + item.reservedMicroCny, 0) !== v.reservedMicroCny) failure()
}
function blank() { return { version: 1, batchId: BATCH, currency: 'CNY', limitMicroCny: LIMIT_MICRO_CNY, reservedMicroCny: 0, attempts: [] } }
/** Explicit one-time operator initialization only. Never used automatically at startup or by this CLI.
 * An uncertain initial write deliberately leaves its lock/file for operator investigation; no automatic repair. */
function initializeLedger(dir) {
  privateDirectory(dir); absent(path.join(dir, 'test-budget.pending'))
  const held = lock(dir), identity = fs.fstatSync(held)
  let fd, created = false, committed = false
  try {
    fd = fs.openSync(path.join(dir, 'test-budget.json'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
    created = true
    fs.writeFileSync(fd, JSON.stringify(blank()) + '\n'); fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    syncDirectory(dir); committed = true
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (!created || committed) releaseLock(dir, held, identity)
    else fs.closeSync(held)
  }
}

/** The lock spans the complete caller lifetime, including the single fetch. No automatic init, refund or replay. */
class OneRmbTestLedger {
  constructor(dir) {
    privateDirectory(dir); absent(path.join(dir, 'test-budget.pending'))
    this.dir = dir; this.closed = false; this.failed = false; this.held = lock(dir); this.lockIdentity = fs.fstatSync(this.held)
    try {
      this.serialized = readLedger(dir); this.value = JSON.parse(this.serialized); validateLedger(this.value)
      this.failed = this.value.attempts.some(item => item.outcome && item.outcome.anomaly)
    } catch { this.close(); failure() }
  }
  #persist(next) {
    const temporary = path.join(this.dir, 'test-budget.pending')
    let fd
    try {
      privateDirectory(this.dir)
      if (readLedger(this.dir) !== this.serialized) failure()
      const currentLock = fs.lstatSync(path.join(this.dir, 'test-budget.lock'))
      if (currentLock.dev !== this.lockIdentity.dev || currentLock.ino !== this.lockIdentity.ino || !currentLock.isFile() || currentLock.isSymbolicLink() || !owned(currentLock, 0o600)) failure()
      validateLedger(next)
      const serialized = JSON.stringify(next) + '\n'
      if (Buffer.byteLength(serialized) > 16_384) failure()
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(temporary, path.join(this.dir, 'test-budget.json')); syncDirectory(this.dir)
      this.value = next; this.serialized = serialized
    } catch { this.failed = true; failure() }
    finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  get reservedMicroCny() { return this.value.reservedMicroCny }
  reserve(step, requestedAmount) {
    if (this.closed || this.failed || typeof step !== 'string' || !Object.hasOwn(STEPS, step) || this.value.attempts.some(item => item.step === step)) failure()
    const web = step.startsWith('web-text-')
    if (!web && requestedAmount !== undefined) failure()
    const amount = web ? requestedAmount : STEPS[step].reservationMicroCny
    if (!whole(amount, web ? 81_920 : LIMIT_MICRO_CNY) || this.value.reservedMicroCny + amount > LIMIT_MICRO_CNY) failure()
    this.#persist({ ...this.value, reservedMicroCny: this.value.reservedMicroCny + amount,
      attempts: [...this.value.attempts, { step, reservedMicroCny: amount }] })
    return { reservedMicroCny: this.value.reservedMicroCny, limitMicroCny: LIMIT_MICRO_CNY }
  }
  reserveWebText(amount) {
    const step = Array.from({ length: 20 }, (_, i) => `web-text-${i + 1}`)
      .find(id => !this.value.attempts.some(item => item.step === id))
    if (!step) failure()
    return { step, ...this.reserve(step, amount) }
  }
  recordOutcome(step, status, requestSha256, errorCategory = null, anomaly = false) {
    if (this.closed || this.failed) failure()
    const item = this.value.attempts.find(item => item.step === step)
    if (!item || item.outcome) failure()
    const outcome = { status, requestSha256, at: Date.now(), errorCategory, anomaly }
    this.#persist({ ...this.value, attempts: this.value.attempts.map(item => item.step === step ? { ...item, outcome } : item) })
    if (anomaly) this.failed = true
  }
  // Failure, cancellation, midnight, restart and a claimed free grant never refund reservations.
  close(options) {
    if (this.closed) return
    if (options !== undefined && (!exactKeys(options, ['retainLock']) || typeof options.retainLock !== 'boolean')) failure()
    this.closed = true
    // After an uncertain post-fetch outcome write, the caller must preserve this lock.
    // Even failure before pending-file creation must not permit a later step on restart.
    try {
      if (options && options.retainLock) fs.closeSync(this.held)
      else releaseLock(this.dir, this.held, this.lockIdentity)
    } catch { this.failed = true; failure() }
  }
}
module.exports = { plan, quote, textRequest, initializeLedger, OneRmbTestLedger, OUTCOME_STATUSES, OUTCOME_ERROR_CATEGORIES }
if (require.main === module) console.log(JSON.stringify(plan(), null, 2))
