import { describe, expect, it } from 'vitest'
import { observeWebViewport } from '../src/web/viewport'

class Viewport extends EventTarget { height = 844; offsetTop = 0; scale = 1 }
class View extends EventTarget {
  innerHeight = 844
  visualViewport: Viewport | null = new Viewport()
  frames = new Map<number, FrameRequestCallback>()
  cancelled: number[] = []
  next = 0
  requestAnimationFrame(callback: FrameRequestCallback) { const id = ++this.next; this.frames.set(id, callback); return id }
  cancelAnimationFrame(id: number) { this.cancelled.push(id); this.frames.delete(id) }
  flush() { const pending = [...this.frames.values()]; this.frames.clear(); for (const callback of pending) callback(0) }
}
function fixture(view = new View()) {
  const properties = new Map<string, [string, string]>()
  const element = { dataset: {} as Record<string, string>, style: {
    getPropertyValue: (key: string) => properties.get(key)?.[0] || '',
    getPropertyPriority: (key: string) => properties.get(key)?.[1] || '',
    setProperty: (key: string, value: string, priority = '') => { properties.set(key, [value, priority]) },
    removeProperty: (key: string) => { properties.delete(key); return '' }
  } }
  const observe = () => observeWebViewport(element as unknown as HTMLElement, view as unknown as Window)
  const height = () => element.style.getPropertyValue('--web-viewport-height')
  const top = () => element.style.getPropertyValue('--web-viewport-top')
  return { view, element, properties, observe, height, top }
}
describe('Web-only visible viewport ownership', () => {
  it('keeps the shell inside a keyboard-shrunken and vertically panned visible area', () => {
    const f = fixture(), off = f.observe(), vv = f.view.visualViewport!
    expect(f.height()).toBe('844px')
    vv.height = 320; vv.offsetTop = 120; vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll'))
    expect(f.view.frames.size).toBe(1); f.view.flush()
    expect([f.height(), f.top(), f.element.dataset.viewportShort]).toEqual(['320px', '120px', 'true'])
    off()
  })
  it('restores the full area after keyboard dismissal and handles orientation resize', () => {
    const f = fixture(), off = f.observe(), vv = f.view.visualViewport!
    vv.height = 300; vv.dispatchEvent(new Event('resize')); f.view.flush()
    vv.height = 844; vv.offsetTop = 0; vv.dispatchEvent(new Event('resize')); f.view.flush()
    expect([f.height(), f.element.dataset.viewportShort]).toEqual(['844px', 'false'])
    f.view.innerHeight = 390; vv.height = 390; f.view.dispatchEvent(new Event('resize')); f.view.flush()
    expect([f.height(), f.top(), f.element.dataset.viewportShort]).toEqual(['390px', '0px', 'true']); off()
  })
  it('keeps the layout stable during pinch zoom, then resynchronizes on zoom reset', () => {
    const f = fixture(), off = f.observe(), vv = f.view.visualViewport!
    vv.scale = 2; vv.height = 400; vv.offsetTop = 80; vv.dispatchEvent(new Event('resize')); f.view.flush()
    expect([f.height(), f.top()]).toEqual(['844px', '0px'])
    vv.scale = 1; vv.height = 700; vv.dispatchEvent(new Event('resize')); f.view.flush()
    expect([f.height(), f.top()]).toEqual(['700px', '80px']); off()
  })
  it('falls back to window height when VisualViewport is absent', () => {
    const view = new View(); view.visualViewport = null
    const f = fixture(view), off = f.observe(); view.innerHeight = 480; view.dispatchEvent(new Event('resize')); view.flush()
    expect([f.height(), f.top()]).toEqual(['480px', '0px']); off()
  })
  it.each([0, -1, NaN, Infinity])('ignores transient invalid visible heights (%s) instead of collapsing the page', value => {
    const f = fixture(), off = f.observe(); f.view.visualViewport!.height = value; f.view.visualViewport!.dispatchEvent(new Event('resize')); f.view.flush()
    expect(f.height()).toBe('844px'); off()
  })
  it('bounds stale or overscrolled offsets to the current layout extent', () => {
    const f = fixture(), off = f.observe(), vv = f.view.visualViewport!
    vv.height = 300; vv.offsetTop = 900; vv.dispatchEvent(new Event('scroll')); f.view.flush()
    expect(f.top()).toBe('544px')
    vv.offsetTop = -20; vv.dispatchEvent(new Event('scroll')); f.view.flush(); expect(f.top()).toBe('0px')
    vv.height = 900; vv.dispatchEvent(new Event('resize')); f.view.flush(); expect(f.height()).toBe('844px'); off()
  })
  it('cleans up listeners and queued frames, restoring pre-existing styles without late writes', () => {
    const f = fixture()
    f.element.style.setProperty('--web-viewport-height', '90%', 'important'); f.element.dataset.viewportShort = 'prior'
    const off = f.observe(); f.view.dispatchEvent(new Event('resize'))
    const late = [...f.view.frames.values()][0]; off(); late(0)
    f.view.visualViewport!.dispatchEvent(new Event('scroll')); f.view.dispatchEvent(new Event('resize'))
    expect(f.view.frames.size).toBe(0); expect(f.view.cancelled).toHaveLength(1)
    expect(f.properties.get('--web-viewport-height')).toEqual(['90%', 'important'])
    expect(f.top()).toBe(''); expect(f.element.dataset.viewportShort).toBe('prior')
  })
})
