import { describe, expect, it } from 'vitest'
import { parseTextRequest, parseTextResponse } from '../src/shared/text-protocol'
const request = { version: 1, requestId: 'synthetic-text-1', original: '  学校 👩‍💻 é <img>  ', targetLanguages: ['ja','en'], showFurigana: true }
const caption = { id: 'text-caption', source: 'text', original: request.original, translatedOriginal: request.original, language: '混合语言', status: 'ready', createdAt: 1, targetLanguages: request.targetLanguages, translations: { ja: '学校', en: 'school' }, jaSegments: [{ text: '学校', reading: 'がっこう' }] }
describe('standalone text contract', () => {
  it('keeps original text, target order and aligned ruby without HTML interpretation', () => {
    const input = parseTextRequest(JSON.stringify(request))
    expect(input).toEqual(request)
    const result = parseTextResponse(JSON.stringify({ version: 1, requestId: request.requestId, caption }), input)
    expect(result.caption.original).toBe(request.original)
    expect(result.caption.jaSegments).toEqual(caption.jaSegments)
  })
  it('rejects empty/over-byte-budget input, extra provider config and mismatched responses', () => {
    for (const change of [{ original: '' },{ original: 'あ'.repeat(667) },{ model: 'arbitrary' },{ targetLanguages: [] }]) expect(() => parseTextRequest(JSON.stringify({ ...request, ...change }))).toThrow()
    const input = parseTextRequest(JSON.stringify(request))
    for (const change of [{ requestId: 'old' },{ caption: { ...caption, source: 'microphone' } },{ caption: { ...caption, original: 'new' } }]) expect(() => parseTextResponse(JSON.stringify({ version:1, requestId:request.requestId, caption, ...change }), input)).toThrow()
  })
})
