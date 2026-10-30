import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TargetLanguage } from '../shared/languages'
import { LANGUAGES, languageInfo } from '../shared/languages'
import { validPhrase, type Phrase } from '../shared/learning'
import type { DictionaryAPI, DictionaryAvailability, DictionaryDetail, DictionaryEncounter, DictionaryExplanation, DictionaryHandleResult, DictionaryPage, DictionaryQuery, DictionaryReviewSession, DictionaryRunState, DictionarySource } from '../shared/dictionary'
import OfflinePacksPanel from './OfflinePacksPanel'
import OfflinePhraseLookup from './OfflinePhraseLookup'
import { selectedPhrase } from './learning-selection'
import './dictionary.css'

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'
const emptyPage: DictionaryPage = { items: [], total: 0, page: 1, pageSize: 20, revision: 0, warning: '' }
const provenance = { 'main-verified': '与应用内对齐源文一致，不代表识别准确', 'saved-favorite': '旧字幕收藏来源，不追认当时屏幕一致', 'user-input': '用户输入，未经字幕核验' }
const phraseKey = (phrase: Phrase) => `${phrase.start}:${phrase.end}`
const attemptLabels = { persisting: '尚未发出', waiting: '等待服务', ready: '解释已保存', ambiguous: '语境不明确', model_declined: '模型未提供解释', schema_error: '返回格式不合格', service_error: '服务失败', cancelled: '已停止等待', interrupted: '上次请求中断' } as const
const finalStates = new Set(['ready', 'ambiguous', 'model_declined', 'schema_error', 'service_error', 'cancelled', 'interrupted', 'persist_error'])

export function DictionaryExplanationView({ explanation }: { explanation: DictionaryExplanation }) {
  if (explanation.providerKind === 'offline-dictionary') return <section className="dictionary-explanation dictionary-offline-explanation" aria-label="已收藏的离线词典义项">
    <div className="dictionary-version">离线词典快照 · 版本 {explanation.version} · {explanation.providerLabel}</div>
    <dl><div><dt>词头</dt><dd dir="auto">{explanation.entry.headword}</dd></div><div><dt>词库读音</dt><dd>{explanation.entry.readings.join(' · ') || '未提供'}</dd></div><div><dt>词性</dt><dd>{explanation.entry.partOfSpeech || '未提供'}</dd></div><div><dt>所选义项</dt><dd><ul>{explanation.sense.glosses.map((gloss, index) => <li key={index} dir="auto">{gloss}</li>)}</ul></dd></div><div><dt>词库例句</dt><dd>{explanation.sense.examples.length ? explanation.sense.examples.map((example, index) => <div className="dictionary-example" key={index}><p dir="auto">{example.text}</p>{example.translation && <p dir="auto">{example.translation}</p>}</div>) : '未提供'}</dd></div></dl>
    <p>释义语言：{explanation.pack.glossLanguage} · 词库版本 {explanation.pack.version} · 来源快照 {explanation.pack.sourceRevision}</p>
    <details><summary>来源与许可</summary><p>{explanation.pack.sourceUrl}</p><p>{explanation.pack.license} · {explanation.pack.licenseUrl}</p><p>{explanation.pack.attribution}</p></details>
  </section>
  const content = explanation.content
  const status = content.status === 'ambiguous' ? '语境不明确' : content.status === 'declined' ? '模型未提供解释' : 'AI 语境解释'
  return <section className="dictionary-explanation" aria-label="已保存的 AI 解释">
    <p className="dictionary-ai-warning">AI生成，可能不准确。此结构化词条不是权威词典条目。</p>
    <div className="dictionary-version">{status} · 版本 {explanation.version} · {explanation.providerLabel} / {explanation.model}</div>
    <p>已请求以{languageInfo(explanation.requestedExplanationLanguage).nativeName}解释；实际语言和语义未经验证。</p>
    {content.status !== 'ok' ? <p>原因：{content.reasonCode === 'ambiguous_context' ? '上下文有歧义' : content.reasonCode === 'not_lexical_unit' ? '所选内容不是明确词语单位' : content.reasonCode === 'unsupported_language' ? '模型不支持此语言' : '模型拒绝解释'}</p> : <dl>
      <div><dt>AI建议原形</dt><dd>{content.headword ?? '未提供'}</dd></div>
      <div><dt>AI读音</dt><dd>{content.reading ? `${content.reading.text} (${content.reading.notation})` : '未提供'}<small>已请求所选形式，实际对应未核实（可能为建议原形）；不覆盖字幕注音。</small></dd></div>
      <div><dt>词性</dt><dd>{content.partOfSpeech ?? '未提供'}</dd></div>
      <div><dt>语境义</dt><dd>{content.contextMeaning ?? '未提供'}</dd></div>
      <div><dt>用法说明</dt><dd>{content.usageNote ?? '未提供'}</dd></div>
      <div><dt>AI生成例句</dt><dd>{content.examples ? content.examples.map((example, index) => <div className="dictionary-example" key={index}><p>{example.text}</p><p>{example.translation ?? '未提供译文'}</p></div>) : '未提供'}</dd></div>
    </dl>}
    {explanation.validationWarnings.includes('example_duplicates_source') && <p className="dictionary-warning">模型例句与原句相同，已移除；没有重新请求。</p>}
    {explanation.usage && <p className="dictionary-usage">服务返回的 token 用量仅为记录，不代表实际账单。</p>}
  </section>
}

function SourceView({ source }: { source: DictionarySource }) {
  const valid = validPhrase(source.text, source.span)
  return <section className="dictionary-source-context"><p className="dictionary-source" dir="auto">{valid ? <>{source.text.slice(0, source.span.start)}<mark>{source.span.exact}</mark>{source.text.slice(source.span.end)}</> : source.text}</p><small>{source.language} · {provenance[source.provenance]}</small></section>
}

/** One detail owns one handle. Resolving an old open never releases a newer handle. */
function useHandle(api: DictionaryAPI, promise: Promise<DictionaryHandleResult> | null) {
  const [result, setResult] = useState<DictionaryHandleResult | null>(null)
  useEffect(() => {
    let active = true
    let handle: string | null = null
    setResult(null)
    void promise?.then(value => {
      handle = value.handle
      if (active) setResult(value)
      else if (handle) void api.release(handle).catch(() => {})
    }).catch(error => { if (active) setResult({ handle: null, source: null, reason: errorText(error) }) })
    return () => { active = false; if (handle) void api.release(handle).catch(() => {}) }
  }, [api, promise])
  return result
}

export function PhraseExplanation({ api, handlePromise, source, phrases, defaultLanguage, encounterId, showResult = true, onOpenHistory, onOpenSettings }: {
  api: DictionaryAPI; handlePromise: Promise<DictionaryHandleResult> | null; source: string; phrases: Phrase[]; defaultLanguage: TargetLanguage
  encounterId?: string; showResult?: boolean; onOpenHistory?: () => void; onOpenSettings?: () => void
}) {
  const handle = useHandle(api, handlePromise)
  const [availability, setAvailability] = useState<DictionaryAvailability | null>(null)
  const [selected, setSelected] = useState('')
  const [language, setLanguage] = useState(defaultLanguage)
  const [run, setRun] = useState<DictionaryRunState | null>(null)
  const [detail, setDetail] = useState<DictionaryDetail | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const actionLock = useRef(false)
  const alive = useRef(true)
  const current = useRef(encounterId || null)
  const epoch = useRef(0)
  const locked = useRef(false)
  const selectedPhrase = phrases.find(phrase => phraseKey(phrase) === selected) || phrases[0]
  const selectedKey = selectedPhrase ? phraseKey(selectedPhrase) : ''
  useEffect(() => { let active = true; void api.availability().then(value => { if (active) setAvailability(value) }).catch(error => { if (active) setMessage(errorText(error)) }); return () => { active = false } }, [api])
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++ } }, [])
  useEffect(() => {
    epoch.current++; current.current = encounterId || null; setRun(null); setDetail(null); setMessage(''); setSending(false); locked.current = false
  }, [selectedKey, source, encounterId])
  useEffect(() => {
    let active = true
    let sequence = 0
    const refresh = () => {
      const id = current.current
      if (!id) return
      const version = epoch.current, order = ++sequence
      void api.get(id).then(value => {
        if (!active || !alive.current || version !== epoch.current || order !== sequence || current.current !== id) return
        setDetail(value); setRun(value?.run || null)
        if (!value || !value.run || finalStates.has(value.run.state) || value.run.state === 'ready_unsaved') { locked.current = false; setSending(false) }
      }).catch(error => { if (active && version === epoch.current) setMessage(errorText(error)) })
    }
    refresh()
    const off = api.onChanged(refresh)
    return () => { active = false; off() }
  }, [api, source, selectedKey, encounterId])
  const request = async () => {
    if (locked.current || !handle?.handle || !selectedPhrase || !availability?.configured) return
    if (source.length > 2000 || selectedPhrase.exact.length > 256 || !validPhrase(source, selectedPhrase)) { setMessage('解释限原句2000、连续短语256个UTF-16单位；不会截断，请重新选句。'); return }
    locked.current = true; setSending(true); setMessage('')
    if (!encounterId) { current.current = null; setRun(null); setDetail(null) }
    const version = ++epoch.current
    try {
      const next = await api.explain({ handle: handle.handle, span: structuredClone(selectedPhrase), language, ...(encounterId ? { encounterId } : {}) })
      if (!alive.current || version !== epoch.current) return
      current.current = next.encounterId; setRun(next)
      const value = await api.get(next.encounterId)
      if (!alive.current || version !== epoch.current || current.current !== next.encounterId) return
      if (!value) { current.current = null; setDetail(null); setRun(next.state === 'persist_error' ? next : null); locked.current = false; setSending(false); setMessage(next.state === 'persist_error' ? next.message : '学习条目已删除，迟到结果不会重新创建。'); return }
      setDetail(value); setRun(value.run || next)
      if (!value.run || finalStates.has(value.run.state) || value.run.state === 'ready_unsaved') { locked.current = false; setSending(false) }
    } catch (error) {
      if (alive.current && version === epoch.current) { setMessage(errorText(error)); locked.current = false; setSending(false) }
    }
  }
  const action = async (operation: () => Promise<DictionaryRunState | void>) => {
    if (actionLock.current || (locked.current && run?.state !== 'waiting')) return
    actionLock.current = true; setActionPending(true)
    const version = epoch.current
    setMessage('')
    try {
      const next = await operation()
      if (alive.current && version === epoch.current) { if (next) setRun(next); locked.current = false; setSending(false) }
    } catch (error) { if (alive.current && version === epoch.current) setMessage(errorText(error)) }
    finally { if (alive.current) { actionLock.current = false; setActionPending(false) } }
  }
  const invalidSelection = !selectedPhrase || !validPhrase(source, selectedPhrase) || selectedPhrase.exact.length > 256 || source.length > 2000
  const latest = detail?.encounter.explanations.at(-1)
  return <><OfflinePhraseLookup api={api} handle={handle} source={source} phrase={selectedPhrase} defaultLanguage={defaultLanguage} onOpenHistory={onOpenHistory} /><section className="dictionary-phrase-tool" aria-label="显式 AI 语境解释">
    <h3>AI语境解释</h3>
    <p className="dictionary-ai-warning">AI生成，可能不准确；不会查询权威词典。</p>
    <label>解释短语<select aria-label="解释短语" value={selectedKey} onChange={event => setSelected(event.target.value)} disabled={!phrases.length}>{!phrases.length && <option value="">请先加入一个原文短语</option>}{phrases.map(phrase => <option key={phraseKey(phrase)} value={phraseKey(phrase)}>{phrase.exact}</option>)}</select></label>
    <div className="dictionary-request-preview"><span>将发送的短语</span><p className="dictionary-request-target" dir="auto">{selectedPhrase?.exact || '尚未选择'}</p><span>将发送的冻结单句</span><p className="dictionary-source" dir="auto">{source}</p></div>
    <label>解释语言<select aria-label="解释语言" value={language} onChange={event => setLanguage(event.target.value as TargetLanguage)} disabled={sending}>{LANGUAGES.map(item => <option key={item.code} value={item.code}>{item.nativeName}</option>)}</select></label>
    <p className="dictionary-provider">{availability ? `${availability.providerLabel} / ${availability.model || '未配置模型'}` : '正在读取服务配置'}。仅发送此短语、冻结单句及所选解释语言，不发送笔记、邻近字幕或音频。</p>
    <p>调用服务，并保存到本机独立学习历史；取消旧字幕收藏不会删除这份历史。可能产生API费用；停止等待不代表撤销请求或退款。</p>
    {!handle?.handle && <p className="dictionary-warning">{handle ? handle.reason || '源文无法核验，请重新选择句子；本地阅读和草稿仍保留。' : '正在登记冻结源文；未核验前不能调用服务。'}</p>}
    {availability && !availability.configured && <p className="dictionary-warning">尚未配置可用翻译服务。{onOpenSettings ? <button type="button" onClick={onOpenSettings}>打开服务设置</button> : '请先在现有设置中配置服务。'}</p>}
    {invalidSelection && <p className="dictionary-warning">请加入连续完整字符的短语；原句最多2000、短语最多256个UTF-16单位，不会自动截断。</p>}
    <button type="button" className="primary-button dictionary-request" disabled={sending || run?.state === 'ready_unsaved' || (run?.state === 'persist_error' && Boolean(detail)) || !availability?.configured || !handle?.handle || invalidSelection} aria-busy={sending} onClick={() => void request()}>{encounterId ? '重新解释（再次调用服务）' : '解释这处用法（调用服务）'}</button>
    {run && <div className="dictionary-run" role="status"><p>{run.message}</p>{run.dispatchState === 'may_have_started' && <p>请求可能已发出并产生费用，无法确定；不会自动重试。</p>}</div>}
    {run && (run.state === 'waiting' || (run.state === 'persist_error' && detail)) && <button type="button" disabled={actionPending} onClick={() => void action(() => api.cancel(run.encounterId, run.attemptId))}>{run.state === 'persist_error' ? '结束这次等待' : '停止等待'}</button>}
    {run?.state === 'ready_unsaved' && <div className="dictionary-unsaved" role="alert"><p>结果仅在本次应用内存，退出会丢失。仅重试保存不会再次调用服务。</p><button type="button" disabled={actionPending} onClick={() => void action(() => api.retrySave(run.encounterId, run.attemptId))}>仅重试保存</button><button type="button" disabled={actionPending} onClick={() => void action(() => api.discardUnsaved(run.encounterId, run.attemptId))}>放弃未保存结果</button>{run.unsaved && <DictionaryExplanationView explanation={run.unsaved} />}</div>}
    {message && <p className="dictionary-error" role="alert">{message}</p>}
    {showResult && latest && <DictionaryExplanationView explanation={latest} />}
    {onOpenHistory && <button type="button" onClick={onOpenHistory}>查看独立学习历史</button>}
  </section></>
}

function OfflineInputLookup({ api, defaultLanguage, onBack }: { api: DictionaryAPI; defaultLanguage: TargetLanguage; onBack: () => void }) {
  const [text, setText] = useState(''), [language, setLanguage] = useState('')
  const [opened, setOpened] = useState<{ text: string; promise: Promise<DictionaryHandleResult> } | null>(null)
  const [phrase, setPhrase] = useState<Phrase | undefined>()
  const [start, setStart] = useState('0'), [end, setEnd] = useState('0')
  const [message, setMessage] = useState('')
  const paragraph = useRef<HTMLParagraphElement>(null), input = useRef<HTMLTextAreaElement>(null)
  const handle = useHandle(api, opened?.promise || null)
  useLayoutEffect(() => { if (opened) paragraph.current?.focus(); else input.current?.focus() }, [opened])
  const accept = (next: Phrase | null) => {
    if (!next || !opened || !validPhrase(opened.text, next) || next.exact.length > 256) { setMessage('请选择不超过 256 个UTF-16单位的连续完整短语。'); return }
    setPhrase(next); setStart(String(next.start)); setEnd(String(next.end)); setMessage('')
  }
  return <section className="dictionary-input-lookup">
    <h3 className="dictionary-lookup-heading" tabIndex={-1}>输入原句，离线查词</h3>
    <button type="button" onClick={onBack}>返回学习历史</button>
    {!opened ? <form onSubmit={event => {
      event.preventDefault()
      if (!api.openInput || !text.trim() || !language.trim()) return
      const promise = api.openInput({ text, language: language.trim() })
      setOpened({ text, promise }); setMessage('')
      const initial = { start: 0, end: text.length, exact: text }
      setPhrase(text.length <= 256 && validPhrase(text, initial) ? initial : undefined); setStart('0'); setEnd(text.length <= 256 ? String(text.length) : '0')
    }}><label>原句或单词<textarea ref={input} aria-label="离线查词原句" maxLength={2000} value={text} onChange={event => setText(event.target.value)} placeholder="主动粘贴或输入；不需要翻译服务密钥" /></label><label>原文语言<input aria-label="离线输入原文语言" list="offline-input-languages" maxLength={35} value={language} onChange={event => setLanguage(event.target.value)} /></label><datalist id="offline-input-languages">{LANGUAGES.map(item => <option key={item.code} value={item.code}>{item.nativeName}</option>)}</datalist><button type="submit" disabled={!api.openInput || !text.trim() || !language.trim()}>开始离线查词</button></form> : <>
      <button type="button" onClick={() => { setOpened(null); setPhrase(undefined); setMessage('') }}>修改原句</button>
      <p ref={paragraph} className="dictionary-source" dir="auto" tabIndex={0} aria-label="离线冻结原句，可选择连续短语">{opened.text}</p>
      <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => accept(paragraph.current ? selectedPhrase(paragraph.current, opened.text, window.getSelection()) : null)}>采用所选原文短语</button>
      <fieldset className="study-range"><legend>连续短语范围（UTF-16 起点含、终点不含）</legend><label>起点<input aria-label="离线短语起点" type="number" min="0" max={opened.text.length} value={start} onChange={event => setStart(event.target.value)} /></label><label>终点<input aria-label="离线短语终点" type="number" min="0" max={opened.text.length} value={end} onChange={event => setEnd(event.target.value)} /></label><button type="button" onClick={() => accept({ start: Number(start), end: Number(end), exact: opened.text.slice(Number(start), Number(end)) })}>采用此范围</button></fieldset>
      {!handle?.handle && <p role="status">{handle?.reason || '正在打开本机原句。'}</p>}
      <OfflinePhraseLookup api={api} handle={handle} source={opened.text} phrase={phrase} defaultLanguage={defaultLanguage} onOpenHistory={onBack} />
    </>}
    {message && <p className="dictionary-error" role="alert">{message}</p>}
  </section>
}

export default function DictionaryPanel({ api, defaultLanguage, onClose, onOpenSettings }: { api: DictionaryAPI; defaultLanguage: TargetLanguage; onClose: () => void; onOpenSettings?: () => void }) {
  const [mode, setMode] = useState<'history' | 'detail' | 'review' | 'packs' | 'lookup'>('history')
  const [page, setPage] = useState<DictionaryPage>(emptyPage)
  const [query, setQuery] = useState<DictionaryQuery>({ page: 1, pageSize: 20, incomplete: false })
  const [detail, setDetail] = useState<DictionaryDetail | null>(null)
  const [handlePromise, setHandlePromise] = useState<Promise<DictionaryHandleResult> | null>(null)
  const [selectedVersion, setSelectedVersion] = useState('')
  const [note, setNote] = useState('')
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [confirmation, setConfirmation] = useState<'leave' | 'delete' | null>(null)
  const [review, setReview] = useState<DictionaryReviewSession | null>(null)
  const [revealed, setRevealed] = useState<{ revealId: string; explanation: DictionaryExplanation } | null>(null)
  const alive = useRef(true), composing = useRef(false), busy = useRef(false)
  const selectedId = useRef<string | null>(null), listGeneration = useRef(0), detailGeneration = useRef(0)
  const leaveAction = useRef<() => void>(() => {}), reviewRef = useRef<DictionaryReviewSession | null>(null)
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const modeRef = useRef(mode); modeRef.current = mode
  const returnFocus = useRef<HTMLElement | null>(null)
  const returnControl = useRef<'packs' | 'lookup' | null>(null)
  const confirmationFocus = useRef<HTMLElement | null>(null)
  const lastConfirmation = useRef(false)
  const confirm = (kind: 'leave' | 'delete') => { confirmationFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirmation(kind) }
  reviewRef.current = review
  const setFilter = (next: Partial<DictionaryQuery>) => setQuery(previous => ({ ...previous, ...next, page: 1 }))
  const local = async (operation: () => Promise<void>, success?: string) => {
    if (busy.current) return false
    busy.current = true; setPending(true); setMessage('')
    try { await operation(); if (alive.current) { if (success) setMessage(success); return true } }
    catch (error) { if (alive.current) setMessage(errorText(error)) }
    finally { if (alive.current) { busy.current = false; setPending(false) } }
    return false
  }
  const releaseCurrentHandle = () => { const value = handlePromise; if (value) void value.then(result => { if (result.handle) return api.release(result.handle) }).catch(() => {}); setHandlePromise(null) }
  const attempt = (operation: () => void) => {
    if (busy.current) { setMessage('正在写入，请稍候。'); return }
    if (dirtyRef.current) { leaveAction.current = operation; confirm('leave') }
    else operation()
  }
  const history = () => attempt(() => {
    if (reviewRef.current) void api.endReview(reviewRef.current.sessionId).catch(() => {})
    reviewRef.current = null; setReview(null); setRevealed(null); releaseCurrentHandle(); selectedId.current = null; detailGeneration.current++; setDetail(null); setMode('history'); setMessage('')
  })
  const close = () => attempt(() => { if (reviewRef.current) void api.endReview(reviewRef.current.sessionId).catch(() => {}); releaseCurrentHandle(); onClose() })
  const actionsRef = useRef<{ close: () => void; history: () => void; cancelConfirmation: () => boolean }>({ close, history, cancelConfirmation: () => false }); actionsRef.current = { close, history, cancelConfirmation: () => { if (!confirmation) return false; setConfirmation(null); return true } }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; listGeneration.current++; detailGeneration.current++; if (reviewRef.current) void api.endReview(reviewRef.current.sessionId).catch(() => {}) }
  }, [api])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || composing.current || event.keyCode === 229) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (actionsRef.current.cancelConfirmation()) return
      if (modeRef.current === 'review' || modeRef.current === 'packs' || modeRef.current === 'lookup') actionsRef.current.history(); else actionsRef.current.close()
    }
    const begin = () => { composing.current = true }, finish = () => { composing.current = false }
    window.addEventListener('keydown', keyboard, true); window.addEventListener('compositionstart', begin); window.addEventListener('compositionend', finish)
    return () => { window.removeEventListener('keydown', keyboard, true); window.removeEventListener('compositionstart', begin); window.removeEventListener('compositionend', finish) }
  }, [])
  useLayoutEffect(() => {
    if (mode === 'history' && returnControl.current) {
      document.querySelector<HTMLElement>(`[data-dictionary-return="${returnControl.current}"]`)?.focus(); returnControl.current = null
    } else if (mode === 'history' && returnFocus.current?.isConnected) returnFocus.current.focus()
    else document.querySelector<HTMLElement>(mode === 'history' ? '.dictionary-query' : mode === 'review' ? '.dictionary-review-prompt' : mode === 'packs' ? '.dictionary-packs-heading' : mode === 'lookup' ? '.dictionary-lookup-heading' : '.dictionary-detail-heading')?.focus()
  }, [mode, detail?.encounter.id])
  useEffect(() => {
    if (confirmation) { lastConfirmation.current = true; document.querySelector<HTMLElement>('.dictionary-confirm button')?.focus() }
    else if (lastConfirmation.current) {
      lastConfirmation.current = false
      const target = confirmationFocus.current
      if (target?.isConnected && !target.matches(':disabled') && !target.closest('[inert]')) target.focus()
      else document.querySelector<HTMLElement>('.dictionary-detail-heading, .dictionary-query')?.focus()
    }
  }, [confirmation])
  useEffect(() => {
    if (mode !== 'history') return
    const refresh = () => {
      const version = ++listGeneration.current
      void api.list(query).then(value => { if (alive.current && version === listGeneration.current && modeRef.current === 'history') setPage(value) }).catch(error => { if (alive.current && version === listGeneration.current) setMessage(errorText(error)) })
    }
    refresh(); const off = api.onChanged(refresh)
    return () => { listGeneration.current++; off() }
  }, [api, query, mode])
  useEffect(() => {
    if (mode !== 'detail' || !selectedId.current) return
    const refresh = () => {
      const id = selectedId.current!, version = ++detailGeneration.current
      void api.get(id).then(value => {
        if (!alive.current || version !== detailGeneration.current || selectedId.current !== id || modeRef.current !== 'detail') return
        if (!value) { releaseCurrentHandle(); setDetail(null); setMode('history'); setMessage('这条学习记录已删除。'); return }
        setDetail(value); if (!dirtyRef.current) setNote(value.encounter.note)
      }).catch(error => { if (alive.current && version === detailGeneration.current) setMessage(errorText(error)) })
    }
    refresh(); const off = api.onChanged(refresh)
    return () => { detailGeneration.current++; off() }
  }, [api, mode, detail?.encounter.id])
  useEffect(() => {
    if (mode !== 'review' || !review) return
    const sessionId = review.sessionId
    let active = true, order = 0
    const off = api.onChanged(() => { const sequence = ++order; void api.reviewState(sessionId).then(next => {
      if (!active || sequence !== order || !alive.current || modeRef.current !== 'review') return
      const card = next.cards[next.cursor]
      setReview(next); setRevealed(previous => previous?.explanation.explanationId === card?.explanationId ? previous : null)
    }).catch(error => { if (active) setMessage(errorText(error)) }) })
    return () => { active = false; off() }
  }, [api, mode, review?.sessionId])
  const open = (encounter: DictionaryEncounter) => attempt(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const opening = api.openEncounter(encounter.id)
    selectedId.current = encounter.id; detailGeneration.current++; setDetail({ encounter: structuredClone(encounter), run: null }); setHandlePromise(opening)
    setNote(encounter.note); setDirty(false); setSelectedVersion(encounter.explanations.at(-1)?.explanationId || ''); setMode('detail'); setMessage('')
  })
  const changeFavorite = (encounter: DictionaryEncounter) => void local(() => api.edit(encounter.id, { favorite: !encounter.favorite }))
  const exportFile = (format: 'json' | 'markdown') => void local(async () => { const result = await api.export(format); if (alive.current) setMessage(result.message || (result.saved ? '学习历史已导出。' : '导出已取消。')) })
  const startReview = () => attempt(() => { void local(async () => { const session = await api.startReview(); if (alive.current) { setReview(session); setRevealed(null); setMode('review') } }) })
  const reviewAction = (operation: () => Promise<DictionaryReviewSession>) => void local(async () => { const next = await operation(); if (alive.current) { setReview(next); setRevealed(null) } })
  const card = review?.cards[review.cursor]
  const explanation = detail?.encounter.explanations.find(value => value.explanationId === selectedVersion) || detail?.encounter.explanations.at(-1)
  return <div className="dictionary-workspace">
    <div className="panel-heading"><h2>{mode === 'review' ? '复习收藏' : mode === 'packs' ? '离线语言包' : mode === 'lookup' ? '离线查词' : '个人学习历史'}</h2><button type="button" aria-label="关闭学习历史" onClick={close}>关闭</button></div>
    {confirmation && <div className="dictionary-confirm" role="alert"><p>{confirmation === 'delete' ? '删除此学习条目及其解释、尝试和复习记录；未保存笔记或仅内存结果也会丢失。不会改变旧字幕收藏。' : '查词笔记尚未保存。继续编辑，或明确放弃后离开。'}</p><button type="button" onClick={() => setConfirmation(null)}>{confirmation === 'delete' ? '取消删除' : '继续编辑'}</button><button type="button" onClick={() => {
      if (confirmation === 'delete' && detail) { const id = detail.encounter.id; setConfirmation(null); void local(async () => { try { await api.remove(id) } catch (error) { throw new Error(`未删除：${errorText(error)}`) }; if (alive.current) { setDirty(false); dirtyRef.current = false; releaseCurrentHandle(); selectedId.current = null; setDetail(null); setMode('history'); setMessage('学习条目已删除；旧字幕收藏保留。') } }) }
      else { setConfirmation(null); setDirty(false); dirtyRef.current = false; leaveAction.current() }
    }}>{confirmation === 'delete' ? '确定删除学习条目' : '放弃查词笔记并离开'}</button></div>}
    {message && <p className="dictionary-error" role="status">{message}</p>}
    {mode === 'history' && <section className="dictionary-history">
      <p>独立保存在本机的查词、解释与复习记录。与旧字幕收藏／会话匣分别管理；取消旧收藏不会删除这里的原句。</p>
      <div className="dictionary-toolbar">{api.openInput && api.offlineLookup && <button type="button" data-dictionary-return="lookup" onClick={() => { returnControl.current = 'lookup'; setMode('lookup') }}>离线查词</button>}{api.packs && <button type="button" data-dictionary-return="packs" onClick={() => { returnControl.current = 'packs'; setMode('packs') }}>管理语言包</button>}</div>
      <div className="dictionary-toolbar"><button type="button" disabled={pending} onClick={startReview}>复习收藏</button><button type="button" disabled={pending} onClick={() => exportFile('json')}>导出词典 JSON</button><button type="button" disabled={pending} onClick={() => exportFile('markdown')}>导出学习 Markdown</button></div>
      <label>查找原词、原句、释义或笔记<input className="dictionary-query" type="search" aria-label="学习历史查找" maxLength={500} value={query.query || ''} onChange={event => setFilter({ query: event.target.value })} /></label>
      <div className="dictionary-filters"><label>原文语言<input aria-label="筛选原文语言" maxLength={80} value={query.language || ''} onChange={event => setFilter({ language: event.target.value || undefined })} /></label><label>来源<select aria-label="筛选来源" value={query.provenance || ''} onChange={event => setFilter({ provenance: (event.target.value || undefined) as DictionaryQuery['provenance'] })}><option value="">全部来源</option><option value="main-verified">应用内核对源文</option><option value="saved-favorite">旧字幕收藏</option><option value="user-input">用户输入</option></select></label><label><input type="checkbox" aria-label="只看收藏" checked={query.favorite === true} onChange={event => setFilter({ favorite: event.target.checked ? true : undefined })} />只看收藏</label><label><input type="checkbox" aria-label="显示未完成" checked={query.incomplete === true} onChange={event => setFilter({ incomplete: event.target.checked })} />未完成</label></div>
      {query.incomplete && <p>尚无已保存解释、收藏或笔记的查询意图。删除须明确操作，不会自动淘汰。</p>}
      {page.warning && <p className="dictionary-warning" role="alert">{page.warning}</p>}
      <div className="dictionary-history-list">{page.items.map(encounter => <article key={encounter.id} data-encounter-id={encounter.id}><button type="button" className="dictionary-open" onClick={() => open(encounter)}><strong dir="auto">{encounter.source.span.exact}</strong><p dir="auto">{encounter.source.text}</p><small>{encounter.source.language} · {encounter.explanations.length} 个已保存解释 · {encounter.favorite ? '已收藏' : '未收藏'}</small>{encounter.note && <p className="dictionary-note-preview">笔记：{Array.from(encounter.note).slice(0, 80).join('')}</p>}</button><button type="button" aria-label="收藏学习条目" aria-pressed={encounter.favorite} disabled={pending || Boolean(page.warning)} onClick={() => changeFavorite(encounter)}>{encounter.favorite ? '取消学习收藏' : '收藏学习条目'}</button></article>)}{!page.items.length && <p className="dictionary-empty">没有符合条件的学习记录。请在句子详情中选择短语并显式解释。</p>}</div>
      <div className="dictionary-pages"><button type="button" aria-label="上一页" disabled={page.page <= 1} onClick={() => setQuery(previous => ({ ...previous, page: Math.max(1, page.page - 1) }))}>上一页</button><output>{page.page} / {Math.max(1, Math.ceil(page.total / page.pageSize))} · {page.total} 条</output><button type="button" aria-label="下一页" disabled={page.page * page.pageSize >= page.total} onClick={() => setQuery(previous => ({ ...previous, page: page.page + 1 }))}>下一页</button></div>
    </section>}
    {mode === 'packs' && api.packs && <OfflinePacksPanel api={api.packs} onBack={history} />}
    {mode === 'lookup' && <OfflineInputLookup api={api} defaultLanguage={defaultLanguage} onBack={history} />}
    {mode === 'detail' && detail && <section className="dictionary-detail" data-encounter-id={detail.encounter.id}>
      <h3 className="dictionary-detail-heading" tabIndex={-1}>结构化词条与查词笔记</h3><button type="button" onClick={history}>返回学习历史</button><SourceView source={detail.encounter.source} />
      <div className="dictionary-toolbar"><button type="button" aria-label="收藏学习条目" aria-pressed={detail.encounter.favorite} disabled={pending || Boolean(page.warning)} onClick={() => changeFavorite(detail.encounter)}>{detail.encounter.favorite ? '取消学习收藏' : '收藏学习条目'}</button><button type="button" disabled={pending} onClick={() => confirm('delete')}>删除学习条目</button></div>
      <label>查词笔记<textarea aria-label="查词笔记" maxLength={4000} value={note} disabled={pending || Boolean(page.warning)} onChange={event => { setNote(event.target.value); setDirty(true); dirtyRef.current = true }} /></label><button type="button" disabled={!dirty || pending || Boolean(page.warning)} onClick={() => { const id = detail.encounter.id, value = note; void local(async () => { await api.edit(id, { note: value }); if (alive.current && selectedId.current === id) { setDirty(false); dirtyRef.current = false } }, '查词笔记已保存。') }}>保存查词笔记</button>
      {detail.encounter.explanations.length > 0 && <label>已保存解释版本<select aria-label="已保存解释版本" value={explanation?.explanationId || ''} onChange={event => setSelectedVersion(event.target.value)}>{detail.encounter.explanations.map(value => <option key={value.explanationId} value={value.explanationId}>版本 {value.version} · {new Date(value.createdAt).toLocaleString()}</option>)}</select></label>}
      {explanation && <DictionaryExplanationView explanation={explanation} />}
      <PhraseExplanation api={api} handlePromise={handlePromise} source={detail.encounter.source.text} phrases={[detail.encounter.source.span]} defaultLanguage={defaultLanguage} encounterId={detail.encounter.id} showResult={false} onOpenSettings={onOpenSettings ? () => attempt(onOpenSettings) : undefined} />
      <div className="dictionary-attempts"><h4>尝试记录</h4>{detail.encounter.attempts.map(value => <p key={value.id}>{attemptLabels[value.status]} · {value.dispatchState === 'may_have_started' ? '可能已发出／计费，无法确定' : '本请求尚未发出'}</p>)}</div>
    </section>}
    {mode === 'review' && review && <section className="dictionary-review">
      <button type="button" onClick={history}>返回学习历史</button><p>本次自评 {review.completed} 条（个人记录）。查看、揭示和跳过不计自评，不代表掌握或记忆率。</p>
      {card ? <><div className="dictionary-review-prompt" tabIndex={-1} aria-label="回忆原句中的短语"><SourceView source={card.source} /></div>{!revealed ? <button type="button" disabled={pending} onClick={() => void local(async () => { const value = await api.reveal(review.sessionId, card.encounterId, card.explanationId); if (alive.current && modeRef.current === 'review') setRevealed(value) })}>揭示已保存解释</button> : <><DictionaryExplanationView explanation={revealed.explanation} /><div className="dictionary-toolbar"><button type="button" disabled={pending} onClick={() => reviewAction(() => api.rate(review.sessionId, revealed.revealId, 'recalled'))}>记起了</button><button type="button" disabled={pending} onClick={() => reviewAction(() => api.rate(review.sessionId, revealed.revealId, 'not_recalled'))}>没记起</button></div></>}<button type="button" disabled={pending} onClick={() => reviewAction(() => api.skip(review.sessionId))}>跳过</button></> : <p>本次列表已结束；没有更多可用的已收藏词条。</p>}
      <button type="button" disabled={pending || !review.lastEventId} onClick={() => { if (review.lastEventId) reviewAction(() => api.undo(review.sessionId, review.lastEventId!)) }}>撤销本次自评</button>
    </section>}
  </div>
}
