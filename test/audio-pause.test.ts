import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/synthetic-app' } }))
import { AudioEngine } from '../src/main/audio'
import { QwenAsrSession } from '../src/main/audio/qwen'
import { CaptionQueue } from '../src/main/captions'

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  sent: any[] = []
  terminate = vi.fn(() => { this.readyState = WebSocket.CLOSED })
  send(value: string | Buffer, callback?: (error?: Error) => void) {
    this.sent.push(Buffer.isBuffer(value) ? Buffer.from(value) : JSON.parse(value))
    callback?.()
  }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))) }
}
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe.each(['streaming', 'realtime'] as const)('bounded pause: real %s session, engine and caption queue', protocol => {
  async function fixture() {
    vi.useFakeTimers()
    const socket = new Socket()
    const queue = new CaptionQueue([], () => ({ baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'synthetic', targetLanguages: ['en'], generateFurigana: false }),
      vi.fn(), vi.fn(), async original => ({ language: 'English', translations: { en: original }, en: original, zh: '', ja: '', reading: '' }))
    const engine = new AudioEngine({
      onPartial: (source, text, id) => { if (text.trim()) queue.updatePartial(text, source, id) },
      onSentence: (source, text, id) => queue.finishSentence(text, source, id), onState: vi.fn(), onError: vi.fn(),
    }, {
      capture: { start: async () => {}, activate: () => true, stop: vi.fn() },
      createAsr: callbacks => new QwenAsrSession(callbacks, { createSocket: () => socket as unknown as WebSocket }),
    })
    const starting = engine.start({ mode: 'microphone', apiKey: 'synthetic', model: protocol === 'streaming' ? 'qwen-audio-3.1-asr-flash-streaming' : 'qwen3-asr-flash-realtime', endpoint: 'wss://fixture.invalid' })
    socket.emit('open')
    const task = socket.sent[0].header?.task_id
    const event = (kind: string, sentence?: any) => protocol === 'streaming'
      ? { header: { event: kind, task_id: task }, payload: sentence ? { output: { sentence } } : {} }
      : { type: kind, ...sentence }
    socket.message(event(protocol === 'streaming' ? 'task-started' : 'session.updated'))
    await starting
    const transcript = (text: string, final: boolean) => socket.message(protocol === 'streaming'
      ? event('result-generated', { sentence_id: 1, text, sentence_end: final })
      : event(final ? 'conversation.item.input_audio_transcription.completed' : 'conversation.item.input_audio_transcription.text',
        { item_id: 'one', ...(final ? { transcript: text } : { text }) }))
    const pause = () => engine.pause().then(result => { queue.finishPartials(); return result })
    const complete = () => socket.message(event(protocol === 'streaming' ? 'task-finished' : 'session.finished'))
    return { engine, queue, socket, transcript, pause, complete }
  }

  it.each([false, true])('retains a post-pause final in the same paragraph, including an empty boundary (%s)', async emptyFinal => {
    const f = await fixture()
    try {
      f.transcript('Synthetic unfinished', false)
      const id = f.queue.captions[0].id
      const paused = f.pause(); await settle()
      const before = f.socket.sent.length
      f.engine.pushMicrophone(new Int16Array([1, -1]).buffer)
      expect(f.socket.sent).toHaveLength(before)
      const original = emptyFinal ? 'Synthetic unfinished' : 'Synthetic unfinished sentence is now complete.'
      f.transcript(emptyFinal ? '' : original, true)
      f.complete()
      await expect(paused).resolves.toBe('finished')
      await settle()
      expect(f.queue.captions).toHaveLength(1)
      expect(f.queue.captions[0]).toMatchObject({ id, original, translatedOriginal: original, live: false, status: 'ready', translationPending: false })
      expect(f.socket.terminate).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { f.engine.stop(); f.queue.close() }
  })

  it('finalizes the last known partial on deadline and ignores a final that arrives after timeout', async () => {
    const f = await fixture()
    try {
      f.transcript('Synthetic last known partial', false)
      const id = f.queue.captions[0].id
      const paused = f.pause(); await settle()
      await vi.advanceTimersByTimeAsync(2000)
      await expect(paused).resolves.toBe('timeout')
      await settle()
      f.transcript('Too late synthetic final', true); f.complete()
      expect(f.queue.captions).toHaveLength(1)
      expect(f.queue.captions[0]).toMatchObject({ id, original: 'Synthetic last known partial',
        translatedOriginal: 'Synthetic last known partial', live: false, status: 'ready', translationPending: false })
      expect(vi.getTimerCount()).toBe(0)
    } finally { f.engine.stop(); f.queue.close() }
  })
})
