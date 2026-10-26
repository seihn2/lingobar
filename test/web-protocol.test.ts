import { describe, expect, it, vi } from 'vitest'
import { MAX_WEB_CAPTIONS, MAX_WEB_MESSAGE_BYTES, parseServerMessage, type WebClientMessage, type WebServerMessage } from '../src/shared/web-protocol'

vi.mock('electron', () => { throw new Error('Web protocol must not load Electron') })
vi.mock('../src/main/translation', () => { throw new Error('Web protocol must not load desktop service code') })

const original = 'Synthetic source: 今日は学校で学ぶ 👩‍💻 𠮷 café e\u0301'
const caption = () => ({ id: 'synthetic-caption', source: 'microphone', original, language: '日本語', createdAt: 0,
  status: 'translating', live: true, translationPending: true })
const message = (value: unknown) => JSON.stringify(value)
const frame = (overrides: Record<string, unknown> = {}) => message({ version: 1, type: 'caption', sessionId: 'synthetic-session', revision: 1, caption: caption(), ...overrides })
function parsedCaption(value: Record<string, unknown>) {
  const result = parseServerMessage(frame({ caption: value }))
  if (result.type !== 'caption') throw new Error('Expected caption fixture')
  return result.caption
}
function rejects(value: unknown) {
  expect(() => parseServerMessage(value)).toThrow(/^Invalid web session message$/)
}

describe('versioned web session protocol without devices or providers', () => {
  it('exports bounded session constants and discriminated client message types', () => {
    expect(MAX_WEB_MESSAGE_BYTES).toBe(131072)
    expect(MAX_WEB_CAPTIONS).toBe(500)
    const client: WebClientMessage[] = [
      { version: 1, type: 'start', sessionId: 'synthetic', settings: { targetLanguages: ['ja', 'en'], showOriginal: true, showFurigana: true } },
      { version: 1, type: 'stop', sessionId: 'synthetic' },
      { version: 1, type: 'retry', sessionId: 'synthetic', id: 'synthetic-caption' }
    ]
    expect(client.map(value => value.type)).toEqual(['start', 'stop', 'retry'])
  })

  it('accepts ready and every public error code without exposing provider payloads', () => {
    expect(parseServerMessage(message({ version: 1, type: 'ready', sessionId: '会話-𠮷' }))).toEqual({ version: 1, type: 'ready', sessionId: '会話-𠮷' })
    for (const code of ['unauthorized', 'quota', 'upstream', 'protocol', 'unavailable']) {
      const result: WebServerMessage = parseServerMessage(message({ version: 1, type: 'error', sessionId: 'synthetic', code,
        error: { apiKey: 'SYNTHETIC-PRIVATE-KEY' }, message: 'SYNTHETIC-PRIVATE-FAILURE', stack: 'SYNTHETIC-STACK' }))
      expect(result).toEqual({ version: 1, type: 'error', sessionId: 'synthetic', code })
    }
  })

  it('accepts a growing untranslated caption with required clean legacy fields', () => {
    expect(parsedCaption(caption())).toEqual({ ...caption(), translations: {}, zh: '', en: '', ja: '', reading: '', saved: false })
    expect(parsedCaption({ ...caption(), source: 'text', status: 'error', error: 'SYNTHETIC-PRIVATE-PROVIDER-FAILURE' })).toMatchObject({ source: 'text', status: 'error', saved: false })
    expect(parsedCaption({ ...caption(), source: 'text', status: 'error', error: 'SYNTHETIC-PRIVATE-PROVIDER-FAILURE' })).not.toHaveProperty('error')
  })

  it('accepts a final with aligned ruby and prefers map values to legacy fields', () => {
    const value = { ...caption(), status: 'ready', live: false, translationPending: false, translatedOriginal: original,
      translations: { en: 'Synthetic final', ja: '学校で学ぶ。' }, en: 'Old English', ja: '古い日本語', reading: 'がっこうでまなぶ。',
      targetLanguages: ['en', 'ja'], furiganaStatus: 'ready', jaSegments: [{ text: '学校', reading: 'がっこう' }, { text: 'で' }, { text: '学', reading: 'まな' }, { text: 'ぶ。' }] }
    expect(parsedCaption(value)).toEqual({ ...value, zh: '', en: 'Synthetic final', ja: '学校で学ぶ。', saved: false })
  })

  it('preserves valid legacy translations and treats an explicitly empty map entry as authoritative', () => {
    expect(parsedCaption({ ...caption(), zh: '合成译文', en: 'Synthetic legacy', ja: '合成', reading: 'ごうせい' })).toMatchObject({
      translations: { zh: '合成译文', en: 'Synthetic legacy', ja: '合成' }, zh: '合成译文', en: 'Synthetic legacy', ja: '合成' })
    expect(parsedCaption({ ...caption(), translations: { en: '' }, en: 'SYNTHETIC-OLD-TEXT' })).toMatchObject({ translations: { en: '' }, en: '' })
  })

  it('reconstructs allowlisted objects, keeps browser-owned saved false, and drops hidden payloads', () => {
    const value = JSON.parse(frame({ caption: { ...caption(), status: 'ready', translations: { ja: '学校' }, targetLanguages: ['ja'],
      jaSegments: [{ text: '学校', reading: 'がっこう', apiKey: 'SYNTHETIC-PRIVATE' }], saved: { secret: 'SYNTHETIC-PRIVATE' },
      error: 'SYNTHETIC-PRIVATE', apiKey: 'SYNTHETIC-PRIVATE', settings: { token: 'SYNTHETIC-PRIVATE' },
      __proto__: { polluted: 'SYNTHETIC-PRIVATE' }, profile: { nested: 'SYNTHETIC-PRIVATE' } }, secret: 'SYNTHETIC-PRIVATE' }))
    Object.defineProperty(value.caption, '__proto__', { enumerable: true, value: { polluted: 'SYNTHETIC-PRIVATE' } })
    const clean = parseServerMessage(message(value))
    expect(message(clean)).not.toContain('SYNTHETIC-PRIVATE')
    expect(clean.type).toBe('caption')
    if (clean.type !== 'caption') throw new Error('Expected fixture caption')
    expect(clean.caption.saved).toBe(false)
    expect(Object.getPrototypeOf(clean.caption)).toBe(Object.prototype)
    expect(clean.caption.jaSegments).toEqual([{ text: '学校', reading: 'がっこう' }])
    expect(Object.prototype).not.toHaveProperty('polluted')
    const another = parseServerMessage(message(value))
    if (another.type !== 'caption') throw new Error('Expected fixture caption')
    clean.caption.targetLanguages!.push('en')
    expect(another.caption.targetLanguages).toEqual(['ja'])
  })

  it('preserves Unicode and HTML-looking strings as literal text without normalization or markup fields', () => {
    const html = '<img src=x onerror="globalThis.synthetic=1">& <script>synthetic()</script>'
    const result = parsedCaption({ ...caption(), original: original + html, translations: { en: html } })
    expect(result.original).toBe(original + html)
    expect(result.en).toBe(html)
    expect(result).not.toHaveProperty('innerHTML')
    expect(result.original).toContain('👩‍💻 𠮷 café e\u0301')
  })

  it('applies the frame limit to UTF-8 bytes, including ignored fields, at the exact boundary', () => {
    const value = { version: 1, type: 'ready', sessionId: 'synthetic', ignored: '' }
    const prefix = message(value)
    const exact = message({ ...value, ignored: 'x'.repeat(MAX_WEB_MESSAGE_BYTES - new TextEncoder().encode(prefix).byteLength) })
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_WEB_MESSAGE_BYTES)
    expect(parseServerMessage(exact)).toEqual({ version: 1, type: 'ready', sessionId: 'synthetic' })
    rejects(exact + ' ')
    const unicode = message({ ...value, ignored: '語'.repeat(50_000) })
    expect(unicode.length).toBeLessThan(MAX_WEB_MESSAGE_BYTES)
    rejects(unicode)
  })

  it.each([null, undefined, 1, true, {}, [], new ArrayBuffer(2), new Uint8Array(2), new Blob(['{}']), '{', 'null', '[]', '"text"'])('rejects a non-text or non-object envelope (%s)', value => rejects(value))

  it.each([
    { version: 2 }, { version: '1' }, { version: null }, { version: undefined }, { type: 'start' }, { type: '' },
    { sessionId: '' }, { sessionId: '  ' }, { sessionId: 'x'.repeat(129) }, { sessionId: 'id\n' }, { sessionId: 'id\u0085' },
    { sessionId: '\ud800' }, { revision: 0 }, { revision: -1 }, { revision: 1.1 }, { revision: '1' },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: Infinity }, { caption: [] }, { caption: null }
  ])('rejects invalid envelope fields without reflecting their values (%j)', changes => rejects(frame(changes)))

  it('accepts maximum safe revisions and 128-unit nonblank identifiers', () => {
    const result = parseServerMessage(frame({ sessionId: 's'.repeat(128), revision: Number.MAX_SAFE_INTEGER,
      caption: { ...caption(), id: 'c'.repeat(128) } }))
    expect(result).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, sessionId: 's'.repeat(128) })
  })

  it.each([
    { id: '' }, { id: '\t' }, { id: 'id\u0000' }, { id: 'x'.repeat(129) }, { source: 'system' }, { source: 'camera' },
    { original: undefined }, { original: 1 }, { original: 'x'.repeat(8001) }, { original: 'bad\u0000text' }, { original: '\udfff' },
    { language: undefined }, { language: 'x'.repeat(81) }, { language: {} }, { createdAt: -1 }, { createdAt: NaN },
    { createdAt: Infinity }, { createdAt: '0' }, { createdAt: undefined }, { status: 'finished' }, { status: 1 },
    { reading: {} }, { reading: 'x'.repeat(8001) }, { en: {} }, { ja: 'x'.repeat(8001) },
    { translatedOriginal: 'x'.repeat(8001) }, { translatedOriginal: false }, { live: 1 }, { live: null }, { translationPending: 'true' },
    { targetLanguages: [] }, { targetLanguages: ['en', 'en'] }, { targetLanguages: ['unknown'] }, { targetLanguages: 'en' },
    { targetLanguages: ['zh', 'en', 'ja', 'fr', 'de', 'es', 'ko', 'ar', 'pt'] }, { furiganaStatus: 'complete' },
    { translations: [] }, { translations: null }, { translations: { en: 1 } }, { translations: { unknown: 'synthetic' } },
    { translations: { en: 'x'.repeat(8001) } }, { translations: { ja: '\ud800' } }
  ])('rejects malformed caption fields (%j)', changes => rejects(frame({ caption: { ...caption(), ...changes } })))

  it('bounds each known translation, source, reading and language without splitting valid Unicode', () => {
    const text = '𠮷'.repeat(4000)
    const result = parsedCaption({ ...caption(), original: text, translatedOriginal: text, language: 'x'.repeat(80),
      translations: { en: text }, reading: 'あ'.repeat(8000), targetLanguages: ['en'] })
    expect(result.original.length).toBe(8000)
    expect(result.en).toBe(text)
    expect(result.reading.length).toBe(8000)
  })

  it('accepts eight known translation languages and rejects excess maps or legacy merging past eight', () => {
    const translations = { zh: '合成', en: 'synthetic', ja: '合成', fr: 'synthétique', de: 'synthetisch', ko: '합성', es: 'sintético', ar: 'اصطناعي' }
    expect(parsedCaption({ ...caption(), translations, targetLanguages: Object.keys(translations) }).translations).toEqual(translations)
    rejects(frame({ caption: { ...caption(), translations: { ...translations, pt: 'sintético' } } }))
    const { zh: _zh, ...rest } = translations
    rejects(frame({ caption: { ...caption(), translations: { ...rest, pt: 'sintético' }, zh: '合成' } }))
    rejects(frame({ caption: { ...caption(), translations: JSON.parse('{"__proto__":"synthetic"}') } }))
  })

  it.each(['debug', '', null, 1, { key: 'SYNTHETIC-PRIVATE' }])('rejects non-public error codes (%j)', code => {
    rejects(message({ version: 1, type: 'error', sessionId: 'synthetic', code }))
  })

  it('reports the same generic error for malformed JSON, private payloads and invalid ruby', () => {
    for (const value of ['SYNTHETIC-PRIVATE-KEY', frame({ sessionId: { secret: 'SYNTHETIC-PRIVATE-KEY' } }),
      frame({ caption: { ...caption(), translations: { ja: '学校' }, jaSegments: [{ text: '違う', reading: 'ちがう' }] } })]) rejects(value)
  })

  it.each([
    [], null, {}, [{ text: '' }], [{ text: '違う' }], [{ text: '学' }], [{ text: '学校', reading: '' }],
    [{ text: '学校', reading: 'School' }], [{ text: '学校', reading: '漢字' }], [{ text: '学校', reading: 'ー ・' }],
    [{ text: '学校', reading: '<script>' }], [{ text: '学校', reading: ['がっこう'] }], [{ text: '学校', reading: '\ud800' }],
    [{ text: 1 }], [{ text: '学校\u0000' }], [{ text: '学校で', reading: 'がっこうで' }],
    [{ text: '学校', reading: 'がっこう' }, { text: 'extra' }]
  ])('rejects missing, guessed, non-kana or misaligned ruby (%j)', jaSegments => {
    rejects(frame({ caption: { ...caption(), translations: { ja: '学校' }, jaSegments } }))
  })

  it('keeps unknown readings plain and rejects ruby without Japanese or on kana-only text', () => {
    expect(parsedCaption({ ...caption(), translations: { ja: '学校👩‍💻' }, jaSegments: [{ text: '学校' }, { text: '👩‍💻' }] }).jaSegments).toEqual([{ text: '学校' }, { text: '👩‍💻' }])
    rejects(frame({ caption: { ...caption(), jaSegments: [{ text: '学校', reading: 'がっこう' }] } }))
    rejects(frame({ caption: { ...caption(), translations: { ja: 'かな' }, jaSegments: [{ text: 'かな', reading: 'かな' }] } }))
    rejects(frame({ caption: { ...caption(), translations: { ja: '学'.repeat(1001) }, jaSegments: Array.from({ length: 1001 }, () => ({ text: '学' })) } }))
  })

  it('keeps supplementary kanji and variation selectors aligned with valid kana readings', () => {
    const ja = '𠮷野家と葛\u{E0100}'
    const jaSegments = [{ text: '𠮷野家', reading: 'ヨシノヤ' }, { text: 'と' }, { text: '葛\u{E0100}', reading: 'かつ' }]
    expect(parsedCaption({ ...caption(), translations: { ja }, jaSegments }).jaSegments).toEqual(jaSegments)
  })
})
