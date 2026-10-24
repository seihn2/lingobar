// Appended to the exact git main/index.ts in an ephemeral esbuild input.
// These hooks neither replace nor copy snapshot/publish/onPartial implementations.
const snapshotBenchOriginalSnapshot = snapshot
snapshot = function () {
  const before = performance.now()
  try { return snapshotBenchOriginalSnapshot() }
  finally {
    const measurement = globalThis.__snapshotMeasurement
    if (measurement?.phase === 'partial') measurement.snapshotBuildMs.push(performance.now() - before)
  }
}
globalThis.__snapshotBenchHooks = {
  ready: () => Boolean(window && storage && queue && globalThis.__snapshotAudioCallbacks),
  window: () => window,
  snapshot: () => snapshot(),
  reset(value) {
    queue.close()
    const { hasAsrKey: _a, hasTranslationKey: _t, ...preferences } = value.settings
    storage.save(preferences) // No keys; disk work is outside all timed samples.
    queue = new CaptionQueue(structuredClone(value.captions), () => {
      const settings = storage.settings()
      return { baseUrl: settings.translationBaseUrl, model: settings.translationModel, apiKey: '',
        targetLanguages: [...settings.targetLanguages], generateFurigana: false }
    }, publish, () => {})
    partial = {}; partialIds = {}; state = value.state; message = value.message; collapsed = false
  },
  partial(text, id) { globalThis.__snapshotAudioCallbacks.onPartial('system', text, id) },
  final(text, id) { globalThis.__snapshotAudioCallbacks.onSentence('system', text, id) },
  status(value, detail) { globalThis.__snapshotAudioCallbacks.onState(value, detail) },
  error(detail) { globalThis.__snapshotAudioCallbacks.onError(detail) },
  close() { queue.close() }
}
