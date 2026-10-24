// Captures the production main entrypoint's actual AudioCallbacks. No device/client.
exports.AudioEngine = class {
  constructor(callbacks) { this.callbacks = callbacks; globalThis.__snapshotAudioCallbacks = callbacks }
  start() { throw new Error('Audio startup is disabled in this benchmark') }
  pushMicrophone() { throw new Error('PCM is disabled in this benchmark') }
  stop() { this.callbacks.onState('idle', '已暂停') }
}
