import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceReading, emptyReadingClock, initialReadingClock } from './reading-schedule.ts'

const options = { targets: ['en', 'ja'], showFurigana: true }
const caption = (id, extra = {}) => ({
  id, source: 'system', original: `Original ${id}`, language: 'en', zh: '', en: `Text ${id}`, ja: '文章',
  reading: '', createdAt: 0, saved: false, status: 'ready', ...extra,
})

test('default reading follows the latest available selected translation immediately', () => {
  const first = caption('first')
  const initial = advanceReading([first], emptyReadingClock(), options, 0)
  const next = advanceReading([first, caption('second')], initial.clock, options, 200)
  assert.equal(next.clock.id, 'second')
  assert.equal(next.wakeAt, null)
})

test('old annotation and live flags cannot hide a newer readable result', () => {
  const old = caption('old', { live: true, translationPending: true, furiganaStatus: 'pending' })
  const latest = caption('latest', { live: true, translationPending: true, translatedOriginal: 'First prefix' })
  const next = advanceReading([old, latest], { id: 'old', completedAt: null, signature: null }, options, 2000)
  assert.equal(next.clock.id, 'latest')
  assert.equal(next.wakeAt, null)
})

test('new raw recognition without translations preserves the most recent readable result', () => {
  const previous = caption('previous')
  const raw = caption('raw', { live: true, status: 'translating', en: '', ja: '' })
  let next = advanceReading([previous, raw], emptyReadingClock(), options, 0)
  assert.equal(next.clock.id, 'previous')
  next = advanceReading([previous, { ...raw, status: 'ready', en: 'New translated prefix' }], next.clock, options, 300)
  assert.equal(next.clock.id, 'raw')
})

test('empty history is safe and a first raw draft is visible while its translation arrives', () => {
  assert.deepEqual(advanceReading([], emptyReadingClock(), options, 0).clock, emptyReadingClock())
  const first = caption('first', { live: true, status: 'translating', en: '', ja: '' })
  assert.equal(advanceReading([first], emptyReadingClock(), options, 0).clock.id, 'first')
  assert.deepEqual(initialReadingClock([]), emptyReadingClock())
  assert.equal(initialReadingClock([caption('one'), caption('two')]).id, 'two')
})

test('out-of-order completion does not pull the view back from newer translated speech', () => {
  const old = caption('old', { en: '', ja: '', status: 'translating' })
  const latest = caption('latest', { live: true })
  const first = advanceReading([old, latest], emptyReadingClock(), options, 0)
  assert.equal(first.clock.id, 'latest')
  assert.equal(advanceReading([caption('old'), latest], first.clock, options, 1000).clock.id, 'latest')
})

test('continuous partials update the same active paragraph without starting a dwell timer', () => {
  let clock = emptyReadingClock()
  for (const now of [0, 1000, 2000, 30_000]) {
    const next = advanceReading([caption('live', { live: true, translationPending: true, en: `Revision ${now}` })], clock, options, now)
    assert.equal(next.clock.id, 'live')
    assert.equal(next.wakeAt, null)
    clock = next.clock
  }
  assert.equal(advanceReading([caption('live'), caption('next')], clock, options, 30_001).clock.id, 'next')
})

test('readability uses selected languages and final errors remain actionable', () => {
  const translatedOnlyToFrench = caption('french', { en: '', ja: '', translations: { fr: 'Bonjour' } })
  assert.equal(advanceReading([caption('previous'), translatedOnlyToFrench], emptyReadingClock(), options, 0).clock.id, 'previous')
  assert.equal(advanceReading([caption('previous'), { ...translatedOnlyToFrench, status: 'error' }], emptyReadingClock(), options, 0).clock.id, 'french')
})
