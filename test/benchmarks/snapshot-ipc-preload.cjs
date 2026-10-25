// The runner appends the exact production preload to this ephemeral entrypoint.
const { contextBridge: snapshotProbeBridge, ipcRenderer: snapshotProbeIpc } = require('electron')
let ordinal = 0
const observed = new Map()
snapshotProbeIpc.on('lingo:changed', () => {
  const current = ++ordinal
  snapshotProbeIpc.send('snapshot-bench:ack', { kind: 'raw', ordinal: current })
  queueMicrotask(() => {
    const summary = observed.get(current)
    observed.delete(current)
    snapshotProbeIpc.send('snapshot-bench:ack', { kind: 'bridge', ordinal: current, observed: Boolean(summary), summary })
  })
})
snapshotProbeBridge.exposeInMainWorld('__snapshotProbe', {
  // One tiny scalar-summary crossing after the sole production bridge callback.
  observed(summary) { if (observed.has(ordinal)) throw new Error('Duplicate production bridge callback'); observed.set(ordinal, summary) },
  ready() { return snapshotProbeIpc.invoke('snapshot-bench:ready') }
})
