import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelaySession, SESSION_LIMITS } from '../src/worker/session'
import { TRANSLATION_ENDPOINT } from '../src/worker/completion'
import type { RelayConfig, UpgradeResponse, WorkerFetch, WorkerSocket } from '../src/worker/types'
import { BrowserSession, type WebSocketPort } from '../src/web/session'
import { parseServerMessage } from '../src/shared/web-protocol'
import type { TargetLanguage } from '../src/shared/languages'
import { alignedOriginal, incomingText } from '../src/renderer/caption-text'

vi.mock('electron', () => { throw new Error('Relay integration must not load Electron') })
vi.mock('ws', () => { throw new Error('Relay integration must not load Node ws') })
vi.mock('../src/main/diagnostics', () => { throw new Error('Relay integration must not load desktop diagnostics') })

class Peer extends EventTarget implements WorkerSocket {
  readyState = 0
  bufferedAmount = 0
  remote?: Peer
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  accept() { this.readyState = 1 }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1) throw new Error('Synthetic closed peer')
    this.sent.push(data)
    this.remote?.dispatchEvent(new MessageEvent('message', { data }))
  }
  close = vi.fn((_code?: number, _reason?: string) => {
    if (this.readyState === 3) return
    this.readyState = 3; this.dispatchEvent(new Event('close'))
    if (this.remote && this.remote.readyState !== 3) { this.remote.readyState = 3; this.remote.dispatchEvent(new Event('close')) }
  })
}
class Upstream extends EventTarget implements WorkerSocket {
  readyState = 0
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  accept() { this.readyState = 1 }
  send(data: string | ArrayBuffer | ArrayBufferView) { if (this.readyState !== 1) throw new Error('Synthetic closed upstream'); this.sent.push(data) }
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event('close')) })
  packet(kind: string, sentence?: object) {
    const taskId = JSON.parse(this.sent[0] as string).header.task_id
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ header: { task_id: taskId, event: kind }, payload: sentence ? { output: { sentence } } : {} }) }))
  }
  partial(text: string, sentence_id = 1) { this.packet('result-generated', { sentence_id, text, sentence_end: false }) }
  final(text: string, sentence_id = 1, stash?: object) { this.packet('result-generated', { sentence_id, text, sentence_end: true, ...(stash ? { stash } : {}) }) }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type Completion = ReturnType<typeof deferred<UpgradeResponse>> & { source: string; data: any; prompt: string; signal: AbortSignal }
const settle = async () => { for (let index = 0; index < 80; index++) await Promise.resolve() }
const config: RelayConfig = { asrKey: 'synthetic-key-ASR-PRIVATE', translationKey: 'synthetic-key-TRANSLATION-PRIVATE', model: 'qwen-audio-3.1-asr-flash-streaming' }
const response = (value: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status }) as UpgradeResponse
const fixtures: Array<{ browser: BrowserSession; connections: Array<{ relay: RelaySession }>; completions: Completion[] }> = []
const network = vi.fn(() => { throw new Error('Real network forbidden in synthetic relay integration') })

function fixture(options: { targets?: TargetLanguage[]; furigana?: boolean; asrStatus?: number } = {}) {
  const targets = options.targets || ['en']
  const completions: Completion[] = [], upstreams: Upstream[] = [], connections: Array<{ client: Peer; peer: Peer; relay: RelaySession }> = []
  const held: Promise<unknown>[] = [], captures: AbortSignal[] = [], cleanup = vi.fn()
  let nextId = 0, pcm!: (value: ArrayBuffer) => void
  const fetch = vi.fn<WorkerFetch>(async (url, init) => {
    if (String(url) === 'https://dashscope.aliyuncs.com/api-ws/v1/inference') {
      expect(init).toMatchObject({ redirect: 'error', headers: { Upgrade: 'websocket', Authorization: `Bearer ${config.asrKey}` } })
      if (options.asrStatus) return new Response('synthetic-key-PRIVATE-PROVIDER-BODY', { status: options.asrStatus }) as UpgradeResponse
      const socket = new Upstream(); upstreams.push(socket)
      return { status: 101, webSocket: socket } as unknown as UpgradeResponse
    }
    expect(String(url)).toBe(TRANSLATION_ENDPOINT)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.translationKey}` } })
    const body = JSON.parse(init!.body as string), data = JSON.parse(body.messages[1].content)
    const request: Completion = { ...deferred<UpgradeResponse>(), source: data.source_text, data, prompt: body.messages[0].content, signal: init!.signal as AbortSignal }
    completions.push(request)
    // Deliberately ignore abort here: the real transport/queue must reject late work.
    return request.promise
  })
  const browser = new BrowserSession({ backend: '/api/session', origin: 'https://synthetic.invalid', id: () => `browser-${connections.length + 1}`,
    socket: () => {
      const client = new Peer(), peer = new Peer(); client.remote = peer; peer.remote = client; peer.accept()
      const relay = new RelaySession(peer, config, { fetch, id: () => `relay-${++nextId}`, hold: promise => { held.push(promise) } })
      connections.push({ client, peer, relay }); return client as unknown as WebSocketPort
    },
    capture: async (chunk, _error, signal) => { pcm = chunk; captures.push(signal); return cleanup }
  })
  browser.saveSettings({ targetLanguages: targets, showFurigana: options.furigana ?? false })
  const begin = () => { const promise = browser.start(); connections.at(-1)!.client.open(); return promise }
  const start = async () => { const promise = begin(); await settle(); upstreams.at(-1)!.packet('task-started'); await promise; return upstreams.at(-1)! }
  const frames = () => connections.flatMap(connection => connection.peer.sent.filter((value): value is string => typeof value === 'string').map(parseServerMessage))
  const translate = (request: Completion, values?: Partial<Record<TargetLanguage, string>>) => request.resolve(response({ language: '英语', translations: values || Object.fromEntries(targets.map(code => [code, code === 'ja' ? '学校で学ぶ。' : `Synthetic ${code}: ${request.source}`])) }))
  const f = { browser, fetch, completions, upstreams, connections, captures, cleanup, held, begin, start, frames, translate, pcm: (value: ArrayBuffer) => pcm(value) }
  fixtures.push(f); return f
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); network.mockClear(); vi.stubGlobal('fetch', network) })
afterEach(async () => {
  for (const f of fixtures) {
    f.browser.dispose()
    for (const connection of f.connections) connection.relay.stop()
    for (const request of f.completions) request.reject(new Error('Synthetic cleanup'))
  }
  await settle()
  expect(vi.getTimerCount()).toBe(0)
  expect(network).not.toHaveBeenCalled()
  fixtures.length = 0; vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('real browser, relay, ASR, caption scheduler and completion with synthetic boundaries', () => {
  it('translates the first 650ms partial and reuses its paragraph on an identical final', async () => {
    const f = fixture(), upstream = await f.start()
    const pcm = new Int16Array([0, 12, -12, 0]).buffer
    f.pcm(pcm)
    expect(upstream.sent.at(-1)).toBe(pcm)
    upstream.partial('Synthetic growing prefix')
    const id = f.browser.snapshot().captions[0].id
    expect(f.browser.snapshot().captions[0]).toMatchObject({ original: 'Synthetic growing prefix', live: true, status: 'translating' })
    await vi.advanceTimersByTimeAsync(649); expect(f.completions).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1); expect(f.completions).toHaveLength(1)
    expect(f.completions[0].source).toBe('Synthetic growing prefix')
    f.translate(f.completions[0]); await settle()
    expect(f.browser.snapshot().captions[0]).toMatchObject({ id, translatedOriginal: 'Synthetic growing prefix', en: 'Synthetic en: Synthetic growing prefix', live: true })
    upstream.final('Synthetic growing prefix'); await settle()
    expect(f.completions).toHaveLength(1)
    expect(f.browser.snapshot().captions).toHaveLength(1)
    expect(f.browser.snapshot().captions[0]).toMatchObject({ id, status: 'ready', live: false, translationPending: false })
    const revisions = f.frames().filter(frame => frame.type === 'caption').map(frame => frame.type === 'caption' ? frame.revision : 0)
    expect(revisions.length).toBeGreaterThan(2); expect(revisions).toEqual([...new Set(revisions)].sort((a, b) => a - b))
  })

  it('keeps final/stash source order and IDs when their completion responses finish in reverse order', async () => {
    const f = fixture(), upstream = await f.start()
    upstream.final('Synthetic first final', 1, { sentence_id: 2, text: 'Synthetic next draft' }); await settle()
    const ids = f.browser.snapshot().captions.map(caption => caption.id)
    expect(f.browser.snapshot().captions.map(caption => caption.original)).toEqual(['Synthetic first final', 'Synthetic next draft'])
    await vi.advanceTimersByTimeAsync(650); expect(f.completions).toHaveLength(2)
    f.translate(f.completions[1]); await settle(); f.translate(f.completions[0]); await settle()
    upstream.final('Synthetic next draft', 2); await settle()
    expect(f.browser.snapshot().captions.map(caption => caption.id)).toEqual(ids)
    expect(f.browser.snapshot().captions.map(caption => [caption.original, caption.translatedOriginal])).toEqual([
      ['Synthetic first final', 'Synthetic first final'], ['Synthetic next draft', 'Synthetic next draft']
    ])
    expect(f.completions).toHaveLength(2)
  })

  it('retracts a corrected long draft while retaining final history and exact translation/source pairing', async () => {
    const f = fixture(), upstream = await f.start()
    upstream.final('Synthetic retained final'); await settle(); f.translate(f.completions[0]); await settle()
    const finalId = f.browser.snapshot().captions[0].id
    upstream.partial('語'.repeat(8000), 2)
    expect(f.browser.snapshot().captions).toHaveLength(3)
    const tailId = f.browser.snapshot().captions[2].id
    await vi.advanceTimersByTimeAsync(650); expect(f.completions).toHaveLength(3)
    upstream.partial('Synthetic corrected short draft', 2)
    expect(f.browser.snapshot().captions.map(caption => caption.id)).not.toContain(tailId)
    expect(f.browser.snapshot().captions[0]).toMatchObject({ id: finalId, live: false, original: 'Synthetic retained final' })
    expect(f.frames().filter(frame => frame.type === 'retract')).toHaveLength(1)
    // The removed tail is cancelled immediately. While still live, the first
    // chunk may publish old work paired with its exact translatedOriginal.
    expect(f.completions[2].signal.aborted).toBe(true)
    f.translate(f.completions[1], { en: 'Synthetic late old prefix' }); f.translate(f.completions[2], { en: 'Synthetic late old tail' }); await settle()
    expect(f.browser.snapshot().captions).toHaveLength(2)
    const live = f.browser.snapshot().captions[1]
    expect(live).toMatchObject({ original: 'Synthetic corrected short draft', en: 'Synthetic late old prefix', translatedOriginal: '語'.repeat(6000), translationPending: true })
    expect(alignedOriginal(live)).toBe(f.completions[1].source)
    expect(incomingText(live.original, live)).toBe('Synthetic corrected short draft')
    expect(JSON.stringify(f.browser.snapshot())).not.toContain('Synthetic late old tail')
    upstream.final('Synthetic corrected short draft', 2); await settle()
    expect(f.completions).toHaveLength(4)
    expect(f.completions[3].source).toBe('Synthetic corrected short draft')
    f.translate(f.completions[3]); await settle()
    expect(f.browser.snapshot().captions[1]).toMatchObject({ original: 'Synthetic corrected short draft', translatedOriginal: 'Synthetic corrected short draft', en: 'Synthetic en: Synthetic corrected short draft', live: false, translationPending: false })
  })

  it.each(['success', 'failure'] as const)('hard stop isolates the next owner from late %s and reused provider IDs', async outcome => {
    const f = fixture(), old = await f.start()
    old.final('Synthetic old source'); await settle()
    const oldId = f.browser.snapshot().captions[0].id
    f.browser.stop()
    expect(f.completions[0].signal.aborted).toBe(true); expect(f.captures[0].aborted).toBe(true)
    const current = await f.start(); current.final('Synthetic new source'); await settle()
    const currentId = f.browser.snapshot().captions[1].id
    expect(currentId).not.toBe(oldId)
    if (outcome === 'success') f.translate(f.completions[0], { en: 'MUST-NOT-PUBLISH old translation' })
    else f.completions[0].reject(new Error('synthetic-key-MUST-NOT-PUBLISH'))
    old.final('MUST-NOT-PUBLISH old audio'); old.dispatchEvent(new Event('error'))
    f.translate(f.completions[1]); await settle()
    expect(f.browser.snapshot().state).toBe('listening')
    expect(f.browser.snapshot().captions[1]).toMatchObject({ id: currentId, original: 'Synthetic new source', en: 'Synthetic en: Synthetic new source' })
    expect(JSON.stringify(f.browser.snapshot())).not.toContain('MUST-NOT-PUBLISH')
    expect(f.cleanup).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a corrected final when its older partial HTTP response arrives last', async () => {
    const f = fixture(), upstream = await f.start()
    upstream.partial('Synthetic wrong hypothesis'); await vi.advanceTimersByTimeAsync(650)
    const id = f.browser.snapshot().captions[0].id
    upstream.final('Synthetic corrected final'); await settle()
    expect(f.completions).toHaveLength(2)
    expect(f.completions[0].signal.aborted).toBe(true)
    f.translate(f.completions[1]); await settle()
    const completed = f.browser.snapshot().captions[0]
    expect(completed).toMatchObject({ id, original: 'Synthetic corrected final', translatedOriginal: 'Synthetic corrected final', en: 'Synthetic en: Synthetic corrected final', live: false, status: 'ready' })
    f.translate(f.completions[0], { en: 'Synthetic obsolete translation' }); await settle()
    expect(f.browser.snapshot().captions[0]).toEqual(completed)
    expect(JSON.stringify(f.frames())).not.toContain('Synthetic obsolete translation')
  })

  it('aborts an expired completion, rejects its late success and permits retry of the exact original', async () => {
    const f = fixture(), upstream = await f.start()
    upstream.final('Synthetic timeout original'); await settle()
    const id = f.browser.snapshot().captions[0].id
    await vi.advanceTimersByTimeAsync(25_000)
    expect(f.completions[0].signal.aborted).toBe(true)
    f.translate(f.completions[0], { en: 'Synthetic expired translation' }); await settle()
    expect(f.browser.snapshot().state).toBe('listening')
    expect(f.browser.snapshot().captions[0]).toMatchObject({ id, original: 'Synthetic timeout original', status: 'error', translationPending: false, en: '' })
    expect(f.frames().filter(frame => frame.type === 'error')).toHaveLength(0)
    f.browser.retry(id); await settle()
    expect(f.completions).toHaveLength(2)
    expect(f.completions[1].source).toBe('Synthetic timeout original')
    f.translate(f.completions[1]); await settle()
    expect(f.browser.snapshot().captions[0]).toMatchObject({ id, translatedOriginal: 'Synthetic timeout original', en: 'Synthetic en: Synthetic timeout original', status: 'ready', translationPending: false })
    expect(JSON.stringify(f.frames())).not.toContain('Synthetic expired translation')
  })

  it('coalesces duplicate retry requests while preserving a browser-local saved marker', async () => {
    const f = fixture(), upstream = await f.start()
    upstream.final('Synthetic retry original'); await settle(); f.translate(f.completions[0]); await settle()
    const id = f.browser.snapshot().captions[0].id
    f.browser.toggleSaved(id); expect(f.browser.snapshot().captions[0].saved).toBe(true)
    f.browser.retry(id)
    expect(() => f.browser.retry(id)).toThrow('尚未定稿')
    const retry = f.connections[0].client.sent.filter((value): value is string => typeof value === 'string').map(value => JSON.parse(value)).find(value => value.type === 'retry')
    f.connections[0].client.send(JSON.stringify(retry)); await settle()
    expect(f.completions).toHaveLength(2); expect(f.completions[1].source).toBe('Synthetic retry original')
    f.translate(f.completions[1], { en: 'Synthetic retried translation' }); await settle()
    expect(f.browser.snapshot().captions[0]).toMatchObject({ id, saved: true, status: 'ready', translationPending: false, en: 'Synthetic retried translation' })
  })

  it('keeps eight selected languages and validates Japanese ruby independently of local saving', async () => {
    const targets: TargetLanguage[] = ['en', 'ja', 'zh', 'fr', 'de', 'ko', 'es', 'ar']
    const f = fixture({ targets, furigana: true }), upstream = await f.start()
    upstream.final('Synthetic Japanese learning sentence'); await settle(); f.translate(f.completions[0]); await settle()
    expect(f.completions).toHaveLength(2)
    expect(f.completions[1].data).toMatchObject({ source_text: 'Synthetic Japanese learning sentence', japanese: '学校で学ぶ。' })
    expect(f.completions[1].data.slots.map((slot: any) => [slot.id, slot.text])).toEqual([['h0', '学校'], ['h1', '学']])
    const id = f.browser.snapshot().captions[0].id
    f.browser.toggleSaved(id)
    expect(f.browser.snapshot().captions[0].furiganaStatus).toBe('pending')
    f.completions[1].resolve(response({ readings: [{ id: 'h0', reading: 'がっこう' }, { id: 'h1', reading: 'まな' }] })); await settle()
    const caption = f.browser.snapshot().captions[0]
    expect(caption).toMatchObject({ id, saved: true, furiganaStatus: 'ready', ja: '学校で学ぶ。' })
    expect(caption.targetLanguages).toEqual(targets)
    expect(Object.keys(caption.translations!)).toEqual(targets)
    expect(caption.jaSegments).toEqual([{ text: '学校', reading: 'がっこう' }, { text: 'で' }, { text: '学', reading: 'まな' }, { text: 'ぶ。' }])
    expect(caption.jaSegments!.map(segment => segment.text).join('')).toBe(caption.ja)
  })

  it.each([401, 429])('classifies completion HTTP %s without leaking the synthetic server keys', async status => {
    const f = fixture(), upstream = await f.start()
    upstream.final('Synthetic failure source'); await settle()
    f.completions[0].resolve(new Response(`synthetic-key-PRIVATE ${config.translationKey}`, { status }) as UpgradeResponse); await settle()
    expect(f.frames().filter(frame => frame.type === 'error')).toEqual([{ version: 1, type: 'error', sessionId: 'browser-1', code: status === 401 ? 'unauthorized' : 'quota' }])
    expect(f.browser.snapshot().state).toBe('error')
    expect(JSON.stringify(f.browser.snapshot())).not.toContain('synthetic-key')
    expect(f.connections[0].peer.readyState).toBe(3); expect(f.cleanup).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([401, 429])('rejects ASR upgrade HTTP %s before any browser microphone starts', async status => {
    const f = fixture({ asrStatus: status })
    await expect(f.begin()).rejects.toThrow(status === 401 ? '未授权' : '额度')
    expect(f.captures).toHaveLength(0); expect(f.upstreams).toHaveLength(0)
    expect(f.frames().filter(frame => frame.type === 'error').map(frame => frame.type === 'error' ? frame.code : '')).toEqual([status === 401 ? 'unauthorized' : 'quota'])
    expect(JSON.stringify(f.browser.snapshot())).not.toContain('synthetic-key')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['peer-close', 'peer-error', 'upstream-error'] as const)('releases capture, transport and pending completion after %s', async failure => {
    const f = fixture(), upstream = await f.start()
    upstream.final('Synthetic pending final'); await settle()
    if (failure === 'peer-close') f.connections[0].client.close()
    else if (failure === 'peer-error') f.connections[0].peer.dispatchEvent(new Event('error'))
    else upstream.dispatchEvent(new Event('error'))
    const before = f.browser.snapshot()
    expect(f.completions[0].signal.aborted).toBe(true)
    expect(f.captures[0].aborted).toBe(true); expect(f.cleanup).toHaveBeenCalledOnce()
    f.translate(f.completions[0]); await settle()
    expect(f.browser.snapshot()).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires stalled ASR startup and ignores a late acknowledgement without leaving timers', async () => {
    const f = fixture(), rejected = expect(f.begin()).rejects.toThrow('暂不可用')
    await settle(); const upstream = f.upstreams[0]
    await vi.advanceTimersByTimeAsync(20_000); await rejected
    upstream.packet('task-started'); upstream.final('Must not return'); await settle()
    expect(f.captures).toHaveLength(0); expect(f.browser.snapshot().captions).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires an audio-idle connection without reconnecting or retaining timers', async () => {
    const f = fixture(); await f.start()
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.audioIdleMs)
    expect(f.frames().filter(frame => frame.type === 'error').map(frame => frame.type === 'error' ? frame.code : '')).toEqual(['unavailable'])
    expect(f.upstreams).toHaveLength(1); expect(f.cleanup).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })
})
