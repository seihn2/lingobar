import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ChevronLeft, ChevronRight, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Caption, Settings } from '../shared/types'
import { DEFAULT_LANGUAGES } from '../shared/languages'
import { compactRows, incomingText, survivingCaptionId, untranslatedErrorSource } from './caption-text'
import { advanceReading, initialReadingClock, type ReadingSession } from './reading-schedule'

type Props = {
  captions: Caption[]
  settings: Settings
  preview: boolean
  readingSession: ReadingSession
  partial: Array<{ source: 'system' | 'microphone'; text: string }>
  listening: boolean
  notice: string
  onRetry: (caption: Caption) => void
  onReturnLive?: () => void
  controls?: ReactNode
}

/** One readable paragraph, paired across languages, with a separate incoming audio line. */
export default function CompactCaption({ captions, settings, preview, readingSession, partial, listening, notice, onRetry, onReturnLive, controls }: Props) {
  const dragEdge = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const retained = useRef(captions)
  const clock = useRef(readingSession.clock || initialReadingClock(captions, preview))
  const followRef = useRef(readingSession.following)
  const [following, setFollowing] = useState(readingSession.following)
  const [cursorId, setCursorId] = useState(readingSession.following ? clock.current.id : readingSession.anchor?.id || clock.current.id)
  const [tick, setTick] = useState(0)
  const targets = settings.targetLanguages || DEFAULT_LANGUAGES
  // Keep a bounded neighborhood if the reader lags behind the main history limit.
  const updates = new Map(captions.map(caption => [caption.id, caption]))
  const visibleCursorId = survivingCaptionId(retained.current, captions, cursorId)
  const clockId = survivingCaptionId(retained.current, captions, clock.current.id)
  if (clockId !== clock.current.id) { clock.current = { id: clockId, completedAt: null, signature: null }; readingSession.clock = clock.current }
  if (visibleCursorId !== cursorId) readingSession.anchor = visibleCursorId ? { id: visibleCursorId, offset: 10 } : null
  const oldIds = new Set(retained.current.map(caption => caption.id))
  const merged = retained.current.map(caption => updates.get(caption.id) || caption).concat(captions.filter(caption => !oldIds.has(caption.id)))
  const position = Math.max(0, merged.findIndex(caption => caption.id === visibleCursorId))
  retained.current = merged.filter((caption, index) => updates.has(caption.id) || (!caption.live && index >= position - 30 && index < position + 120))
  const visible = retained.current
  const index = visible.findIndex(caption => caption.id === visibleCursorId)
  const caption = visible[index] || visible[0]
  const rows = compactRows(caption, targets)
  const missing = Boolean(caption && rows.slice(1).some(row => !row.text))
  const annotationPending = settings.showFurigana && targets.includes('ja') && caption?.furiganaStatus === 'pending'
  const incoming = partial.map(item => ({ ...item, text: incomingText(item.text, item.source === caption?.source ? caption : undefined) })).filter(item => item.text)
  const untranslated = untranslatedErrorSource(caption)

  useLayoutEffect(() => {
    if (visibleCursorId !== cursorId) setCursorId(visibleCursorId)
    if (!captions.length || !followRef.current) return
    if (!readingSession.clock) clock.current = initialReadingClock(captions, preview)
    const now = performance.now()
    const next = advanceReading(retained.current, clock.current, { targets, showFurigana: settings.showFurigana }, now)
    clock.current = next.clock
    readingSession.clock = next.clock
    setCursorId(next.clock.id)
    if (next.wakeAt === null) return
    const timer = window.setTimeout(() => setTick(value => value + 1), Math.max(1, next.wakeAt - now))
    return () => window.clearTimeout(timer)
  }, [captions, following, tick, settings.targetLanguages, settings.showFurigana, preview, readingSession, visibleCursorId, cursorId])

  useLayoutEffect(() => { if (viewport.current) viewport.current.scrollTop = 0 }, [caption?.id])

  useLayoutEffect(() => {
    let frame = 0
    let lastHeight = 0
    const measure = () => {
      frame = 0
      if (!content.current || !dragEdge.current || !viewport.current?.parentElement) return
      // Measure the intrinsic inner content, never the flex viewport stretched by the window.
      const frameStyle = getComputedStyle(viewport.current.parentElement)
      const height = Math.ceil(content.current.getBoundingClientRect().height + dragEdge.current.getBoundingClientRect().height + parseFloat(frameStyle.paddingTop) + parseFloat(frameStyle.paddingBottom) + 2)
      if (height === lastHeight) return
      lastHeight = height
      void window.lingo?.setCompactHeight(height).catch(() => {})
    }
    const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(measure) })
    if (content.current) observer.observe(content.current)
    measure()
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame) }
  }, [])

  const pause = () => {
    followRef.current = false
    readingSession.following = false
    if (caption) readingSession.anchor = { id: caption.id, offset: 10 }
    setFollowing(false)
  }
  const navigate = (direction: -1 | 1) => {
    const next = visible[index + direction]
    if (!next) return
    pause()
    readingSession.anchor = { id: next.id, offset: 10 }
    setCursorId(next.id)
  }
  const resume = () => {
    retained.current = captions
    clock.current = initialReadingClock(captions)
    readingSession.clock = clock.current
    readingSession.following = true
    readingSession.anchor = null
    followRef.current = true
    setCursorId(clock.current.id)
    setFollowing(true)
    setTick(value => value + 1)
    onReturnLive?.()
  }

  return <section className="compact-caption" aria-label="小窗多语对照">
    <div ref={dragEdge} className="compact-drag-edge" aria-hidden="true" title="拖动悬浮窗" />
    <div ref={viewport} className="compact-viewport" tabIndex={0} aria-label="原文与所选语言，滚动回看后可返回实时" onPointerDown={event => { const surface = event.currentTarget; const gutter = surface.offsetWidth - surface.clientWidth; if (event.target === surface && gutter > 0 && event.clientX >= surface.getBoundingClientRect().right - gutter) pause() }} onWheel={event => { if (event.deltaY) pause() }} onPointerUp={event => { const selection = window.getSelection(); if (selection && !selection.isCollapsed && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) pause() }} onKeyDown={event => {
      const spaceScroll = event.key === ' ' && event.target === event.currentTarget && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.defaultPrevented
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key) || spaceScroll) pause()
    }}>
      <div ref={content} className="compact-content">
        <div className="compact-rows" data-caption-id={caption?.id}>
          {rows.map((row, rowIndex) => {
            const segments = row.code === 'ja' && settings.showFurigana && caption?.jaSegments?.map(segment => segment.text).join('') === row.text ? caption.jaSegments : undefined
            const hasRuby = segments?.some(segment => segment.reading)
            const placeholder = rowIndex === 0 ? listening ? '正在聆听…' : '开始聆听后显示原文' : !caption ? '等待原文' : caption.status === 'translating' || caption.translationPending ? '正在翻译…' : caption.status === 'error' ? '翻译暂未完成' : '未生成'
            return <div key={row.code} className={`compact-row ${rowIndex === 0 ? 'compact-original' : ''} ${rowIndex === 1 ? 'compact-primary' : ''} ${hasRuby ? 'compact-ruby' : ''}`} data-language={row.code}>
              <span className="compact-language" title={row.label} aria-label={row.label}>{row.code === 'original' ? '原' : row.code === 'zh' ? '中' : row.code === 'zh-Hant' ? '繁' : row.code === 'ja' ? '日' : row.code.toUpperCase()}</span>
              <p lang={row.lang} dir="auto" className={!row.text ? 'compact-placeholder' : ''}>{segments ? segments.map((segment, i) => segment.reading ? <ruby key={i}>{segment.text}<rp>(</rp><rt>{segment.reading}</rt><rp>)</rp></ruby> : <span key={i}>{segment.text}</span>) : row.text || placeholder}</p>
            </div>
          })}
        </div>
        {incoming.length > 0 && <div className="compact-partial" aria-label="正在收音的新内容"><span className="partial-indicator" /><span><b>正在收音</b>{incoming.map(item => `${incoming.length > 1 ? item.source === 'system' ? '电脑：' : '麦克风：' : ''}${item.text}`).join(' · ')}</span></div>}
        {untranslated && <p className="compact-notice" aria-label={untranslated.label}>{untranslated.label}：{untranslated.text}</p>}
        {(annotationPending || caption?.status === 'error' || (settings.showFurigana && targets.includes('ja') && caption?.furiganaStatus === 'error')) && <p className="compact-transient" role="status">{annotationPending ? <><LoaderCircle size={9} className="spin" />注音中</> : caption?.status === 'error' ? '本段翻译未完成，可重试' : '注音暂未完成'}</p>}
        {notice && <p className="compact-notice" role="alert">{notice}</p>}
        {!following && <div className="compact-review"><span>回看</span><button type="button" onClick={resume}><ArrowDown size={10} />返回实时</button></div>}
      </div>
    </div>
    <div className="compact-controls" role="group" aria-label="小窗控制，悬停或键盘聚焦时显示">
      <div className="compact-navigation">
        {caption && (caption.status === 'error' || missing || caption.furiganaStatus === 'error') && caption.status !== 'translating' && !caption.live && !caption.translationPending && <button type="button" className="compact-retry" aria-label="重新翻译这段" title="按当前语言重新翻译这段" disabled={preview || !updates.has(caption.id)} onClick={() => onRetry(caption)}><RotateCcw size={11} /></button>}
        <button type="button" title="上一段" aria-label="上一段" disabled={index <= 0} onClick={() => navigate(-1)}><ChevronLeft size={13} /></button>
        <button type="button" title="下一段" aria-label="下一段" disabled={index < 0 || index >= visible.length - 1} onClick={() => navigate(1)}><ChevronRight size={13} /></button>
        <button type="button" className="compact-live" title={following ? '正在跟随；跳到最新一段' : '回到实时'} aria-label="回到实时" onClick={resume} disabled={!captions.length}><ArrowDown size={12} /></button>
      </div>
      {controls}
    </div>
  </section>
}
