import { useEffect, useRef, useState, type CSSProperties } from 'react'
import CaptionStream from '../renderer/CaptionStream'
import CompactCaption from '../renderer/CompactCaption'
import HistoryPanel from '../renderer/HistoryPanel'
import LanguageSettings from '../renderer/LanguageSettings'
import { alignedOriginal, translationFor, untranslatedErrorSource } from '../renderer/caption-text'
import { languageInfo } from '../shared/languages'
import type { Caption, Settings } from '../shared/types'
import type { ReadingSession } from '../renderer/reading-schedule'
import type { BrowserSession } from './session'

function captionText(caption: Caption, settings: Settings): string {
  const lines = settings.showOriginal ? [`原文：${alignedOriginal(caption)}`] : []
  const untranslated = settings.showOriginal ? untranslatedErrorSource(caption) : null
  if (untranslated) lines.push(`${untranslated.label}：${untranslated.text}`)
  for (const code of settings.targetLanguages) lines.push(`${languageInfo(code).nativeName}：${translationFor(caption, code) || '未生成'}`)
  return lines.join('\n')
}

export default function WebApp({ session }: { session: BrowserSession }) {
  const [snapshot, setSnapshot] = useState(() => session.snapshot())
  const [panel, setPanel] = useState<'settings' | 'history' | null>(null)
  const [draft, setDraft] = useState(snapshot.settings)
  const [notice, setNotice] = useState('')
  const [compact, setCompact] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusVersion, setFocusVersion] = useState(0)
  const [filter, setFilter] = useState<'all' | 'saved'>('all')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [exportResult, setExportResult] = useState<{ text: string; error: boolean } | null>(null)
  const reading = useRef<ReadingSession>({ clock: null, following: true, anchor: null })
  const capturing = useRef(false)
  const [readingEpoch, setReadingEpoch] = useState(0)
  const action = useRef(0)
  const composing = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = snapshot.state === 'starting' || snapshot.state === 'listening'

  useEffect(() => {
    const off = session.subscribe(next => {
      const nextActive = next.state === 'starting' || next.state === 'listening'
      if (nextActive && !capturing.current) {
        reading.current = { clock: null, following: true, anchor: null }
        setReadingEpoch(value => value + 1); setSelectedId(null)
      }
      capturing.current = nextActive; setSnapshot(next)
    })
    const suspend = () => { if (capturing.current) { action.current++; session.stop() } }
    const visibility = () => { if (document.hidden) suspend() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', suspend)
    return () => {
      off(); session.stop()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', suspend)
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [session])
  const run = async (work: () => unknown | Promise<unknown>) => {
    setNotice('')
    try { await work() } catch (error) { setNotice(error instanceof Error ? error.message : '操作未完成。') }
  }
  const toggle = async () => {
    const current = ++action.current
    setNotice('')
    if (active) { session.stop(); return }
    try { await session.start() }
    catch (error) { if (current === action.current && !(error instanceof Error && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : '无法开始录音。') }
  }
  const open = (next: 'settings' | 'history') => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDraft(snapshot.settings); setNotice(''); setPanel(next)
  }
  const close = () => { setPanel(null); setNotice(''); requestAnimationFrame(() => returnFocus.current?.focus()) }
  const copy = (caption: Caption) => void run(async () => {
    await navigator.clipboard.writeText(captionText(caption, snapshot.settings))
    setCopiedId(caption.id)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopiedId(null), 1800)
  })
  const save = (caption: Caption) => void run(() => session.toggleSaved(caption.id))
  const retry = (caption: Caption) => void run(() => session.retry(caption.id))
  const exportSaved = () => {
    const saved = snapshot.captions.filter(caption => caption.saved)
    if (!saved.length) return
    try {
      const content = `# LingoBar\n\n${saved.map(caption => captionText(caption, snapshot.settings)).join('\n\n---\n\n')}\n`
      const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = 'LingoBar-notes.md'
      document.body.append(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      // Browsers expose download initiation, not confirmation of a disk write.
      setExportResult({ text: '已请求下载收藏。', error: false })
    } catch { setExportResult({ text: '无法生成收藏下载。', error: true }) }
  }
  const controls = <button type="button" onClick={() => setCompact(value => !value)}>{compact ? '展开字幕' : '紧凑显示'}</button>
  const message = notice || (snapshot.state === 'error' ? snapshot.message : '')
  return <main className={`app-shell web-shell ${compact ? 'is-collapsed' : ''}`}
    style={{ '--caption-size': `${snapshot.settings.fontSize}px`, '--surface-opacity': 1 } as CSSProperties}
    onCompositionStartCapture={() => { composing.current = true }} onCompositionEndCapture={() => { composing.current = false }}
    onKeyDown={event => { if (event.key === 'Escape' && panel && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); close() } }}>
    <header className="web-header"><strong>LingoBar · 语伴</strong>{controls}</header>
    <div className="web-capture">
      <span role="status">{!session.configured ? '后端未配置' : snapshot.state === 'starting' ? '正在连接' : snapshot.state === 'listening' ? '正在聆听' : snapshot.state === 'error' ? '连接中断' : '已暂停'}</span>
      <button type="button" className="listen-button" disabled={!session.configured} onClick={() => void toggle()}>{snapshot.state === 'starting' ? '取消' : active ? '暂停' : '开始聆听'}</button>
    </div>
    {message && <p className="web-notice" role="alert">{message}</p>}
    <div className="web-reading" hidden={panel !== null}>
      {snapshot.captions.length ? compact
        ? <CompactCaption key={`compact:${readingEpoch}`} captions={snapshot.captions} settings={snapshot.settings} readingSession={reading.current} preview={false} partial={[]} listening={snapshot.state === 'listening'} notice="" onRetry={retry} onReturnLive={() => setSelectedId(null)} controls={<></>} />
        : <CaptionStream allowRemoveSaved key={`expanded:${readingEpoch}`} captions={snapshot.captions} settings={snapshot.settings} readingSession={reading.current} preview={false} focusId={selectedId} focusVersion={focusVersion} copiedId={copiedId} onCopy={copy} onSave={save} onRetry={retry} onReturnLive={() => setSelectedId(null)} />
        : <p className="web-empty">暂无字幕</p>}
    </div>
    {panel && <section className={`web-panel panel-${panel}`} aria-label={panel === 'settings' ? '字幕设置' : '历史与收藏'}>
      <div className="web-panel-heading"><h1>{panel === 'settings' ? '字幕设置' : '历史与收藏'}</h1><button type="button" onClick={close}>返回字幕</button></div>
      {panel === 'settings' ? <form className="settings-content" onSubmit={event => { event.preventDefault(); void run(() => { session.saveSettings({ targetLanguages: draft.targetLanguages, showOriginal: draft.showOriginal, showFurigana: draft.showFurigana, fontSize: draft.fontSize }); close() }) }}>
        <LanguageSettings draft={draft} onChange={next => setDraft(previous => ({ ...previous, ...next }))} />
        <label className="web-font" htmlFor="web-font">字号 {draft.fontSize}px<input id="web-font" type="range" min="14" max="24" value={draft.fontSize} onChange={event => setDraft(previous => ({ ...previous, fontSize: Number(event.target.value) }))} /></label>
        <button type="submit" className="primary-button">保存设置</button>
      </form> : <HistoryPanel allowRemoveSaved captions={snapshot.captions} settings={snapshot.settings} filter={filter} focusVersion={focusVersion} onFilter={setFilter} onSelect={caption => { setSelectedId(caption.id); setFocusVersion(value => value + 1); setCompact(false); close() }} onSave={save} onExport={exportSaved} exporting={false} exportResult={exportResult} />}
    </section>}
    <footer className="web-footer"><button type="button" aria-expanded={panel === 'settings'} onClick={() => panel === 'settings' ? close() : open('settings')}>字幕设置</button><button type="button" aria-expanded={panel === 'history'} onClick={() => panel === 'history' ? close() : open('history')}>历史与收藏</button></footer>
  </main>
}
