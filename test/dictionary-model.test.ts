import { describe, expect, it } from 'vitest'
import { DictionarySchemaError, validateDictionaryModel, validDictionaryInput, type DictionaryModelV1 } from '../src/shared/dictionary-model'

const source = 'Could you pick it up, please?'
const target = 'pick it up'
const example = (): DictionaryModelV1 => ({ schemaVersion: 1, status: 'ok', reasonCode: null, targetText: target, headword: 'pick up', reading: { text: 'pɪk ɪt ʌp', notation: 'ipa' }, partOfSpeech: '短语动词', contextMeaning: '此处表示把它拿起来。', usageNote: '代词放在动词和小品词之间。', examples: [{ text: 'Please pick the pen up.', translation: '请把钢笔拿起来。' }] })
const validate = (value: unknown) => validateDictionaryModel(value, target, source)

describe('strict generated dictionary model contract', () => {
  it('retains all nullable shapes and exact strings without semantic repair', () => {
    const value = example()
    expect(validate(value)).toEqual({ content: value, validationWarnings: [] })
    expect(validate({ ...value, headword: null, reading: null, partOfSpeech: null, usageNote: null, examples: null }).content).toMatchObject({ headword: null, reading: null, partOfSpeech: null, usageNote: null, examples: null })
    expect(validate({ ...value, contextMeaning: '  valid meaning  ' }).content.contextMeaning).toBe('  valid meaning  ')
  })
  it.each(['schemaVersion', 'status', 'reasonCode', 'targetText', 'headword', 'reading', 'partOfSpeech', 'contextMeaning', 'usageNote', 'examples'])('requires key %s even if its value is nullable', key => {
    const value = { ...example() } as Record<string, unknown>; delete value[key]
    expect(() => validate(value)).toThrow(DictionarySchemaError)
  })
  it.each([
    null, [], 'JSON text', 1, true,
    { ...example(), secret: 'do not forward' }, { ...example(), schemaVersion: 1.5 }, { ...example(), schemaVersion: '1' },
    { ...example(), status: 'complete' }, { ...example(), reasonCode: 'declined' }, { ...example(), targetText: 'pick it up ' },
    { ...example(), headword: '' }, { ...example(), headword: 42 }, { ...example(), contextMeaning: null }, { ...example(), contextMeaning: ' \n ' },
    { ...example(), reading: {} }, { ...example(), reading: [] }, { ...example(), reading: { text: '', notation: 'ipa' } },
    { ...example(), reading: { text: 'x', notation: 'audio' } }, { ...example(), reading: { text: 'x', notation: 'ipa', lemma: true } },
    { ...example(), partOfSpeech: '' }, { ...example(), usageNote: false }, { ...example(), examples: [] },
    { ...example(), examples: [{ text: '', translation: null }] }, { ...example(), examples: [{ text: 'one' }] },
    { ...example(), examples: [{ text: 'one', translation: '' }] }, { ...example(), examples: [{ text: 'one', translation: null, url: 'https://invalid.test' }] },
    { ...example(), examples: [{ text: 'one', translation: null }, { text: 'two', translation: null }] },
    { ...example(), contextMeaning: '\ud800' }, { ...example(), usageNote: '\u0000' },
  ])('rejects malformed or unknown content %# without returning the raw value', value => {
    expect(() => validate(value)).toThrow(DictionarySchemaError)
    try { validate(value) } catch (error) { expect(String(error)).not.toContain('do not forward') }
  })
  it.each([
    ['ambiguous', 'ambiguous_context'], ['ambiguous', 'not_lexical_unit'], ['declined', 'unsupported_language'], ['declined', 'declined'],
  ] as const)('accepts %s/%s only with all semantic fields null', (status, reasonCode) => {
    const value = { ...example(), status, reasonCode, headword: null, reading: null, partOfSpeech: null, contextMeaning: null, usageNote: null, examples: null }
    expect(validate(value).content).toEqual(value)
    expect(() => validate({ ...value, contextMeaning: 'cannot expose a guessed answer' })).toThrow(DictionarySchemaError)
    expect(() => validate({ ...value, reasonCode: null })).toThrow(DictionarySchemaError)
  })
  it.each([
    ['headword', 256], ['partOfSpeech', 80], ['contextMeaning', 800], ['usageNote', 800],
  ] as const)('enforces UTF16 code units for %s at %i', (key, limit) => {
    expect(validate({ ...example(), [key]: '字'.repeat(limit) }).content[key]).toHaveLength(limit)
    expect(() => validate({ ...example(), [key]: '字'.repeat(limit + 1) })).toThrow(DictionarySchemaError)
    expect(() => validate({ ...example(), [key]: '🙂'.repeat(Math.floor(limit / 2) + 1) })).toThrow(DictionarySchemaError)
  })
  it.each(['kana', 'ipa', 'romanization', 'other'] as const)('preserves nullable structured reading notation %s without claiming its linguistic correctness', notation => {
    const reading = { text: notation === 'kana' ? 'ひろって' : 'synthetic reading', notation }
    expect(validate({ ...example(), reading }).content.reading).toEqual(reading)
  })
  it('bounds reading and example text/translation and rejects oversized runtime graphs', () => {
    expect(() => validate({ ...example(), reading: { text: 'x'.repeat(257), notation: 'other' } })).toThrow(DictionarySchemaError)
    expect(() => validate({ ...example(), examples: [{ text: 'x'.repeat(301), translation: null }] })).toThrow(DictionarySchemaError)
    expect(() => validate({ ...example(), examples: [{ text: 'x', translation: 'x'.repeat(501) }] })).toThrow(DictionarySchemaError)
    const cyclic = example() as unknown as Record<string, unknown>; cyclic.reading = cyclic
    expect(() => validate(cyclic)).toThrow(DictionarySchemaError)
    const deep: Record<string, unknown> = {}; let cursor = deep
    for (let i = 0; i < 10000; i++) { const child = {}; cursor.child = child; cursor = child }
    expect(() => validate({ ...example(), unknown: deep })).toThrow(DictionarySchemaError)
    expect(() => validate({ ...example(), unknown: 'x'.repeat(33 * 1024) })).toThrow(DictionarySchemaError)
    const getter = Object.defineProperty(example(), 'headword', { enumerable: true, get: () => { throw new Error('getter must not execute') } })
    expect(() => validate(getter)).toThrow(DictionarySchemaError)
  })
  it('nulls only an exact source-duplicating example and adds an application warning', () => {
    const result = validate({ ...example(), examples: [{ text: source, translation: null }] })
    expect(result.content.examples).toBeNull()
    expect(result.validationWarnings).toEqual(['example_duplicates_source'])
    expect(result.content).not.toHaveProperty('validationWarnings')
    expect(validate({ ...example(), examples: [{ text: ` ${source}`, translation: null }] }).validationWarnings).toEqual([])
  })
  it('treats hostile-looking strings as inert text, not HTML/Markdown/URLs to execute', () => {
    const text = '<img src="https://invalid.test/pixel"> [x](https://invalid.test)'
    expect(validate({ ...example(), contextMeaning: text, examples: [{ text, translation: null }] }).content.contextMeaning).toBe(text)
  })
})

describe('source/target input and Unicode consistency', () => {
  it.each([
    ['  pick it up  ', ' pick it up ', true], ['日本語を読みます', '日本語', true], ['word word', 'word', true],
    ['👩🏽‍💻です', '👩🏽‍💻', true], ['👩🏽‍💻です', '👩', false], ['é oui', 'e', false], ['é oui', 'é', true],
    ['  ', ' ', false], ['source', '', false], ['source', 'other', false], ['source', '\ud800', false], ['é', 'é', false],
  ])('matches %j / %j without guessing or normalization', (sentence, selected, valid) => {
    expect(validDictionaryInput(sentence, selected)).toBe(valid)
    const value = { ...example(), targetText: selected, reading: null, examples: null }
    if (valid) expect(validateDictionaryModel(value, selected, sentence).content.targetText).toBe(selected)
    else expect(() => validateDictionaryModel(value, selected, sentence)).toThrow(DictionarySchemaError)
  })
  it('refuses long source/target without truncating either', () => {
    expect(validDictionaryInput('a'.repeat(2001), 'a')).toBe(false)
    expect(validDictionaryInput('a'.repeat(300), 'a'.repeat(257))).toBe(false)
    expect(validDictionaryInput('a'.repeat(2000), 'a'.repeat(256))).toBe(true)
  })
})
