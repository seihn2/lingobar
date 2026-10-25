import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import type { CaptionQueue } from '../../src/main/captions'
import type { Caption } from '../../src/shared/types'
import type { CaptionTranslation, TranslationConfig } from '../../src/main/translation'
import { fixtures, models, type Fixture, type FixtureEvent } from './fixtures'

const manifestPath = process.env.LINGOBAR_CAPTION_BENCHMARK_MANIFEST
if (!manifestPath) throw new Error('Run node scripts/benchmark-captions.cjs to build the pinned benchmark modules first.')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  baselineRef: string; captionSourceSha256: string;
  variants: Array<{ id: string; label: string; modulePath: string }>
}
const require = createRequire(import.meta.url)
const constructors = new Map(manifest.variants.map(variant => [variant.id, require(variant.modulePath).CaptionQueue as typeof CaptionQueue]))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

interface Request {
  at: number; durationMs: number; completedAt: number | null; abortedAt: number | null;
  sourceUtf16: number; sourceUtf8Bytes: number; sourceSha256: string;
  focus: boolean; partial: boolean; revision: number; targets: string[]; role: string;
}
interface Job { caption: Caption; original: string; revision: number; config: TranslationConfig; queuedAt: number }
interface Internals { waiting: Job[]; running: Map<string, Job>; work: Map<string, { revision: number }> }
interface Row {
  model: string; scenario: string; variant: string;
  draftRequests: number; liveFinalRequests: number; liveRequests: number; allRequests: number;
  sourceUtf16: number; sourceUtf8Bytes: number; firstAnyMs: number | null; firstFreshMs: number | null;
  firstPublishedAnyLanguageMs: number | null; providerCalls: number;
  lastPartialFreshMs: number | null; finalMs: number | null; maxActive: number; maxWaiting: number; maxRunning: number;
  idleActive: number; idleWaiting: number; idleRunning: number; idleTimers: number; sourcePairing: boolean;
  duplicateRevisionRequests: number; snapshotChecks: number; finalHistoryStartedAt: number | null;
  cleanupAtClose: { active: number; waiting: number; running: number; timers: number } | null;
  cleanupAfterCloseMicrotasks: { active: number; waiting: number; running: number; timers: number } | null;
  requests: Request[]; publications: Array<{ at: number; sourceSha256: string; latestHeardSha256: string; selectedReadable: boolean; fresh: boolean }>
}
const results: Row[] = []

async function simulate(fixture: Fixture, model: typeof models[number]['id'], variant: typeof manifest.variants[number]): Promise<Row> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(0)
  // A regression in this harness must fail before it can contact any provider.
  let providerCalls = 0
  vi.stubGlobal('fetch', () => { providerCalls++; throw new Error('Network is forbidden in the caption benchmark') })
  let queue!: CaptionQueue
  let active = 0, maxActive = 0, maxWaiting = 0, maxRunning = 0, snapshotChecks = 0
  let focusId: string | null = null, heard = '', closed = false, changes = 0, changesAtClose = -1
  let firstAnyMs: number | null = null, firstFreshMs: number | null = null, lastPartialFreshMs: number | null = null, finalMs: number | null = null
  let firstPublishedAnyLanguageMs: number | null = null
  let cleanupAtClose: Row['cleanupAtClose'] = null
  let cleanupAfterCloseMicrotasks: Row['cleanupAfterCloseMicrotasks'] = null
  const requests: Request[] = [], publications: Row['publications'] = []
  const dispatches: Array<{ revision: number }> = []
  const published = new Map<string, string>()
  const blockerDurations = new Map(fixture.events.filter(event => event.op === 'blocker').map(event => [event.name, event.duration]))
  const partialEvents = fixture.events.filter((event): event is Extract<FixtureEvent, { op: 'partial' }> => event.op === 'partial' && Boolean(event.focus))
  const lastPartialText = partialEvents.at(-1)?.text.trim()
  const finalText = fixture.events.find(event => event.op === 'final')?.text.trim()
  let config: TranslationConfig = { baseUrl: 'https://offline.example.invalid/v1', model: 'offline-initial', apiKey: 'synthetic-fixture-key', targetLanguages: [...fixture.targets], generateFurigana: false }
  const internals = () => queue as unknown as Internals
  const sample = () => {
    maxActive = Math.max(maxActive, active)
    maxWaiting = Math.max(maxWaiting, internals().waiting.length)
    maxRunning = Math.max(maxRunning, internals().running.size)
  }
  const resources = () => ({ active, waiting: internals().waiting.length, running: internals().running.size, timers: vi.getTimerCount() })
  const observe = () => {
    changes++
    sample()
    for (const caption of queue.captions) {
      if (!caption.translatedOriginal) continue
      for (const [code, text] of Object.entries(caption.translations || {})) {
        expect(text).toBe(`${code}: ${caption.translatedOriginal}`)
      }
    }
    const focus = queue.captions.find(caption => caption.id === focusId)
    if (!focus?.translatedOriginal) return
    firstPublishedAnyLanguageMs ??= Date.now()
    const selectedReadable = config.targetLanguages!.some(code => Boolean(focus.translations?.[code]))
    if (selectedReadable) {
      firstAnyMs ??= Date.now()
      if (focus.translatedOriginal === heard) firstFreshMs ??= Date.now()
      if (focus.translatedOriginal === lastPartialText) lastPartialFreshMs ??= Date.now()
      if (!focus.live && focus.translatedOriginal === finalText) finalMs ??= Date.now()
    }
    if (published.get(focus.id) !== focus.translatedOriginal) {
      published.set(focus.id, focus.translatedOriginal)
      publications.push({ at: Date.now(), sourceSha256: hash(focus.translatedOriginal), latestHeardSha256: hash(heard), selectedReadable, fresh: selectedReadable && focus.translatedOriginal === heard })
    }
  }
  const trace = (event: string, fields: Record<string, unknown>) => {
    sample()
    if (event === 'translation.start') dispatches.push({ revision: Number(fields.revision) })
  }
  ;(globalThis as unknown as { __captionBenchmarkTrace: typeof trace }).__captionBenchmarkTrace = trace
  const translator = (text: string, options: TranslationConfig, signal?: AbortSignal): Promise<CaptionTranslation> => {
    const dispatch = dispatches.shift()
    expect(dispatch).toBeDefined()
    if (signal?.aborted) return Promise.reject(new Error('Synthetic cancelled before service dispatch'))
    const targets = [...options.targetLanguages!]
    const role = blockerDurations.has(text) ? text : text.startsWith('Live focus:') ? 'focus' : text.startsWith('History ') ? 'history' : 'auxiliary'
    if (fixture.id === 'configuration-snapshot' && role === 'focus' && !requests.some(request => request.focus)) {
      expect(options).toMatchObject({ baseUrl: 'https://offline.example.invalid/v1', model: 'offline-initial', targetLanguages: ['en'] })
    }
    const durationMs = blockerDurations.get(text) ?? (model === 'fixed' ? fixture.fixedServiceMs : 180 + 4 * text.length + 15 * targets.length)
    const request: Request = { at: Date.now(), durationMs, completedAt: null, abortedAt: null,
      sourceUtf16: text.length, sourceUtf8Bytes: Buffer.byteLength(text, 'utf8'), sourceSha256: hash(text),
      focus: role === 'focus', partial: Boolean(options.partial), revision: dispatch!.revision, targets, role }
    requests.push(request); active++; sample()
    return new Promise((resolve, reject) => {
      let settled = false
      const complete = () => {
        if (settled) return
        settled = true; active--; sample()
        signal?.removeEventListener('abort', abort)
        request.completedAt = Date.now()
        const translations = Object.fromEntries(targets.map(code => [code, `${code}: ${text}`]))
        resolve({ language: 'synthetic', translations, zh: translations.zh || '', en: translations.en || '', ja: translations.ja || '', reading: '' })
      }
      const timer = setTimeout(complete, durationMs)
      const abort = () => {
        request.abortedAt ??= Date.now()
        if (settled || fixture.ignoreAbort) return
        settled = true; clearTimeout(timer); active--; sample()
        signal?.removeEventListener('abort', abort)
        reject(new Error('Synthetic cooperative cancellation'))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  queue = new (constructors.get(variant.id)!)([], () => config, observe, () => {}, translator)
  try {
    const events = fixture.events.map((event, index) => ({ ...event, index })).sort((a, b) => a.at - b.at || a.index - b.index)
    for (const event of events) {
      await vi.advanceTimersByTimeAsync(event.at - Date.now())
      if (event.op === 'blocker') queue.add(event.name, 'text')
      if (event.op === 'history') queue.add(event.text, 'text')
      if (event.op === 'config') config = { ...config, targetLanguages: [...event.targets] }
      if (event.op === 'partial') {
        const old = internals().waiting.find(job => job.caption.id === focusId && job.config.partial)
        const snapshot = old ? { original: old.original, revision: old.revision, config: old.config, queuedAt: old.queuedAt, position: internals().waiting.indexOf(old) } : null
        const untouched = [...internals().running.values(), ...internals().waiting.filter(job => job !== old)].map(job => ({ job, original: job.original, revision: job.revision, config: job.config, queuedAt: job.queuedAt }))
        if (event.focus) heard = event.text.trim()
        queue.updatePartial(event.text, event.source || 'system', event.utterance || 'focus')
        if (event.focus && !focusId) focusId = queue.captions.find(caption => caption.source === 'system' && caption.original === heard)!.id
        if (event.focus && old && snapshot) {
          snapshotChecks++
          expect(old.config).toBe(snapshot.config)
          expect(old.queuedAt).toBe(snapshot.queuedAt)
          expect(internals().waiting.indexOf(old)).toBe(snapshot.position)
          for (const original of untouched) {
            expect(original.job).toMatchObject({ original: original.original, revision: original.revision, queuedAt: original.queuedAt })
            expect(original.job.config).toBe(original.config)
          }
          if (variant.id === 'baseline') expect(old).toMatchObject({ original: snapshot.original, revision: snapshot.revision })
          else expect(old).toMatchObject({ original: heard, revision: internals().work.get(focusId!)!.revision })
        }
      }
      if (event.op === 'final') {
        heard = event.text.trim()
        queue.finishSentence(event.text, 'system', 'focus')
        queue.finishPartials()
      }
      if (event.op === 'close') {
        queue.close(); closed = true; changesAtClose = changes
        cleanupAtClose = resources()
        await vi.advanceTimersByTimeAsync(0)
        cleanupAfterCloseMicrotasks = resources()
      }
      observeIfOpen()
    }
    await vi.advanceTimersByTimeAsync(fixture.horizon - Date.now())
    sample()
    const idle = resources()
    expect(idle).toEqual({ active: 0, waiting: 0, running: 0, timers: 0 })
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxRunning).toBeLessThanOrEqual(2)
    expect(maxWaiting).toBeLessThanOrEqual(20)
    expect(providerCalls).toBe(0)
    if (closed) expect(changes).toBe(changesAtClose)
    else expect(finalMs).not.toBeNull()
    if (fixture.checkSnapshot) expect(snapshotChecks).toBeGreaterThan(0)
    const focusRequests = requests.filter(request => request.focus)
    if (fixture.id === 'configuration-snapshot') expect(focusRequests[0].targets).toEqual(['en'])
    const history = requests.find(request => request.role === 'history')
    if (fixture.fairnessAt !== undefined) {
      expect(history?.at).toBe(fixture.fairnessAt)
      expect(history!.at).toBeLessThanOrEqual(requests.find(request => request.role === 'auxiliary')!.at)
    }
    if (fixture.id === 'cancel-cooperative') {
      expect(cleanupAtClose).toMatchObject({ active: 0, waiting: 0, timers: 0 })
      expect(cleanupAfterCloseMicrotasks).toEqual({ active: 0, waiting: 0, running: 0, timers: 0 })
    }
    const seen = new Set<string>()
    let duplicates = 0
    for (const request of focusRequests) {
      const key = `${request.revision}:${request.partial}`
      if (seen.has(key)) duplicates++
      seen.add(key)
    }
    return {
      model, scenario: fixture.id, variant: variant.id,
      draftRequests: focusRequests.filter(request => request.partial).length,
      liveFinalRequests: focusRequests.filter(request => !request.partial).length,
      liveRequests: focusRequests.length, allRequests: requests.length,
      sourceUtf16: focusRequests.reduce((total, request) => total + request.sourceUtf16, 0),
      sourceUtf8Bytes: focusRequests.reduce((total, request) => total + request.sourceUtf8Bytes, 0),
      firstAnyMs, firstFreshMs, firstPublishedAnyLanguageMs, providerCalls, lastPartialFreshMs, finalMs, maxActive, maxWaiting, maxRunning,
      idleActive: idle.active, idleWaiting: idle.waiting, idleRunning: idle.running, idleTimers: idle.timers,
      sourcePairing: true, duplicateRevisionRequests: duplicates, snapshotChecks,
      finalHistoryStartedAt: history?.at ?? null, cleanupAtClose, cleanupAfterCloseMicrotasks, requests, publications,
    }
  } finally {
    queue.close()
    delete (globalThis as unknown as { __captionBenchmarkTrace?: typeof trace }).__captionBenchmarkTrace
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
  }
  function observeIfOpen() { if (!closed) observe() }
}

for (const model of models) for (const fixture of fixtures) {
  it(`${model.id}: ${fixture.id}`, async () => {
    const comparison = []
    for (const variant of manifest.variants) comparison.push(await simulate(fixture, model.id, variant))
    if (fixture.control) {
      const comparable = (row: Row) => { const { variant: _variant, ...rest } = row; return rest }
      expect(comparable(comparison[1])).toEqual(comparable(comparison[0]))
      expect(comparable(comparison[2])).toEqual(comparable(comparison[0]))
    }
    results.push(...comparison)
  })
}

afterAll(() => {
  writeFileSync(join(dirname(manifestPath), 'results.json'), JSON.stringify({
    baselineRef: manifest.baselineRef, captionSourceSha256: manifest.captionSourceSha256,
    models, fixtures: fixtures.map(fixture => ({ ...fixture })), results,
  }, null, 2) + '\n')
})
