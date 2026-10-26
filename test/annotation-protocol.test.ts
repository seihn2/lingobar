import { describe, expect, it } from 'vitest'
import { annotationText, parseAnnotationRequest, parseAnnotationResponse, type AnnotationRequest } from '../src/shared/annotation-protocol'
import type { Caption } from '../src/shared/types'

const request: AnnotationRequest = { version: 1, type: 'annotation', sessionId: 'text-session', requestId: 'request', captionId: 'history:one', sourceRevision: 3, language: 'ja', original: 'Synthetic weather 😀', japanese: '天気です。' }
const response = () => { const { original: _source, japanese: _text, ...identity } = request; return { ...identity, reading: '', jaSegments: [{ text: '天気', reading: 'てんき' }, { text: 'です。' }] } }
const encode = JSON.stringify
describe('strict text-only annotation contract', () => {
  it('roundtrips exact Unicode text and matching versioned identity without returning source text', () => {
    expect(parseAnnotationRequest(encode(request))).toEqual(request)
    expect(parseAnnotationResponse(encode(response()), request)).toEqual(response())
    expect(response()).not.toHaveProperty('original')
  })
  it.each([{ audio: 'rejected' }, { url: 'https://example.invalid' }, { model: 'rejected' }, { apiKey: 'rejected' }, { language: 'en' }, { type: 'retry' }, { sourceRevision: 0 }, { sourceRevision: 1.5 }, { captionId: '\n' }, { original: '\uD800' }, { japanese: ' ' }, { original: 'x'.repeat(8001) }])('rejects fields outside the fixed text-only contract: %j', change => {
    expect(() => parseAnnotationRequest(encode({ ...request, ...change }))).toThrow('Invalid annotation')
  })
  it('bounds JSON bytes, requires all fields and rejects pre-parsed objects', () => {
    expect(() => parseAnnotationRequest(request)).toThrow()
    const { original: _original, ...missing } = request
    expect(() => parseAnnotationRequest(encode(missing))).toThrow()
    expect(() => parseAnnotationRequest(' '.repeat(65_537))).toThrow()
  })
  it.each(['requestId', 'sessionId', 'captionId', 'sourceRevision', 'language'] as const)('rejects stale %s, invalid ruby and unexpected raw fields', key => {
    expect(() => parseAnnotationResponse(encode({ ...response(), [key]: key === 'sourceRevision' ? 2 : 'old' }), request)).toThrow()
    expect(() => parseAnnotationResponse(encode({ ...response(), jaSegments: [{ text: '違う' }] }), request)).toThrow()
    expect(() => parseAnnotationResponse(encode({ ...response(), error: 'raw upstream body' }), request)).toThrow()
  })
  it('requires finalized aligned source+Japanese without conflating furi failure with translation failure', () => {
    const caption: Caption = { id: 'one', original: request.original, ja: request.japanese, translations: { ja: request.japanese }, reading: '', zh: '', en: '', source: 'text', language: 'English', status: 'ready', saved: true, createdAt: 1, furiganaStatus: 'error' }
    expect(annotationText(caption)).toEqual({ original: request.original, japanese: request.japanese })
    for (const change of [{ live: true }, { translationPending: true }, { status: 'error' }, { translatedOriginal: 'old prefix' }, { ja: 'stale Japanese' }]) expect(annotationText({ ...caption, ...change } as Caption)).toBeNull()
  })
})
