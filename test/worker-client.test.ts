import { describe, expect, it } from 'vitest'
import { parseClientMessage } from '../src/shared/web-protocol'

const start = { version: 1, type: 'start', sessionId: 'synthetic-session', settings: { targetLanguages: ['zh', 'ja'], showOriginal: true, showFurigana: true } }
describe('strict relay client controls', () => {
  it('accepts only bounded versioned start, stop and retry controls', () => {
    for (const message of [start, { version: 1, type: 'stop', sessionId: start.sessionId }, { version: 1, type: 'retry', sessionId: start.sessionId, id: 'caption' }]) expect(parseClientMessage(JSON.stringify(message))).toEqual(message)
  })
  it.each(['url', 'endpoint', 'model', 'apiKey', 'headers', 'authorization'])('rejects browser-supplied %s at either control level', field => {
    for (const message of [{ ...start, [field]: 'synthetic-forbidden' }, { ...start, settings: { ...start.settings, [field]: 'synthetic-forbidden' } }]) expect(() => parseClientMessage(JSON.stringify(message))).toThrow('Invalid web session message')
  })
  it.each([
    null, [], {}, { ...start, version: 2 }, { ...start, type: 'proxy' }, { ...start, sessionId: '' }, { ...start, sessionId: 'a'.repeat(129) },
    ...[[], ['ja', 'ja'], ['unknown'], ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt']].map(targetLanguages => ({ ...start, settings: { ...start.settings, targetLanguages } })),
    { ...start, settings: { ...start.settings, showOriginal: 'true' } }, { ...start, settings: { ...start.settings, showFurigana: null } },
    { version: 1, type: 'retry', sessionId: 'synthetic-session', id: '\n' }, { version: 1, type: 'stop', sessionId: 'synthetic-session', settings: {} }
  ])('rejects invalid or unbounded control %#', message => {
    expect(() => parseClientMessage(JSON.stringify(message))).toThrow('Invalid web session message')
  })
  it('rejects binary, malformed JSON and UTF8 oversized controls before parsing', () => {
    for (const frame of [new ArrayBuffer(2), '{', '語'.repeat(50_000)]) expect(() => parseClientMessage(frame)).toThrow('Invalid web session message')
  })
})
