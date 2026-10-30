/** Official price verified 2026-10-30, but billing minimum/rounding on aborted
 * realtime sessions is NOT documented. Never enable by an environment flag.
 * A reviewed evidence/code update is required before real-provider admission. */
export const AUDIO_POLICY = Object.freeze({
  verified: false,
  model: 'qwen3-asr-flash-realtime',
  maxAudioBytes: 320_000, // 10 seconds, mono signed PCM16, 16 kHz
  maxSessionMs: 30_000,
  // Nominal quote only, NOT a certified upper bound while verified is false.
  asrReservationMicroCny: 3300,
  batch: 'lingobar-audio-test-2026-10-30',
  limitMicroCny: 1_000_000
})
