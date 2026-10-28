/** Size only the Web shell to the visible area. Pinch zoom keeps its existing layout. */
export function observeWebViewport(element: HTMLElement, view: Window = window): () => void {
  const viewport = view.visualViewport
  const keys = ['--web-viewport-height', '--web-viewport-top']
  const previous = keys.map(key => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)])
  const previousShort = element.dataset.viewportShort
  let frame: number | null = null
  let disposed = false
  const update = () => {
    frame = null
    if (disposed || !Number.isFinite(view.innerHeight) || view.innerHeight <= 0) return
    if (viewport && (!Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) > 0.01)) return
    const height = viewport?.height ?? view.innerHeight
    const offset = viewport?.offsetTop ?? 0
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(offset)) return
    const visible = Math.min(height, view.innerHeight)
    const top = Math.max(0, Math.min(offset, view.innerHeight - visible))
    element.style.setProperty(keys[0], `${visible}px`)
    element.style.setProperty(keys[1], `${top}px`)
    element.dataset.viewportShort = String(visible < 420)
  }
  const schedule = () => { if (frame === null) frame = view.requestAnimationFrame(update) }
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  view.addEventListener('resize', schedule)
  update()
  return () => {
    disposed = true
    if (frame !== null) view.cancelAnimationFrame(frame)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    view.removeEventListener('resize', schedule)
    for (const [key, value, priority] of previous) {
      if (value) element.style.setProperty(key, value, priority)
      else element.style.removeProperty(key)
    }
    if (previousShort === undefined) delete element.dataset.viewportShort
    else element.dataset.viewportShort = previousShort
  }
}
