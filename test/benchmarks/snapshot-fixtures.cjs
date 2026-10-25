// Synthetic Snapshot data shared by CPU proxies and the real Electron IPC harness.
// No profile, audio, user text, service connection, or key is read or generated.
const assert = require('node:assert/strict')

const sourceRef = 'c7d737bdfdb8592f8fae18eb64f3ef06712f620b'
const fixtureMetadata = Object.freeze({
  platform: 'synthetic', sourceRef, hasKeys: false, hasAudio: false,
  originalUnits: 96, translationUnits: 160,
  note: 'historyCount excludes the optional one live caption; all data is synthetic.',
})
const budgets = Object.freeze({
  reference: { historyCount: 150, targetCount: 3, partialHz: 20, includeLive: true },
  control: { historyCount: 0, targetCount: 1, partialHz: 5, includeLive: true },
  stress: { historyCount: 1150, targetCount: 8, partialHz: 60, includeLive: true },
  encodeP95Ms: 2,
  mainPublishPerPartialMs: 4,
  bridgeAckP95Ms: 50,
  terminalAckMs: 100,
  lostTerminalEvents: 0,
  drainAfterLastInputMs: 250,
  note: 'Engineering diagnostic budgets, not user SLOs, hardware guarantees or cross-machine CI gates.',
})
const partialRates = Object.freeze([5, 20, 60])
const serializationMatrix = [0, 150, 1150].flatMap(historyCount => [1, 3, 8].map(targetCount => ({ historyCount, targetCount, includeLive: true })))
const matrix = serializationMatrix.flatMap(row => partialRates.map(partialHz => ({ ...row, partialHz })))

function textOfUnits(prefix, units) {
  assert.ok(Number.isSafeInteger(units) && units >= prefix.length, 'Requested text is shorter than its synthetic prefix')
  const alphabet = Array.from(' 合成の学習𠮷 café。')
  let text = prefix, index = 0
  while (text.length < units) {
    const next = alphabet[index++ % alphabet.length]
    text += text.length + next.length <= units ? next : 'x'
  }
  return text
}

function targetsFor(count) {
  assert.ok([1, 3, 8].includes(count), 'targetCount must be 1, 3 or 8')
  return count === 1 ? ['en'] : ['zh', 'en', 'ja', 'fr', 'de', 'ko', 'es', 'ar'].slice(0, count)
}

function makeCaption(index, targets, options, live, saved) {
  const suffix = String(index).padStart(6, '0')
  const original = textOfUnits(live ? `Synthetic live r${String(options.revision).padStart(6, '0')} ` : `Synthetic history ${suffix} `, options.originalUnits)
  const translations = Object.fromEntries(targets.map(code => [code, textOfUnits(code === 'ja' ? `合成の学習 ${suffix} ` : `${code} synthetic ${suffix} `, options.translationUnits)]))
  const ja = translations.ja || ''
  const jaSegments = ja ? [{ text: '合成', reading: 'ごうせい' }, { text: 'の' }, { text: '学習', reading: 'がくしゅう' }, { text: ja.slice('合成の学習'.length) }] : undefined
  return {
    id: live ? 'synthetic-live' : `synthetic-history-${suffix}`,
    source: live ? 'system' : ['system', 'microphone', 'text'][index % 3],
    original, translatedOriginal: original, language: 'synthetic',
    zh: translations.zh || '', en: translations.en || '', ja,
    reading: jaSegments ? jaSegments.map(segment => segment.reading || segment.text).join('') : '',
    ...(jaSegments ? { jaSegments, furiganaStatus: 'ready' } : {}),
    translations, targetLanguages: [...targets], createdAt: 1700000000000 + index * 1000,
    status: 'ready', saved, live, translationPending: false,
  }
}

function makeSnapshot(input = {}) {
  const options = { historyCount: 150, targetCount: 3, includeLive: true, revision: 0, originalUnits: 96, translationUnits: 160, ...input }
  assert.ok(Number.isSafeInteger(options.historyCount) && options.historyCount >= 0 && options.historyCount <= 1150, 'historyCount must be 0..1150')
  assert.ok(Number.isSafeInteger(options.revision) && options.revision >= 0 && options.revision < 1000000, 'revision must be 0..999999')
  const savedCount = options.savedCount ?? Math.max(0, options.historyCount - 150)
  assert.ok(Number.isSafeInteger(savedCount) && savedCount >= 0 && savedCount <= Math.min(1000, options.historyCount), 'savedCount exceeds the history or storage limit')
  const targets = targetsFor(options.targetCount)
  const captions = Array.from({ length: options.historyCount }, (_, index) => makeCaption(index, targets, options, false, index < savedCount))
  if (options.includeLive) captions.push(makeCaption(options.historyCount, targets, options, true, false))
  const state = options.state || (options.includeLive ? 'listening' : 'idle')
  assert.ok(['idle', 'starting', 'listening', 'error'].includes(state), 'Unsupported synthetic listening state')
  return {
    settings: {
      targetLanguages: [...targets], showOriginal: true, showFurigana: targets.includes('ja'),
      captureMode: 'system', microphoneDeviceId: 'synthetic-default', alwaysOnTop: false,
      opacity: 0.94, fontSize: 16, launchAtLogin: false,
      asrModel: 'synthetic-asr-offline', asrEndpoint: 'wss://synthetic.invalid/asr',
      translationBaseUrl: 'https://synthetic.invalid', translationModel: 'synthetic-translation-offline',
      hasAsrKey: false, hasTranslationKey: false,
    },
    state, message: options.message || 'Synthetic offline benchmark; no capture or service access.',
    captions, partial: options.includeLive ? { system: captions.at(-1).original } : {}, collapsed: false,
  }
}

module.exports = { makeSnapshot, matrix, serializationMatrix, partialRates, budgets, fixtureMetadata, sourceRef }
