import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'

const require = createRequire(import.meta.url)
const { textRequest } = require('../scripts/plan-one-rmb-test.cjs')
const { inspectProof, validateProof, bundledProof } = require('../scripts/text-test-proof.cjs')
const now = Date.parse('2026-10-28T19:00:00Z')
const reviewed = () => ({ ...structuredClone(bundledProof), executionAllowed: true })
afterEach(() => vi.unstubAllGlobals())

describe('fixed complete-prompt upper-bound evidence, not exact BPE counts or billing', () => {
  it.each([['translation', 225, 1474], ['ruby', 325, 1674]])('retains source-derived %s diagnostics but ships execution disabled', (step, bound, cost) => {
    const network = vi.fn(() => { throw new Error('Real network forbidden') }); vi.stubGlobal('fetch', network)
    const result = inspectProof(step, textRequest(step), now)
    expect(result).toMatchObject({ admitted: false, blockers: ['reviewed_release_not_enabled'], inputTokenUpperBound: bound, conditionalMaximumMicroCny: cost })
    expect(network).not.toHaveBeenCalled()
    expect(bundledProof.executionAllowed).toBe(false); expect(Object.isFrozen(bundledProof.steps)).toBe(true)
  })
  it.each(['translation', 'ruby'])('can validate complete fixed %s evidence in an offline hypothetical release', step => {
    const result = validateProof(reviewed(), step, textRequest(step), now)
    expect(result.admitted).toBe(true); expect(result.blockers).toEqual([])
    expect(result.requestSha256).toBe(textRequest(step).requestSha256)
    expect(bundledProof.steps[step].exactInputTokenCount).toBeNull()
  })
  it('records the actual1017 tokenizer comparison precisely, without whole-file identity or alias-only claims', () => {
    expect(bundledProof.tokenizer.recipeSha256).toBe('81f64d1248a68ce3663e07ab3ee48b851e5df0e32d27cb98e4c9a268151e8d99')
    expect(bundledProof.tokenizer.modelSha256).toBe('c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b')
    expect(bundledProof.tokenizer.modelRevision).toBe('1bae0e1088993b9b82de08f59de5be5a34e42170')
    expect(bundledProof.tokenizer.rawFilesByteIdentical).toBe(false)
    expect(bundledProof.tokenizer.plainConfigurationEqual).toBe(true)
    expect(bundledProof.tokenizer.modelVocabularyAndMergesEqual).toBe(true)
    expect(bundledProof.tokenizer.onlyDifferences).toHaveLength(2)
    expect(bundledProof.tokenizer.controlTokenIds).toEqual({ '<｜begin▁of▁sentence｜>': 0, '<｜System｜>': 128799, '<｜User｜>': 128803, '<｜Assistant｜>': 128804, '</think>': 128822 })
    expect(bundledProof.encoding).toMatchObject({ exactTokenCount: null, responseFormatSuffixUtf8Bytes: 105, controlTokenCount: 5, postprocessorAddedTokens: 0, plainAddedVocabulary: false })
  })
  it.each([
    ['schema', (p: any) => { p.schemaVersion = 2 }],
    ['extra top key', (p: any) => { p.override = true }],
    ['extra nested key', (p: any) => { p.recipe.override = true }],
    ['recipe commit', (p: any) => { p.recipe.commit = '0'.repeat(40) }],
    ['dependency lock', (p: any) => { p.recipe.cargoLockSha256 = '0'.repeat(64) }],
    ['template', (p: any) => { p.recipe.templateSha256 = '0'.repeat(64) }],
    ['tokenizer', (p: any) => { p.tokenizer.modelSha256 = p.tokenizer.recipeSha256 }],
    ['tokenizer revision', (p: any) => { p.tokenizer.modelRevision = 'main' }],
    ['control mapping', (p: any) => { p.tokenizer.controlTokenIds['</think>']++ }],
    ['normalization proof', (p: any) => { p.encoding.normalizer = 'unknown' }],
    ['JSON suffix', (p: any) => { p.encoding.responseFormatSuffixUtf8Bytes = 0 }],
    ['estimated exact count', (p: any) => { p.steps.translation.exactInputTokenCount = 225 }],
    ['caller token allowance', (p: any) => { p.steps.translation.inputTokenUpperBound = 4096 }],
    ['model alias', (p: any) => { p.model.apiAlias = 'different' }],
    ['model version', (p: any) => { p.model.version = 'DeepSeek-V4-Flash' }],
    ['endpoint', (p: any) => { p.model.endpoint = 'https://proxy.example/chat/completions' }],
    ['currency', (p: any) => { p.price.currency = 'USD' }],
    ['price', (p: any) => { p.price.outputPeakMicroCnyPerToken = 4 }],
    ['validity extension', (p: any) => { p.price.expiresAt = '2027-01-01T00:00:00Z' }],
    ['request hash', (p: any) => { p.steps.translation.requestSha256 = '0'.repeat(64) }],
    ['reservation', (p: any) => { p.steps.translation.reservationMicroCny = 0 }],
    ['unverified account', (p: any) => { p.account.verified = false }]
  ])('rejects changed %s proof rather than trusting a true enable flag', (_, mutate) => {
    const proof = reviewed(); mutate(proof)
    expect(validateProof(proof, 'translation', textRequest('translation'), now)).toMatchObject({ admitted: false, blockers: ['proof_invalid_or_changed'] })
  })
  it.each([
    ['one system byte', (r: any) => { r.body.messages[0].content += '.' }],
    ['one user byte', (r: any) => { r.body.messages[1].content += ' ' }],
    ['JSON format', (r: any) => { r.body.response_format = { type: 'text' } }],
    ['model', (r: any) => { r.body.model = 'deepseek-v4-pro' }],
    ['output', (r: any) => { r.body.max_tokens = 129 }],
    ['thinking', (r: any) => { r.body.thinking.type = 'enabled' }],
    ['tool', (r: any) => { r.body.tools = [] }],
    ['history', (r: any) => { r.body.messages.push({ role: 'user', content: 'extra' }) }],
    ['unknown header', (r: any) => { r.headers = { Authorization: 'forbidden' } }],
    ['custom endpoint', (r: any) => { r.endpoint += '?query=1' }],
    ['retry', (r: any) => { r.attempts = 2 }]
  ])('rejects %s even when the caller updates byte/hash metadata', (_, mutate) => {
    const request = textRequest('translation'); mutate(request)
    expect(validateProof(reviewed(), 'translation', request, now).admitted).toBe(false)
  })
  it.each([Date.parse('2026-10-28T18:11:59Z'), Date.parse('2026-10-29T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z'), NaN])('rejects stale/future/invalid proof time %s', instant => {
    expect(validateProof(reviewed(), 'translation', textRequest('translation'), instant)).toMatchObject({ admitted: false, blockers: ['proof_not_current'] })
  })
  it.each([null, [], {}, 'not JSON', { executionAllowed: true }, { ...reviewed(), extra: 'x'.repeat(40_000) }])('fails closed on malformed or oversized evidence %#', proof => {
    expect(validateProof(proof, 'translation', textRequest('translation'), now).admitted).toBe(false)
  })
  it.each(['asr', 'retry', 'translation2', '', '__proto__'])('refuses unapproved step %s independently of other evidence', step => {
    expect(inspectProof(step, {}, now)).toMatchObject({ admitted: false, blockers: ['unsupported_step'], inputTokenUpperBound: null })
  })
  it('contains no production proof override, environment key read or network operation', () => {
    const source = readFileSync(new URL('../scripts/text-test-proof.cjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/process\.env|fetch\(|https\.request|http\.request|eval\(|Function\(/)
    expect(source).toContain("path.resolve(__dirname, '../evidence/text-test-proof.json')")
  })
})
