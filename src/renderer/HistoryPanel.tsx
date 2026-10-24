import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, Bookmark, Search, X } from 'lucide-react'
import type { Caption, Settings } from '../shared/types'
import { DEFAULT_LANGUAGES, languageInfo } from '../shared/languages'
import { alignedOriginal, preferredTranslation } from './caption-text'
import { historySelection, nextHistorySelection, searchHistory } from './history-search'

type Props = {
  captions: Caption[]
  settings: Settings
  filter: 'all' | 'saved'
  focusVersion: number
  onFilter: (filter: 'all' | 'saved') => void
  onSelect: (caption: Caption) => void
  onSave: (caption: Caption) => void
  onExport: () => void
  exporting: boolean
  exportResult: { text: string; error: boolean } | null
}
const sourceNames = { system: '电脑声音', microphone: '麦克风', text: '文字输入' }
const timeText = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

export default function HistoryPanel({ captions, settings, filter, focusVersion, onFilter, onSelect, onSave, onExport, exporting, exportResult }: Props) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [navigationVersion, setNavigationVersion] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const lastFocusVersion = useRef(focusVersion)
  const list = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const composing = useRef(false)
  const searching = Boolean(query.trim())
  const results = useMemo(() => searchHistory(captions, query, filter === 'saved'), [captions, query, filter])
  const activeId = searching ? historySelection(results, selectedId) : null
  const activeIndex = results.findIndex(result => result.caption.id === activeId)
  const targets = settings.targetLanguages || DEFAULT_LANGUAGES

  // The dialog owns initial focus/restore; repeated Find shortcuts only refocus this input.
  useEffect(() => {
    if (lastFocusVersion.current === focusVersion) return
    lastFocusVersion.current = focusVersion
    input.current?.focus(); input.current?.select()
  }, [focusVersion])
  useEffect(() => { setSelectedId(activeId) }, [activeId])
  const rememberAnchor = () => {
    const surface = list.current
    if (!surface) return
    const bounds = surface.getBoundingClientRect()
    const rows = [...surface.querySelectorAll<HTMLElement>('[data-history-id]')]
    const selected = rows.find(element => element.dataset.historyId === activeId)
    const position = selected?.getBoundingClientRect()
    const row = selected && position && position.bottom > bounds.top && position.top < bounds.bottom ? selected :
      rows.find(element => element.getBoundingClientRect().bottom > bounds.top + 1)
    anchor.current = row ? { id: row.dataset.historyId!, offset: row.getBoundingClientRect().top - bounds.top } : null
  }
  useLayoutEffect(() => {
    const surface = list.current
    const previous = anchor.current
    if (surface && previous) {
      const row = [...surface.querySelectorAll<HTMLElement>('[data-history-id]')].find(element => element.dataset.historyId === previous.id)
      if (row) surface.scrollTop += row.getBoundingClientRect().top - surface.getBoundingClientRect().top - previous.offset
    }
    rememberAnchor()
  }, [results])
  // Scroll only for a reader action. An arriving segment/translation must not move the selection.
  useLayoutEffect(() => {
    const surface = list.current
    if (!surface) return
    const row = [...surface.querySelectorAll<HTMLElement>('[data-history-id]')].find(element => element.dataset.historyId === activeId)
    if (!row) { if (!searching) surface.scrollTop = 0; rememberAnchor(); return }
    const bounds = surface.getBoundingClientRect()
    const position = row.getBoundingClientRect()
    if (position.top < bounds.top) surface.scrollTop += position.top - bounds.top
    else if (position.bottom > bounds.bottom) surface.scrollTop += position.bottom - bounds.bottom
    rememberAnchor()
  }, [query, filter, navigationVersion])

  const navigate = (direction: 1 | -1) => {
    setSelectedId(nextHistorySelection(results, activeId, direction))
    setNavigationVersion(value => value + 1)
  }
  const clear = () => { anchor.current = null; setQuery(''); setSelectedId(null); input.current?.focus() }

  return <>
    <div className="history-toolbar">
      <div className="history-tabs">
        <button className={filter === 'all' ? 'selected' : ''} aria-pressed={filter === 'all'} onClick={() => { anchor.current = null; onFilter('all') }}>全部 <span>{captions.length}</span></button>
        <button className={filter === 'saved' ? 'selected' : ''} aria-pressed={filter === 'saved'} onClick={() => { anchor.current = null; onFilter('saved') }}>学习收藏 <span>{captions.filter(caption => caption.saved).length}</span></button>
      </div>
      <button className="text-button" disabled={!captions.some(caption => caption.saved)} aria-disabled={exporting || undefined} aria-busy={exporting} onClick={onExport}><ArrowDownToLine size={13} />{exporting ? '正在导出…' : '导出收藏'}</button>
    </div>
    {exportResult && <div className={`history-export-result ${exportResult.error ? 'panel-notice' : 'history-search-hint'}`} role={exportResult.error ? 'alert' : 'status'}>{exportResult.text}</div>}
    <div className="history-search">
      <Search size={14} aria-hidden="true" />
      <input ref={input} type="search" className="history-search-input" aria-label="查找历史原文与已有译文" placeholder="查找原文与已有译文" value={query} maxLength={500} onChange={event => { anchor.current = null; setQuery(event.target.value); setSelectedId(null) }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return
        if (event.key === 'Enter' && searching) { event.preventDefault(); navigate(event.shiftKey ? -1 : 1) }
      }} />
      {query && <button type="button" aria-label="清空查找" onClick={clear}><X size={13} /></button>}
      <output className="history-search-count" aria-live="polite">{searching ? `${activeIndex + 1} / ${results.length}` : `${results.length} 条`}</output>
      <button type="button" title="上一个匹配（Shift+Enter）" aria-label="上一个匹配" disabled={!searching || results.length < 2} onClick={() => navigate(-1)}><ArrowUp size={13} /></button>
      <button type="button" title="下一个匹配（Enter）" aria-label="下一个匹配" disabled={!searching || results.length < 2} onClick={() => navigate(1)}><ArrowDown size={13} /></button>
    </div>
    <p className="history-search-hint">仅查找本机已保留的内容 · Enter / Shift+Enter 切换匹配 · 点击段落回看</p>
    <div className="history-list" ref={list} onScroll={rememberAnchor}>
      {results.map(({ caption, match }) => <div className={`history-item ${caption.id === activeId ? 'history-match-current' : ''}`} data-history-id={caption.id} key={caption.id}>
        <button className="history-select" aria-current={caption.id === activeId ? 'true' : undefined} onClick={() => onSelect(caption)}>
          <span className="history-item-meta">{timeText(caption.createdAt)} · {sourceNames[caption.source]}{caption.live || caption.translationPending ? ' · 实时更新' : caption.status === 'translating' ? ' · 翻译中' : caption.status === 'error' ? ' · 待重试' : ''}</span>
          {match && <span className="history-match-language">{match.language === 'original' ? '原文' : languageInfo(match.language).nativeName}匹配</span>}
          <span className="history-original" dir="auto">{match?.text || preferredTranslation(caption, targets) || (settings.showOriginal ? alignedOriginal(caption) : '所选语言尚未生成')}</span>
          {settings.showOriginal && (match ? match.language !== 'original' : preferredTranslation(caption, targets)) && <span className="history-translation" dir="auto">{alignedOriginal(caption)}</span>}
        </button>
        <button type="button" className={`icon-button ${caption.saved ? 'active' : ''}`} title={caption.saved ? '取消收藏' : '收藏'} aria-label={caption.saved ? '取消收藏' : '收藏'} aria-pressed={caption.saved} disabled={caption.status !== 'ready' || caption.live || caption.translationPending} onClick={() => onSave(caption)}><Bookmark size={14} fill={caption.saved ? 'currentColor' : 'none'} /></button>
      </div>)}
      {!results.length && <div className="empty-history">{searching ? <Search size={24} strokeWidth={1.3} /> : <Bookmark size={24} strokeWidth={1.3} />}<p>{searching ? '没有匹配的原文或已有译文，试试其他文字。' : filter === 'saved' ? '值得再读一遍的句子，就收藏在这里。' : '开始聆听或输入文字后，对照字幕会出现在这里。'}</p>{searching && <button className="text-button" onClick={clear}>清空查找</button>}</div>}
    </div>
  </>
}
