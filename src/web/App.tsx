import AuthSettings from './AuthSettings'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import CaptionStream from '../renderer/CaptionStream'
import CompactCaption from '../renderer/CompactCaption'
import HistoryPanel from '../renderer/HistoryPanel'
import LanguageSettings from '../renderer/LanguageSettings'
import { alignedOriginal, translationFor, untranslatedErrorSource } from '../renderer/caption-text'
import { languageInfo } from '../shared/languages'
import type { Caption, Settings } from '../shared/types'
import type { ReadingSession } from '../renderer/reading-schedule'
import type { BrowserSession } from './session'
import { observeWebViewport } from './viewport'

function captionText(caption: Caption, settings: Settings): string {
  const lines = settings.showOriginal ? [`原文：${alignedOriginal(caption)}`] : []
  const untranslated = settings.showOriginal ? untranslatedErrorSource(caption) : null
  if (untranslated) lines.push(`${untranslated.label}：${untranslated.text}`)
  for (const code of settings.targetLanguages) lines.push(`${languageInfo(code).nativeName}：${translationFor(caption, code) || '未生成'}`)
  return lines.join('\n')
}

function TranslationKeySettings({ session, asr = false }: { session: BrowserSession; asr?: boolean }) {
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const submitting = useRef(false)
  const composing = useRef(false)
  useLayoutEffect(() => {
    const field = input.current
    return () => {
      generation.current++; submitting.current = false
      if (field) field.value = ''
    }
  }, [])
  const saveKey = async () => {
    if (submitting.current || !apiKey.trim()) return
    const current = ++generation.current
    submitting.current = true; setPending(true); setStatus('')
    try {
      await (asr ? session.configureAsrKey(apiKey) : session.configureTranslationKey(apiKey))
      if (current !== generation.current) return
      setApiKey(''); if (input.current) input.current.value = ''
      setStatus(asr ? '已保存，尚未验证供应商密钥；请刷新页面查看语音状态。' : '已保存')
    } catch {
      if (current === generation.current) setStatus('密钥保存未完成。')
    } finally {
      if (current === generation.current) { submitting.current = false; setPending(false) }
    }
  }
  return <fieldset className="web-key-settings">
    <legend>{asr ? '语音识别服务' : '翻译服务'}</legend>
    <label htmlFor={asr ? "web-asr-key" : "web-translation-key"}>{asr ? "阿里云百炼 DashScope API Key（北京）" : "DeepSeek API Key"}</label>
    <input ref={input} id={asr ? "web-asr-key" : "web-translation-key"} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={pending} maxLength={4096} autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={asr ? "web-asr-key-status" : "web-key-status"}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) {
          event.preventDefault(); void saveKey()
        }
      }} />
    <button type="button" onClick={() => void saveKey()} disabled={pending || !apiKey.trim()}>{pending ? '正在保存…' : '保存密钥'}</button>
    <p id={asr ? "web-asr-key-status" : "web-key-status"} role="status">{status || (asr ? session.audioStatusMessage : session.textConfigured ? '已配置' : '')}</p>
    {asr && <p>语音发送至百炼北京端点，识别文字交由 DeepSeek 翻译。保存密钥不会录音或调用模型。</p>}
  </fieldset>
}

export default function WebApp({ session }: { session: BrowserSession }) {
  const [snapshot, setSnapshot] = useState(() => session.snapshot())
  const [panel, setPanel] = useState<'settings' | 'history' | 'text' | null>(null)
  const [draft, setDraft] = useState(snapshot.settings)
  const [notice, setNotice] = useState('')
  const [textInput, setTextInput] = useState('')
  const [textPending, setTextPending] = useState(false)
  const textAction = useRef(0)
  const textInFlight = useRef(false)
  const textBytes = new TextEncoder().encode(textInput).byteLength
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
  const shell = useRef<HTMLElement>(null)
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = snapshot.state === 'starting' || snapshot.state === 'listening'

  useLayoutEffect(() => shell.current ? observeWebViewport(shell.current) : undefined, [])
  useLayoutEffect(() => { if (panel) panelHeading.current?.focus({ preventScroll: true }) }, [panel])

  useEffect(() => {
    const off = session.subscribe(next => {
      const nextActive = next.state === 'starting' || next.state === 'listening'
      if (nextActive && !capturing.current) {
        reading.current = { clock: null, following: true, anchor: null }
        setReadingEpoch(value => value + 1); setSelectedId(null)
      }
      capturing.current = nextActive; setSnapshot(next)
    })
    const suspend = () => {
      action.current++; textAction.current++; textInFlight.current = false
      setTextPending(false); session.stop()
    }
    const visibility = () => { if (document.hidden) suspend() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', suspend)
    return () => {
      textAction.current++; textInFlight.current = false
      off(); session.stop()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', suspend)
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [session])
  const run = async (work: () => unknown | Promise<unknown>) => {
    setNotice('')
    try { await work() } catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : '操作未完成。') }
  }
  const toggle = async () => {
    const current = ++action.current
    setNotice('')
    if (active) { session.stop(); return }
    try { await session.start() }
    catch (error) { if (current === action.current && !(error instanceof Error && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : '无法开始录音。') }
  }
  const cancelText = () => {
    textAction.current++; textInFlight.current = false
    session.cancelText(); setTextPending(false)
  }
  const open = (next: 'settings' | 'history' | 'text') => {
    if (textInFlight.current) cancelText()
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDraft(snapshot.settings); setNotice(''); setPanel(next)
  }
  const close = () => {
    cancelText(); setPanel(null); setNotice('')
    requestAnimationFrame(() => returnFocus.current?.focus())
  }
  const submitText = async () => {
    if (textInFlight.current || !textInput.trim() || textBytes > 2000) return
    const current = ++textAction.current
    textInFlight.current = true; setTextPending(true); setNotice('')
    try {
      await session.translateText(textInput)
      if (current !== textAction.current) return
      textInFlight.current = false; setTextPending(false); close()
    } catch (error) {
      if (current === textAction.current && !(error instanceof Error && error.name === 'AbortError')) setNotice(error instanceof Error ? error.message : '文字翻译未完成。')
    } finally {
      if (current === textAction.current) { textInFlight.current = false; setTextPending(false) }
    }
  }
  const copy = (caption: Caption) => void run(async () => {
    await navigator.clipboard.writeText(captionText(caption, snapshot.settings))
    setCopiedId(caption.id)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopiedId(null), 1800)
  })
  const save = (caption: Caption) => void run(() => session.toggleSaved(caption.id))
  const retry = (caption: Caption) => void run(() => session.retry(caption.id))
  const retryAnnotation = (caption: Caption) => void run(() => session.retryAnnotation(caption.id))
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
  return <main ref={shell} className={`app-shell web-shell ${compact ? 'is-collapsed' : ''} ${panel ? 'has-panel' : ''}`}
    style={{ '--caption-size': `${snapshot.settings.fontSize}px`, '--surface-opacity': 1 } as CSSProperties}
    onCompositionStartCapture={() => { composing.current = true }} onCompositionEndCapture={() => { composing.current = false }}
    onKeyDown={event => { if (event.key === 'Escape' && panel && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); close() } }}>
    <header className="web-header"><strong>LingoBar · 语伴</strong>{controls}</header>
    <div className="web-capture">
      <span role="status">{!session.configured ? snapshot.message : snapshot.state === 'starting' ? '正在连接' : snapshot.state === 'listening' ? '正在聆听' : snapshot.state === 'error' ? '连接中断' : '已暂停'}</span>
      <button type="button" className="listen-button" disabled={!session.configured} onClick={() => void toggle()}>{snapshot.state === 'starting' ? '取消' : active ? '暂停' : '开始聆听'}</button>
    </div>
    {!session.configured && <p className="web-notice" role="status">{session.audioStatusMessage}</p>}
    {message && <p className="web-notice" role="alert">{message}</p>}
    <div className="web-reading" hidden={panel !== null}>
      {snapshot.captions.length ? compact
        ? <CompactCaption key={`compact:${readingEpoch}`} captions={snapshot.captions} settings={snapshot.settings} readingSession={reading.current} preview={false} partial={[]} listening={snapshot.state === 'listening'} notice="" onRetry={retry} onRetryAnnotation={retryAnnotation} onReturnLive={() => setSelectedId(null)} controls={<></>} />
        : <CaptionStream allowRemoveSaved key={`expanded:${readingEpoch}`} captions={snapshot.captions} settings={snapshot.settings} readingSession={reading.current} preview={false} focusId={selectedId} focusVersion={focusVersion} copiedId={copiedId} onCopy={copy} onSave={save} onRetry={retry} onRetryAnnotation={retryAnnotation} onReturnLive={() => setSelectedId(null)} />
        : <p className="web-empty">暂无字幕</p>}
    </div>
    {panel && <section className={`web-panel panel-${panel}`} aria-label={panel === 'settings' ? '字幕设置' : panel === 'text' ? '文字翻译' : '历史与收藏'}>
      <div className="web-panel-heading"><h1 ref={panelHeading} tabIndex={-1}>{panel === 'settings' ? '字幕设置' : panel === 'text' ? '文字翻译' : '历史与收藏'}</h1><button type="button" onClick={close}>返回字幕</button></div>
      {panel === 'settings' ? <form className="settings-content" onSubmit={event => { event.preventDefault(); void run(() => { session.saveSettings({ targetLanguages: draft.targetLanguages, showOriginal: draft.showOriginal, showFurigana: draft.showFurigana, fontSize: draft.fontSize }); close() }) }}>
        <LanguageSettings draft={draft} onChange={next => setDraft(previous => ({ ...previous, ...next }))} />
        <label className="web-font" htmlFor="web-font">字号 {draft.fontSize}px<input id="web-font" type="range" min="14" max="24" value={draft.fontSize} onChange={event => setDraft(previous => ({ ...previous, fontSize: Number(event.target.value) }))} /></label>
        {session.authAvailable && <AuthSettings stop={() => session.stop()} />}
        {session.credentialsAvailable && <TranslationKeySettings session={session} />}
        {session.asrCredentialsAvailable && <TranslationKeySettings session={session} asr />}
        <button type="submit" className="primary-button">保存设置</button>
      </form> : panel === 'text' ? <form className="web-text-form" onSubmit={event => { event.preventDefault(); void submitText() }}>
        <label htmlFor="web-text-input">原文</label>
        <textarea id="web-text-input" value={textInput} onChange={event => setTextInput(event.target.value)} disabled={textPending} maxLength={2000} aria-describedby="web-text-limit" placeholder="粘贴需要翻译的文字" />
        <p id="web-text-limit" className={textBytes > 2000 ? 'web-text-over-limit' : ''}>{textBytes} / 2000 UTF-8 字节</p>
        {!session.textConfigured && <p role="status">文字服务未配置</p>}
        <div className="web-text-actions"><button type="submit" className="primary-button" disabled={!session.textConfigured || textPending || !textInput.trim() || textBytes > 2000}>{textPending ? '正在翻译…' : '翻译文字'}</button>{textPending && <button type="button" onClick={cancelText}>取消翻译</button>}</div>
      </form> : <HistoryPanel allowRemoveSaved captions={snapshot.captions} settings={snapshot.settings} filter={filter} focusVersion={focusVersion} onFilter={setFilter} onSelect={caption => { setSelectedId(caption.id); setFocusVersion(value => value + 1); setCompact(false); close() }} onSave={save} onExport={exportSaved} exporting={false} exportResult={exportResult} />}
    </section>}
    <footer className="web-footer"><button type="button" aria-expanded={panel === 'settings'} onClick={() => panel === 'settings' ? close() : open('settings')}>字幕设置</button><button type="button" aria-expanded={panel === 'text'} onClick={() => panel === 'text' ? close() : open('text')}>文字翻译</button><button type="button" aria-expanded={panel === 'history'} onClick={() => panel === 'history' ? close() : open('history')}>历史与收藏</button></footer>
  </main>
}
