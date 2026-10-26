import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Bookmark, Check, Copy, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Caption, Settings } from '../shared/types'
import { annotationText } from '../shared/annotation-protocol'
import { DEFAULT_LANGUAGES, languageInfo } from '../shared/languages'
import { alignedOriginal, survivingCaptionId, translationFor, untranslatedErrorSource } from './caption-text'
import { advanceReading, initialReadingClock, type ReadingSession } from './reading-schedule'

type Props = {
  captions: Caption[]
  settings: Settings
  preview: boolean
  focusId: string | null
  focusVersion: number
  copiedId: string | null
  onCopy: (caption: Caption) => void
  onSave: (caption: Caption) => void
  onRetry: (caption: Caption) => void
  onRetryAnnotation?: (caption: Caption) => void
  onReturnLive: () => void
  readingSession: ReadingSession
  allowRemoveSaved?: boolean
}
type Anchor = { id: string; offset: number }
const sourceNames = { system: '电脑声音', microphone: '麦克风', text: '文字输入' }

/** A translation fills its existing card; only new source segments append cards. */
export default function CaptionStream({ captions, settings, preview, focusId, focusVersion, copiedId, onCopy, onSave, onRetry, onRetryAnnotation, onReturnLive, readingSession, allowRemoveSaved = false }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const annotationFocus = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    const button = annotationFocus.current
    if (button && (!button.isConnected || button.disabled)) {
      annotationFocus.current = null
      if (document.activeElement === document.body && viewport.current?.getClientRects().length) viewport.current.focus()
    }
  })
  const followRef = useRef(readingSession.following)
  const anchor = useRef<Anchor | null>(readingSession.anchor)
  const fingerprints = useRef(new Map<string, string>())
  const unseen = useRef(new Set<string>())
  const lastFocus = useRef(-1)
  const retained = useRef<Caption[]>(captions)
  const readingClock = useRef(readingSession.clock || initialReadingClock(captions, preview))
  const releaseRetained = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [following, setFollowing] = useState(readingSession.following)
  const [cursorId, setCursorId] = useState<string | null>(readingClock.current.id)
  const [clockTick, setClockTick] = useState(0)
  const [unseenCount, setUnseenCount] = useState(0)
  const targets = settings.targetLanguages || DEFAULT_LANGUAGES
  const activeIds = new Set(captions.map(caption => caption.id))
  const clockId = survivingCaptionId(retained.current, captions, readingClock.current.id)
  if (clockId !== readingClock.current.id) { readingClock.current = { id: clockId, completedAt: null, signature: null }; readingSession.clock = readingClock.current }
  const anchorId = survivingCaptionId(retained.current, captions, anchor.current?.id || null)
  if (anchorId !== anchor.current?.id) { anchor.current = anchorId ? { id: anchorId, offset: 10 } : null; readingSession.anchor = anchor.current }
  if (releaseRetained.current) { retained.current = captions; releaseRetained.current = false }
  else {
    const updates = new Map(captions.map(caption => [caption.id, caption]))
    const previousIds = new Set(retained.current.map(caption => caption.id))
    const merged = retained.current.map(caption => updates.get(caption.id) || caption).concat(captions.filter(caption => !previousIds.has(caption.id)))
    const protectedId = followRef.current ? readingClock.current.id : anchor.current?.id
    const readingIndex = Math.max(0, merged.findIndex(caption => caption.id === protectedId))
    const protectedIds = new Set(merged.slice(Math.max(0, readingIndex - 40), readingIndex + 110).map(caption => caption.id))
    retained.current = merged.filter(caption => activeIds.has(caption.id) || (!caption.live && protectedIds.has(caption.id)))
  }
  const visibleCaptions = retained.current
  const cursorIndex = visibleCaptions.findIndex(caption => caption.id === cursorId)
  const unreadCount = cursorIndex >= 0 ? visibleCaptions.length - cursorIndex - 1 : 0
  const currentReading = visibleCaptions[cursorIndex]

  const rememberAnchor = useCallback(() => {
    const surface = viewport.current
    if (!surface) return
    const top = surface.getBoundingClientRect().top
    const first = [...surface.querySelectorAll<HTMLElement>('[data-caption-id]')].find(card => card.getBoundingClientRect().bottom > top + 1)
    anchor.current = first ? { id: first.dataset.captionId!, offset: first.getBoundingClientRect().top - top } : null
    readingSession.anchor = anchor.current
  }, [readingSession])

  const setScrollTop = useCallback((top: number) => {
    const surface = viewport.current
    if (!surface) return
    const bounded = Math.max(0, Math.min(top, surface.scrollHeight - surface.clientHeight))
    surface.scrollTop = bounded
  }, [])

  const restorePosition = useCallback(() => {
    const surface = viewport.current
    if (!surface) return
    const cards = [...surface.querySelectorAll<HTMLElement>('[data-caption-id]')]
    if (followRef.current) {
      const card = cards.find(item => item.dataset.captionId === readingClock.current.id)
      if (card) {
        const cardTop = card.getBoundingClientRect().top - surface.getBoundingClientRect().top + surface.scrollTop
        const cardHeight = card.getBoundingClientRect().height
        // Bottom-align a readable card so preceding context stays visible; long cards start at their top.
        setScrollTop(cardHeight > surface.clientHeight - 24 ? cardTop - 8 : cardTop + cardHeight - surface.clientHeight + 10)
      }
    } else if (anchor.current) {
      const card = cards.find(item => item.dataset.captionId === anchor.current?.id)
      if (card) setScrollTop(surface.scrollTop + card.getBoundingClientRect().top - surface.getBoundingClientRect().top - anchor.current.offset)
    }
    rememberAnchor()
  }, [rememberAnchor, setScrollTop])

  const pauseReading = useCallback(() => {
    followRef.current = false
    readingSession.following = false
    setFollowing(false)
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    rememberAnchor()
  }, [rememberAnchor, readingSession])

  useLayoutEffect(() => {
    const surface = viewport.current
    if (!surface) return
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const updated = new Map(captions.map(caption => [caption.id, JSON.stringify([caption.status, caption.live, caption.translationPending, caption.translatedOriginal, caption.original, caption.translations, caption.zh, caption.en, caption.ja, caption.jaSegments])]))
    if (!followRef.current && fingerprints.current.size) {
      for (const [id, value] of updated) if (fingerprints.current.get(id) !== value) unseen.current.add(id)
    }
    fingerprints.current = updated
    for (const id of unseen.current) if (!updated.has(id)) unseen.current.delete(id)
    if (focusId && focusVersion !== lastFocus.current) {
      lastFocus.current = focusVersion
      const card = [...surface.querySelectorAll<HTMLElement>('[data-caption-id]')].find(item => item.dataset.captionId === focusId)
      if (card) {
        pauseReading()
        setScrollTop(surface.scrollTop + card.getBoundingClientRect().top - surface.getBoundingClientRect().top - 10)
        rememberAnchor()
      }
    } else {
      if (followRef.current) {
        const now = performance.now()
        const next = advanceReading(visibleCaptions, readingClock.current, { targets, showFurigana: settings.showFurigana }, now)
        readingClock.current = next.clock
        readingSession.clock = next.clock
        setCursorId(next.clock.id)
        if (next.wakeAt !== null) timer.current = setTimeout(() => { timer.current = null; setClockTick(value => value + 1) }, Math.max(1, next.wakeAt - now))
        unseen.current.clear()
      }
      restorePosition()
    }
    setUnseenCount(unseen.current.size)
  }, [captions, focusId, focusVersion, following, clockTick, settings.fontSize, settings.showOriginal, settings.showFurigana, settings.targetLanguages, pauseReading, rememberAnchor, restorePosition, setScrollTop, readingSession])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => restorePosition())
    if (viewport.current) observer.observe(viewport.current)
    if (content.current) observer.observe(content.current)
    return () => observer.disconnect()
  }, [restorePosition])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const resumeFollowing = () => {
    const latest = captions.at(-1)
    releaseRetained.current = true
    readingClock.current = initialReadingClock(captions)
    readingSession.clock = readingClock.current
    readingSession.following = true
    followRef.current = true
    setFollowing(true)
    setCursorId(latest?.id || null)
    unseen.current.clear()
    setUnseenCount(0)
    setClockTick(value => value + 1)
    onReturnLive()
  }

  return <div className="caption-stream">
    <div className="stream-toolbar"><div className="stream-label"><span className={following ? 'following-dot' : ''} />{preview ? '段落示例' : following ? '实时跟随' : '正在回看'}<b>{following && currentReading?.live ? '实时更新中' : following && currentReading?.translationPending ? '正在补全译文' : following && currentReading?.status === 'translating' ? '等待本段翻译' : following && settings.showFurigana && targets.includes('ja') && currentReading?.furiganaStatus === 'pending' ? '正在补注音' : following && unreadCount ? `${unreadCount} 段待阅` : !following && unseenCount ? `${unseenCount} 段新字幕` : `${captions.length} 段`}</b></div><button className="stream-follow" onClick={resumeFollowing} title="跟随最新实时译文"><ArrowDown size={12} />{!following && unseenCount ? '有新字幕 · 回到实时' : '回到实时'}</button></div>
    <div className="stream-viewport" ref={viewport} tabIndex={0} aria-label="连续字幕，滚动回看后可返回实时" onPointerDown={event => { const surface = event.currentTarget; const gutter = surface.offsetWidth - surface.clientWidth; if (event.target === surface && gutter > 0 && event.clientX >= surface.getBoundingClientRect().right - gutter) pauseReading() }} onPointerCancel={event => { if (event.pointerType === 'touch') pauseReading() }} onPointerUp={event => { const selection = window.getSelection(); if (selection && !selection.isCollapsed && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) pauseReading() }} onKeyDown={event => {
      const spaceScroll = event.key === ' ' && event.target === event.currentTarget && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.defaultPrevented
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key) || spaceScroll) pauseReading()
    }} onWheel={event => { if (event.deltaY !== 0) pauseReading() }} onScroll={rememberAnchor}>
      <div className="stream-content" ref={content}>
        {preview && <p className="stream-start">示例内容仅用于预览阅读方式。</p>}
        {visibleCaptions.map((caption, index) => {
          const missingTargets = targets.some(code => !translationFor(caption, code))
          const retainedOnly = !activeIds.has(caption.id)
          const untranslated = untranslatedErrorSource(caption)
          return <article key={caption.id} data-caption-id={caption.id} className={`caption-card ${focusId === caption.id ? 'focused-caption' : ''} ${following && cursorId === caption.id ? 'reading-current' : ''} ${caption.status === 'translating' ? 'is-translating' : ''}`}>
            <header className="caption-card-heading"><div className="caption-card-meta"><span className="paragraph-number">{String(index + 1).padStart(2, '0')}</span><span>{preview ? '示例段落' : sourceNames[caption.source]} · {caption.language || '自动识别'}</span>{!preview && <time>{new Date(caption.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}{following && cursorId === caption.id && caption.status === 'ready' && !caption.live && !caption.translationPending && <span className="reading-current-label">阅读位置</span>}{settings.showFurigana && targets.includes('ja') && caption.furiganaStatus === 'pending' && <span className="annotation-status">正在补注音</span>}{settings.showFurigana && targets.includes('ja') && caption.furiganaStatus === 'error' && <span className="annotation-status">注音暂未完成</span>}{retainedOnly && <span className="retained-label">回看暂存 · 可复制</span>}{(caption.status === 'translating' || caption.translationPending) && <span className="translation-progress"><LoaderCircle size={10} className="spin" />{caption.live ? '实时更新' : '翻译中'}</span>}</div><div className="caption-card-actions"><button type="button" className={caption.saved ? 'active' : ''} aria-label={caption.saved ? '取消收藏这段' : '收藏这段'} title={retainedOnly ? '这段已离开近期记录，仍可复制保存' : caption.saved ? '取消收藏这段' : '收藏这段'} disabled={preview || retainedOnly || (!(allowRemoveSaved && caption.saved) && (caption.status !== 'ready' || caption.live || caption.translationPending))} onClick={() => onSave(caption)}><Bookmark size={13} fill={caption.saved ? 'currentColor' : 'none'} /></button><button type="button" aria-label="复制这段多语对照" title="复制这段多语对照" onClick={() => onCopy(caption)}>{copiedId === caption.id ? <Check size={13} /> : <Copy size={12} />}</button><button type="button" aria-label="按当前语言重新翻译这段" title="按当前语言重新翻译这段" disabled={preview || retainedOnly || caption.status === 'translating' || caption.live || caption.translationPending} onClick={() => onRetry(caption)}><RotateCcw size={12} /></button></div></header>
            <div className="language-rows">
              {settings.showOriginal && <CaptionRow label="原文" lang="auto" text={alignedOriginal(caption)} original />}
              {targets.map((code, targetIndex) => <CaptionRow key={code} label={languageInfo(code).nativeName} lang={languageInfo(code).lang} text={translationFor(caption, code)} primary={targetIndex === 0} segments={code === 'ja' && settings.showFurigana ? caption.jaSegments : undefined} pending={(caption.status === 'translating' || caption.translationPending) && (!caption.targetLanguages || caption.targetLanguages.includes(code))} />)}
            </div>
            {onRetryAnnotation && settings.showFurigana && targets.includes('ja') && annotationText(caption) && (caption.furiganaStatus === 'error' || caption.furiganaStatus === 'pending' || !caption.jaSegments?.length) && <div className="caption-missing"><button type="button" aria-label="重试日语注音" aria-busy={caption.furiganaStatus === 'pending'} aria-disabled={caption.furiganaStatus === 'pending'} disabled={preview || retainedOnly} onClick={event => { if (caption.furiganaStatus !== 'pending') { annotationFocus.current = event.currentTarget; onRetryAnnotation(caption) } }}><RotateCcw size={11} />重试日语注音</button></div>}
            {untranslated && <div className="caption-untranslated"><b>{untranslated.label}</b><p dir="auto">{untranslated.text}</p></div>}
            {missingTargets && caption.status === 'ready' && !caption.live && !caption.translationPending && !preview && !retainedOnly && <div className="caption-missing"><span>部分所选语言尚未生成</span><button onClick={() => onRetry(caption)}><RotateCcw size={11} />按当前语言重新翻译</button></div>}
            {caption.status === 'error' && <div className="caption-error"><span>{caption.error || '这段翻译暂时没有完成。'}</span>{!retainedOnly && !caption.live && !caption.translationPending && <button onClick={() => onRetry(caption)}><RotateCcw size={11} />重试</button>}</div>}
          </article>
        })}
        <div className="stream-end" />
      </div>
    </div>
  </div>
}

function CaptionRow({ label, text, lang, segments, original, primary, pending }: { label: string; text: string; lang: string; segments?: Caption['jaSegments']; original?: boolean; primary?: boolean; pending?: boolean }) {
  const validSegments = segments?.length && segments.map(segment => segment.text).join('') === text ? segments : undefined
  const hasFurigana = validSegments?.some(segment => segment.reading)
  return <div className={`caption-row ${original ? 'original-row' : ''} ${primary ? 'primary-row' : ''} ${hasFurigana ? 'ruby-row' : ''}`}><span className="language-label">{label}</span><div className="caption-content"><p lang={lang === 'auto' ? undefined : lang} dir="auto" className={!text ? 'placeholder-text' : ''}>{validSegments ? validSegments.map((segment, index) => segment.reading ? <ruby key={index}>{segment.text}<rp>(</rp><rt>{segment.reading}</rt><rp>)</rp></ruby> : <span key={index}>{segment.text}</span>) : text || (pending ? '正在翻译…' : '未生成')}</p></div></div>
}
