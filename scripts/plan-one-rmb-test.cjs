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
  ruby: Object.freeze({ reservationMicroCny: 20_000 })
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
  const text = quote({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', currency: 'CNY',
    thinking: 'disabled', tools: false, fullPromptTokens: 4096, maxTokens: 128 })
  return { batchId: BATCH, limitMicroCny: LIMIT_MICRO_CNY, priceCheckedOn: PRICE_CHECKED_ON, executionAllowed: false,
    actualCallsThisPreparation: 0, actualCostThisPreparationMicroCny: 0,
    profile: { evidence: 'Parent-reported non-secret local metadata; no credential values read',
      asr: { host: 'dashscope.aliyuncs.com', model: 'qwen-audio-3.1-asr-flash-streaming', keyReportedPresent: true },
      translation: { host: 'api.deepseek.com', model: 'deepseek-flash', keyReportedPresent: true },
      credentialMigrationAuthorized: false, accountCurrencyVerified: false },
    steps: [
      { step: 'asr', model: 'qwen-audio-3.1-asr-flash-streaming', attempts: 1, pcmBytes: 160_000, durationSeconds: 5,
        maximumOutputTokens: null, status: 'blocked', conditionalMaximumMicroCny: null, ...STEPS.asr },
      ...['translation', 'ruby'].map(step => {
        const request = textRequest(step)
        return { step, model: 'deepseek-flash', attempts: 1, status: 'blocked', fullPromptTokenUpperBound: 4096, fullPromptBoundProved: false,
          maxTokens: request.body.max_tokens, requestSha256: request.requestSha256, serializedBytes: request.serializedBytes,
          conditionalMaximumMicroCny: text.maximumMicroCny, ...STEPS[step] }
      })
    ], conditionalMaximumMicroCny: null, totalReservationMicroCny: null, // An unknown ASR bound must not turn into a known total.
    conditionalTextMaximumMicroCny: text.maximumMicroCny * 2, plannedTextReservationMicroCny: 40_000,
    blockers: ['Actual provider/model hosts are confirmed; account currency/region/entitlement and CNY catalog terms remain unverified',
      'Full DeepSeek chat-template/tokenizer input bound not proved; 4096 is a required ceiling, not a measured count',
      'Default Qwen3.1 token-priced ASR has no established input/output cost ceiling and is refused',
      'Existing shared helpers use max_tokens=8192 and annotation format retry; they are not this one-shot 128-token harness',
      'Credential source/migration and canonical server-side budget ledger not authorized/connected',
      'No live executor is included; WEB_ENABLED must remain off for this preparation'],
    sources: ['https://help.aliyun.com/zh/model-studio/model-pricing',
      'https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events',
      'https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events', 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      'https://api-docs.deepseek.com/api/create-chat-completion/', 'https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/'] }
}

function privateDirectory(dir) {
  if (!path.isAbsolute(dir)) failure()
  const s = fs.lstatSync(dir)
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) failure()
}
function lock(dir) { return fs.openSync(path.join(dir, 'test-budget.lock'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600) }
function blank() { return { version: 1, batchId: BATCH, currency: 'CNY', limitMicroCny: LIMIT_MICRO_CNY, reservedMicroCny: 0, attempts: [] } }
/** Explicit one-time operator initialization only. Never used automatically at startup or by this CLI. */
function initializeLedger(dir) {
  privateDirectory(dir)
  const held = lock(dir)
  let fd
  try {
    fd = fs.openSync(path.join(dir, 'test-budget.json'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
    fs.writeFileSync(fd, JSON.stringify(blank()) + '\n'); fs.fsyncSync(fd)
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(held); fs.unlinkSync(path.join(dir, 'test-budget.lock')) }
}

/** Accounting primitive for a future approved one-shot executor, NOT a network guard in the ordinary Web gateway. */
class OneRmbTestLedger {
  constructor(dir) {
    privateDirectory(dir); this.dir = dir; this.closed = false; this.failed = false; this.held = lock(dir)
    try {
      const filename = path.join(dir, 'test-budget.json'), s = fs.lstatSync(filename)
      if (!s.isFile() || s.isSymbolicLink() || s.size > 4096 || (s.mode & 0o077)) failure()
      this.value = JSON.parse(fs.readFileSync(filename, 'utf8'))
      const v = this.value
      if (v.version !== 1 || v.batchId !== BATCH || v.currency !== 'CNY' || v.limitMicroCny !== LIMIT_MICRO_CNY ||
        !Number.isSafeInteger(v.reservedMicroCny) || v.reservedMicroCny < 0 || v.reservedMicroCny > LIMIT_MICRO_CNY ||
        !Array.isArray(v.attempts) || v.attempts.length > 3) failure()
      const ids = new Set()
      for (const item of v.attempts) {
      if (!item || !Object.hasOwn(STEPS, item.step) || ids.has(item.step) || !whole(item.reservedMicroCny, LIMIT_MICRO_CNY) || item.reservedMicroCny !== STEPS[item.step].reservationMicroCny) failure()
        ids.add(item.step)
      }
      if (v.attempts.reduce((n, item) => n + item.reservedMicroCny, 0) !== v.reservedMicroCny) failure()
    } catch { this.close(); failure() }
  }
  reserve(step) {
    if (this.closed || this.failed || !Object.hasOwn(STEPS, step) || this.value.attempts.some(item => item.step === step)) failure()
    const amount = STEPS[step].reservationMicroCny
    if (!whole(amount, LIMIT_MICRO_CNY) || this.value.reservedMicroCny + amount > LIMIT_MICRO_CNY) failure()
    const next = { ...this.value, reservedMicroCny: this.value.reservedMicroCny + amount,
      attempts: [...this.value.attempts, { step, reservedMicroCny: amount }] }
    const temporary = path.join(this.dir, 'test-budget.pending')
    let fd
    try {
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
      fs.writeFileSync(fd, JSON.stringify(next) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(temporary, path.join(this.dir, 'test-budget.json'))
      const directory = fs.openSync(this.dir, fs.constants.O_RDONLY)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
      this.value = next
      return { reservedMicroCny: next.reservedMicroCny, limitMicroCny: LIMIT_MICRO_CNY }
    } catch { this.failed = true; failure() }
    finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  // Failure, cancellation, midnight, restart and a claimed free grant never refund reservations.
  close() { if (this.closed) return; this.closed = true; fs.closeSync(this.held); fs.unlinkSync(path.join(this.dir, 'test-budget.lock')) }
}
module.exports = { plan, quote, textRequest, initializeLedger, OneRmbTestLedger }
if (require.main === module) console.log(JSON.stringify(plan(), null, 2))
