import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Caption, LingoAPI, Settings } from '../shared/types'
import { learningOriginal, learningTarget, validPhrase, type LearningState, type Phrase } from '../shared/learning'
import { languageInfo } from '../shared/languages'
import { translationFor } from './caption-text'
import { selectedPhrase } from './learning-selection'
import HistoryPanel from './HistoryPanel'

type Props = { api: LingoAPI; settings: Settings; captions: Caption[]; learning: LearningState; initial: Caption | null; onClose: () => void; onExport: () => void; exporting: boolean; exportResult: {text: string; error: boolean} | null }
export default function StudyPanel({ api, settings, captions, learning, initial, onClose, onExport, exporting, exportResult }: Props) {
  // Only explicit user navigation replaces this frozen encounter. Incoming snapshots never do.
  const [frozen, setFrozen] = useState(() => initial ? structuredClone({ caption: initial, settings }) : null)
  const initialRecord = (caption: Caption | null) => learning.records.find(record => record.captionId === caption?.id)
  const [phrases, setPhrases] = useState<Phrase[]>(() => structuredClone(initialRecord(initial)?.phrases || []))
  const [note, setNote] = useState(initialRecord(initial)?.note || '')
  const [dirty, setDirty] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const leaveAction = useRef<() => void>(() => {})
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('0')
  const [sessionName, setSessionName] = useState('')
  const [sessionFilter, setSessionFilter] = useState('current')
  const [filter, setFilter] = useState<'all' | 'saved'>('saved')
  const original = useRef<HTMLParagraphElement>(null)
  const inboxReturnFocus = useRef<HTMLElement | null>(null)
  const frozenInbox = useRef<Caption[] | null>(null)
  useLayoutEffect(() => {
    if (frozen) original.current?.focus()
    else if (inboxReturnFocus.current?.isConnected) inboxReturnFocus.current.focus()
    else document.querySelector<HTMLElement>('.panel-study .history-search-input')?.focus()
  }, [frozen])
  useEffect(() => { if (confirmLeave) document.querySelector<HTMLElement>('.study-confirm button')?.focus() }, [confirmLeave])
  const generation = useRef(0)
  const alive = useRef(true)
  const composing = useRef(false)
  const initialIds = useRef(new Set(captions.map(caption => caption.id)))
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])
  const attempt = (action: () => void) => {
    if (pendingRef.current) { setMessage('正在保存，请稍候。'); return }
    if (dirty) { leaveAction.current = action; setConfirmLeave(true) }
    else action()
  }
  const open = (caption: Caption) => attempt(() => {
    generation.current++
    inboxReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    frozenInbox.current = inbox
    const record = initialRecord(caption)
    setFrozen(structuredClone({ caption, settings })); setPhrases(structuredClone(record?.phrases || [])); setNote(record?.note || '')
    setDirty(false); setMessage(''); setStart('0'); setEnd('0')
  })
  const close = () => attempt(onClose)
  const current = useRef({ close })
  current.current = { close: () => { if (confirmLeave) setConfirmLeave(false); else close() } }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || composing.current || event.keyCode === 229) return
      event.preventDefault(); event.stopImmediatePropagation(); current.current.close()
    }
    const begin = () => { composing.current = true }
    const finish = () => { composing.current = false }
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('compositionstart', begin); window.addEventListener('compositionend', finish)
    return () => { window.removeEventListener('keydown', keyboard, true); window.removeEventListener('compositionstart', begin); window.removeEventListener('compositionend', finish) }
  }, [])
  const source = frozen ? learningOriginal(frozen.caption) : ''
  const add = (phrase: Phrase | null) => {
    if (!phrase) { setMessage('请选择原文中连续的完整字符，或手工修改起止范围。'); return }
    setStart(String(phrase.start)); setEnd(String(phrase.end))
    if (phrases.some(item => item.start === phrase.start && item.end === phrase.end)) return
    if (phrases.length >= 20) { setMessage('每句最多保存 20 个短语。'); return }
    setPhrases(value => [...value, phrase]); setDirty(true); setMessage('')
  }
  const save = async () => {
    if (!frozen || !api.learning || pendingRef.current) return
    const revision = ++generation.current
    pendingRef.current = true; setPending(true); setMessage('')
    try {
      const result = await api.learning.save({ target: learningTarget(frozen.caption, frozen.settings), phrases, note })
      if (alive.current && revision === generation.current) { setMessage(result.message); if (result.kind === 'saved') setDirty(false) }
    } catch (error) { if (alive.current && revision === generation.current) setMessage(`收藏失败，草稿仍保留：${error instanceof Error ? error.message : '写入失败'}`) }
    finally { if (alive.current && revision === generation.current) { pendingRef.current = false; setPending(false) } }
  }
  const localAction = async (action: () => Promise<unknown>, success: string) => {
    if (pendingRef.current) return
    const revision = ++generation.current
    pendingRef.current = true; setPending(true); setMessage('')
    try { await action(); if (alive.current && revision === generation.current) { setMessage(success); return true } }
    catch (error) { if (alive.current && revision === generation.current) setMessage(error instanceof Error ? error.message : '操作失败') }
    finally { if (alive.current && revision === generation.current) { pendingRef.current = false; setPending(false) } }
    return false
  }
  const currentSession = learning.sessions.find(session => session.id === learning.currentSessionId)
  const selectedSession = sessionFilter === 'current' ? learning.currentSessionId : sessionFilter
  const recordIds = new Set(learning.records.filter(record => selectedSession !== null && record.sessionId === selectedSession).map(record => record.captionId))
  const inbox = sessionFilter === 'all' ? captions.filter(caption => caption.saved) : captions.filter(caption => caption.saved && recordIds.has(caption.id))
  const newCount = captions.filter(caption => !initialIds.current.has(caption.id)).length
  return <>
    <div className="panel-heading"><h2>{frozen ? '句子与笔记' : '会话匣'}</h2><button type="button" className="text-button" aria-label="关闭学习面板" onClick={close}>关闭</button></div>
    {confirmLeave && <div className="study-confirm" role="alert"><p>草稿尚未保存。继续编辑，或明确放弃后离开。</p><button type="button" onClick={() => setConfirmLeave(false)}>继续编辑</button><button type="button" onClick={() => { setConfirmLeave(false); setDirty(false); leaveAction.current() }}>放弃草稿并离开</button></div>}
    {learning.warning && <p className="panel-notice" role="alert">{learning.warning}</p>}
    {message && <p className="panel-notice" role="status">{message}</p>}
    {!learning.shortcutAvailable && <p className="history-search-hint">QuickPin 快捷键被占用，请使用句子旁的按钮。</p>}
    {frozen ? <fieldset disabled={pending} className="study-detail" data-study-id={frozen.caption.id}>
      {learning.unanchoredIds?.includes(frozen.caption.id) && <p className="panel-notice">原文已变化，旧短语未锚定；不会套用旧范围。</p>}
      <div className="study-actions"><button type="button" onClick={() => attempt(() => { generation.current++; setFrozen(null); setMessage('') })}>会话匣</button><button type="button" onClick={() => { const revision = generation.current; void api.copyText(source).catch(error => { if (alive.current && revision === generation.current) setMessage(String(error)) }) }}>复制原文</button><span>{newCount > 0 ? `${newCount} 条新字幕` : ''}</span></div>
      <p className="study-source" ref={original} lang={frozen.caption.language} dir="auto" tabIndex={0} aria-label="冻结原文，可选择连续短语">{source}</p>
      <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => add(original.current ? selectedPhrase(original.current, source, window.getSelection()) : null)}>加入所选原文短语</button>
      <div className="study-translations">{frozen.settings.targetLanguages.map(code => {
        const text = translationFor(frozen.caption, code)
        const segments = code === 'ja' && frozen.settings.showFurigana && frozen.caption.jaSegments?.map(segment => segment.text).join('') === text ? frozen.caption.jaSegments : undefined
        return <div key={code} data-study-language={code}><b>{languageInfo(code).nativeName}</b><p lang={languageInfo(code).lang} dir="auto">{segments ? segments.map((segment, index) => segment.reading ? <ruby key={index}>{segment.text}<rt>{segment.reading}</rt></ruby> : <span key={index}>{segment.text}</span>) : text || '未生成'}</p></div>
      })}</div>
      <fieldset className="study-range"><legend>原文范围（UTF-16 起点含、终点不含）</legend><label>起点<input aria-label="短语起点" type="number" min="0" max={source.length} value={start} onChange={event => { setStart(event.target.value); setDirty(true) }} /></label><label>终点<input aria-label="短语终点" type="number" min="0" max={source.length} value={end} onChange={event => { setEnd(event.target.value); setDirty(true) }} /></label><button type="button" onClick={() => { const phrase = { start: Number(start), end: Number(end), exact: source.slice(Number(start), Number(end)) }; add(validPhrase(source, phrase) ? phrase : null) }}>加入范围</button></fieldset>
      <ul className="study-phrases">{phrases.map((phrase, index) => <li key={`${phrase.start}:${phrase.end}`}><span dir="auto">{phrase.exact}</span><small>{phrase.start}–{phrase.end}</small><button type="button" aria-label={`删除短语 ${phrase.exact}`} onClick={() => { setPhrases(value => value.filter((_, i) => i !== index)); setDirty(true) }}>删除</button></li>)}</ul>
      <label className="study-note">笔记<textarea aria-label="句子笔记" value={note} maxLength={2000} onChange={event => { setNote(event.target.value); setDirty(true) }} /></label>
      <div className="study-actions"><button type="button" className="primary-button" aria-busy={pending} disabled={pending} onClick={() => void save()}>保存句子与笔记</button><span>{dirty ? '未保存草稿 · 仅在本次打开期间保留' : '此视图已冻结'}</span></div>
      {captions.some(caption => caption.id === frozen.caption.id && caption.saved) && <button type="button" disabled={pending} onClick={() => attempt(() => { void localAction(() => api.learning!.removeNotes(frozen.caption.id), '短语与笔记已删除，普通收藏保留。').then(success => { if (success && alive.current) { setPhrases([]); setNote(''); setDirty(false) } }) })}>删除已保存笔记</button>}
    </fieldset> : null}
    <div className="study-inbox" hidden={Boolean(frozen)} inert={Boolean(frozen)}>
      <div className="study-session"><label>会话名称<input value={sessionName} maxLength={80} onChange={event => setSessionName(event.target.value)} placeholder="例如：今天的新闻" /></label><button type="button" disabled={pending || !sessionName.trim()} onClick={() => void localAction(() => api.learning!.session(sessionName.trim()), '新会话已开始。')}>开始新会话</button><button type="button" disabled={pending || !currentSession} onClick={() => void localAction(() => api.learning!.session(null), '会话已结束。')}>结束会话</button><span>{currentSession ? `当前：${currentSession.name}` : '当前没有学习会话；普通收藏照常可用。'}</span></div>
      <label className="study-filter">查看<select aria-label="学习会话" value={sessionFilter} onChange={event => setSessionFilter(event.target.value)}><option value="current">当前会话</option><option value="all">所有收藏（含旧收藏）</option>{learning.sessions.map(session => <option key={session.id} value={session.id}>{session.name}{session.endedAt ? '（已结束）' : ''}</option>)}</select></label>
      <HistoryPanel suspended={Boolean(frozen)} captions={frozen && frozenInbox.current ? frozenInbox.current : inbox} settings={settings} filter={filter} focusVersion={0} onFilter={setFilter} onSelect={open} onSave={caption => void localAction(() => api.toggleSaved(caption.id), caption.saved ? '已取消收藏' : '已收藏')} onExport={onExport} exporting={exporting} exportResult={exportResult} noteFor={caption => learning.records.find(record => record.captionId === caption.id)?.note} />
    </div>
  </>
}
