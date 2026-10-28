/** Application contract only: generated content is never an authoritative dictionary source. */
export type DictionaryModelV1 = {
  schemaVersion: 1
  status: 'ok' | 'ambiguous' | 'declined'
  reasonCode: null | 'ambiguous_context' | 'not_lexical_unit' | 'unsupported_language' | 'declined'
  targetText: string
  headword: string | null
  reading: { text: string; notation: 'kana' | 'ipa' | 'romanization' | 'other' } | null
  partOfSpeech: string | null
  contextMeaning: string | null
  usageNote: string | null
  examples: [{ text: string; translation: string | null }] | null
}
export class DictionarySchemaError extends Error {
  constructor() { super('AI 解释格式不符合词典 JSON 契约；未自动重试。'); this.name = 'DictionarySchemaError' }
}
const MODEL_KEYS = ['schemaVersion', 'status', 'reasonCode', 'targetText', 'headword', 'reading', 'partOfSpeech', 'contextMeaning', 'usageNote', 'examples'] as const
function invalid(): never { throw new DictionarySchemaError() }
const object = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!object(value)) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)) && actual.every(key => typeof key === 'string' && keys.includes(key))
}
export function validDictionaryText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && Boolean(value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(value)
}
/** Bound a runtime unknown before JSON.stringify, so a deep/cyclic non-JSON value cannot recurse or leak through. */
function boundedJson(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++nodes > 80 || item.depth > 4) invalid()
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue
    if (typeof item.value === 'number') { if (!Number.isFinite(item.value)) invalid(); continue }
    if (typeof item.value !== 'object' || seen.has(item.value)) invalid()
    seen.add(item.value)
    if (!Array.isArray(item.value) && !object(item.value)) invalid()
    for (const key of Reflect.ownKeys(item.value)) {
      if (Array.isArray(item.value) && key === 'length') continue
      if (typeof key !== 'string') invalid()
      const descriptor = Object.getOwnPropertyDescriptor(item.value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
      pending.push({ value: descriptor.value, depth: item.depth + 1 })
    }
  }
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { invalid() }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 32 * 1024) invalid()
}
function nullableText(value: unknown, maximum: number): value is string | null {
  return value === null || validDictionaryText(value, maximum)
}
/** Defense in depth for direct provider calls; the owning main process also validates the exact selected span. */
export function validDictionaryInput(source: unknown, target: unknown): source is string {
  if (!validDictionaryText(source, 2000) || !validDictionaryText(target, 256)) return false
  const boundaries = new Set<number>([source.length])
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(source)) boundaries.add(part.index)
  let offset = source.indexOf(target)
  while (offset !== -1) {
    if (boundaries.has(offset) && boundaries.has(offset + target.length)) return true
    offset = source.indexOf(target, offset + 1)
  }
  return false
}

export function validateDictionaryModel(value: unknown, expectedTarget: string, sourceText: string): {
  content: DictionaryModelV1
  validationWarnings: Array<'example_duplicates_source'>
} {
  if (!validDictionaryInput(sourceText, expectedTarget)) invalid()
  boundedJson(value)
  if (!exact(value, MODEL_KEYS) || value.schemaVersion !== 1 || value.targetText !== expectedTarget || !validDictionaryText(value.targetText, 256)) invalid()
  if (!['ok', 'ambiguous', 'declined'].includes(value.status as string)) invalid()
  const semanticKeys = ['headword', 'reading', 'partOfSpeech', 'contextMeaning', 'usageNote', 'examples'] as const
  if (value.status !== 'ok') {
    const reasons = value.status === 'ambiguous' ? ['ambiguous_context', 'not_lexical_unit'] : ['unsupported_language', 'declined']
    if (!reasons.includes(value.reasonCode as string) || semanticKeys.some(key => value[key] !== null)) invalid()
  } else {
    if (value.reasonCode !== null || !validDictionaryText(value.contextMeaning, 800) || !nullableText(value.headword, 256) || !nullableText(value.partOfSpeech, 80) || !nullableText(value.usageNote, 800)) invalid()
    if (value.reading !== null && (!exact(value.reading, ['text', 'notation']) || !validDictionaryText(value.reading.text, 256) || !['kana', 'ipa', 'romanization', 'other'].includes(value.reading.notation as string))) invalid()
    if (value.examples !== null) {
      if (!Array.isArray(value.examples) || value.examples.length !== 1 || Reflect.ownKeys(value.examples).length !== 2) invalid()
      const example = value.examples[0]
      if (!exact(example, ['text', 'translation']) || !validDictionaryText(example.text, 300) || !nullableText(example.translation, 500)) invalid()
    }
  }
  // Explicit reconstruction keeps only validated contract fields, preserving exact strings rather than repairing them.
  const examples = value.examples as DictionaryModelV1['examples']
  const content: DictionaryModelV1 = {
    schemaVersion: 1, status: value.status as DictionaryModelV1['status'], reasonCode: value.reasonCode as DictionaryModelV1['reasonCode'],
    targetText: expectedTarget, headword: value.headword as string | null,
    reading: value.reading === null ? null : { text: (value.reading as DictionaryModelV1['reading'])!.text, notation: (value.reading as DictionaryModelV1['reading'])!.notation },
    partOfSpeech: value.partOfSpeech as string | null, contextMeaning: value.contextMeaning as string | null, usageNote: value.usageNote as string | null,
    examples: examples === null ? null : [{ text: examples[0].text, translation: examples[0].translation }]
  }
  const validationWarnings: Array<'example_duplicates_source'> = []
  if (content.examples?.[0].text === sourceText) { content.examples = null; validationWarnings.push('example_duplicates_source') }
  return { content, validationWarnings }
}
