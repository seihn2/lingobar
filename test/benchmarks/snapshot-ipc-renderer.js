// Passive subscriber only: no React, DOM rendering, audio or provider requests.
let count = 0
window.lingo.onSnapshot(snapshot => {
  const tail = snapshot.captions.at(-1)
  window.__snapshotProbe.observed({ count: ++count, state: snapshot.state, message: snapshot.message,
    captionId: tail?.id || null, original: tail?.original || '', live: Boolean(tail?.live),
    captionCount: snapshot.captions.length, partial: snapshot.partial.system || '' })
})
void window.__snapshotProbe.ready()
