import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, ChevronUp, Contrast, Headphones, History, Keyboard, Languages, LoaderCircle, Mic, Monitor, Pause, Pin, Play, Settings2, X } from 'lucide-react'
import type { Caption, CaptureMode, Settings, SettingsInput, Snapshot } from '../shared/types'
import { DEFAULT_LANGUAGES, languageInfo, validTargetLanguages } from '../shared/languages'
import { listMicrophones, startMicrophone, type MicrophoneDevice } from './microphone'
import { platformLabels, type DesktopPlatform } from '../shared/platform'
import LanguageSettings from './LanguageSettings'
import CaptionStream from './CaptionStream'
import CompactCaption from './CompactCaption'
import HistoryPanel from './HistoryPanel'
import { alignedOriginal, incomingText, translationFor } from './caption-text'
import type { ReadingSession } from './reading-schedule'

const defaults: Settings = {
  targetLanguages: [...DEFAULT_LANGUAGES], showOriginal: true, showFurigana: true,
  captureMode: 'system', microphoneDeviceId: 'default', alwaysOnTop: true, opacity: 0.94, fontSize: 16, launchAtLogin: false,
  asrModel: 'qwen-audio-3.1-asr-flash-streaming', asrEndpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
  translationBaseUrl: 'https://api.deepseek.com', translationModel: 'deepseek-flash',
  hasAsrKey: false, hasTranslationKey: false,
}
const blankSnapshot: Snapshot = { settings: defaults, state: 'idle', message: '', captions: [], partial: {}, collapsed: false }
const example: Caption = {
  id: 'preview-only', source: 'text', original: 'Small steps every day lead to remarkable changes.', language: 'English',
  zh: '每天的一小步，会带来非凡的改变。', en: 'Small steps every day lead to remarkable changes.',
  ja: '毎日の小さな一歩が、大きな変化につながる。', reading: 'まいにちの ちいさな いっぽが、おおきな へんかに つながる。',
  jaSegments: [{ text: '毎日', reading: 'まいにち' }, { text: 'の' }, { text: '小', reading: 'ちい' }, { text: 'さな' }, { text: '一歩', reading: 'いっぽ' }, { text: 'が、' }, { text: '大', reading: 'おお' }, { text: 'きな' }, { text: '変化', reading: 'へんか' }, { text: 'につながる。' }],
  translations: {
    zh: '每天的一小步，会带来非凡的改变。', 'zh-Hant': '每天的一小步，會帶來非凡的改變。',
    en: 'Small steps every day lead to remarkable changes.', ja: '毎日の小さな一歩が、大きな変化につながる。',
    ko: '매일의 작은 발걸음이 놀라운 변화를 만들어 냅니다.', fr: 'De petits pas chaque jour mènent à des changements remarquables.',
    de: 'Kleine Schritte jeden Tag führen zu bemerkenswerten Veränderungen.', es: 'Los pequeños pasos de cada día llevan a cambios extraordinarios.',
    pt: 'Pequenos passos todos os dias levam a mudanças extraordinárias.', it: 'Piccoli passi ogni giorno portano a cambiamenti straordinari.',
    ru: 'Маленькие шаги каждый день приводят к удивительным переменам.', ar: 'الخطوات الصغيرة كل يوم تؤدي إلى تغييرات كبيرة.',
    hi: 'हर दिन छोटे कदम बड़े बदलाव लाते हैं।', th: 'ก้าวเล็ก ๆ ในทุกวันนำไปสู่การเปลี่ยนแปลงที่ยิ่งใหญ่',
    vi: 'Những bước nhỏ mỗi ngày dẫn đến những thay đổi đáng kể.', id: 'Langkah kecil setiap hari membawa perubahan luar biasa.',
    tr: 'Her gün atılan küçük adımlar büyük değişimlere yol açar.', nl: 'Elke dag kleine stappen zetten leidt tot opmerkelijke veranderingen.',
    pl: 'Małe kroki każdego dnia prowadzą do niezwykłych zmian.', uk: 'Маленькі кроки щодня ведуть до дивовижних змін.',
  },
  createdAt: 0, status: 'ready', saved: false,
}
const exampleFollowUp: Caption = {
  ...example, id: 'preview-follow-up', original: 'Take your time. You can always scroll back and read it again.',
  zh: '慢慢来，你随时可以向上滚动，再读一遍。', en: 'Take your time. You can always scroll back and read it again.', ja: 'ゆっくりでいい。いつでも戻って、もう一度読める。',
  reading: 'ゆっくりでいい。いつでももどって、もういちどよめる。',
  jaSegments: [{ text: 'ゆっくりでいい。いつでも' }, { text: '戻', reading: 'もど' }, { text: 'って、もう' }, { text: '一度', reading: 'いちど' }, { text: '読', reading: 'よ' }, { text: 'める。' }],
  translations: {
    zh: '慢慢来，你随时可以向上滚动，再读一遍。', 'zh-Hant': '慢慢來，你隨時可以向上捲動，再讀一遍。',
    en: 'Take your time. You can always scroll back and read it again.', ja: 'ゆっくりでいい。いつでも戻って、もう一度読める。',
    ko: '천천히 읽으세요. 언제든 위로 스크롤해서 다시 읽을 수 있어요.', fr: 'Prenez votre temps. Vous pouvez toujours remonter pour relire.',
    de: 'Lass dir Zeit. Du kannst jederzeit zurückscrollen und noch einmal lesen.', es: 'Tómate tu tiempo. Siempre puedes volver atrás y leerlo de nuevo.',
    pt: 'Leia com calma. Você pode sempre voltar e ler novamente.', it: 'Prenditi il tuo tempo. Puoi sempre tornare indietro e rileggere.',
    ru: 'Не торопитесь. Можно прокрутить назад и прочитать ещё раз.', ar: 'خذ وقتك. يمكنك دائماً التمرير إلى الأعلى والقراءة مرة أخرى.',
    hi: 'आराम से पढ़ें। आप कभी भी पीछे जाकर दोबारा पढ़ सकते हैं।', th: 'ค่อย ๆ อ่าน คุณสามารถเลื่อนกลับไปอ่านอีกครั้งได้เสมอ',
    vi: 'Cứ từ từ. Bạn luôn có thể cuộn lên và đọc lại.', id: 'Baca perlahan. Anda selalu bisa menggulir ke atas dan membaca lagi.',
    tr: 'Acele etme. İstediğin zaman geri kaydırıp tekrar okuyabilirsin.', nl: 'Neem de tijd. Je kunt altijd terugscrollen en het opnieuw lezen.',
    pl: 'Nie spiesz się. Zawsze możesz przewinąć w górę i przeczytać ponownie.', uk: 'Не поспішайте. Можна прокрутити назад і прочитати ще раз.',
  },
}
const exampleStream = [example, exampleFollowUp]
const modeNames: Record<CaptureMode, string> = { system: '电脑声音', microphone: '麦克风', both: '电脑 + 麦克风' }
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'
function IconButton({ title, children, onClick, active, disabled, className = '' }: { title: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} title={title} aria-label={title} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(blankSnapshot)
  const [panel, setPanel] = useState<'settings' | 'history' | 'text' | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusVersion, setFocusVersion] = useState(0)
  const [preview, setPreview] = useState(false)
  const [readingEpoch, setReadingEpoch] = useState(0)
  const [busy, setBusy] = useState(false)
  const [captureAction, setCaptureAction] = useState<'start' | 'stop' | null>(null)
  const [notice, setNotice] = useState('')
  const [toast, setToast] = useState('')
  const [historyFilter, setHistoryFilter] = useState<'all' | 'saved'>('all')
  const [historyFocusVersion, setHistoryFocusVersion] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<{ text: string; error: boolean } | null>(null)
  const [input, setInput] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null)
  const opacityTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const opacityPending = useRef<number | null>(null)
  const opacityRevision = useRef(0)
  const microphoneStop = useRef<(() => void) | null>(null)
  const microphoneGeneration = useRef(0)
  const microphoneAbort = useRef<AbortController | null>(null)
  const captureOperation = useRef(0)
  const exportPending = useRef(false)
  const composing = useRef(false)
  const panelReturnFocus = useRef<{ element: HTMLElement | null; fallback: '设置' | '历史与收藏' | '输入文字翻译' } | null>(null)
  const readingSession = useRef<ReadingSession>({ clock: null, following: true, anchor: null })
  const readingPreview = useRef(false)
  if (readingPreview.current !== preview) {
    readingPreview.current = preview
    readingSession.current = { clock: null, following: true, anchor: null }
  }
  const api = window.lingo
  const platform = api?.platform || 'other'
  const labels = platformLabels(platform)
  const developmentPreview = !api && Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) && new URLSearchParams(location.search).get('preview') === '1'
  const available = Boolean(api) || developmentPreview

  function rememberPanelFocus(fallback: '设置' | '历史与收藏' | '输入文字翻译') {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A shortcut can replace the current dialog. Keep its outside invoker,
    // rather than a textarea/control that is about to be unmounted.
    if (active?.closest('.panel') && panelReturnFocus.current) return
    panelReturnFocus.current = { element: active === document.body ? null : active, fallback }
  }

  useEffect(() => {
    if (!api) return
    let active = true
    let receivedSnapshot = false
    let captureActive = false
    const apply = (next: Snapshot) => {
      if (!active) return
      const nextCaptureActive = next.state === 'starting' || next.state === 'listening'
      if (nextCaptureActive && !captureActive) {
        readingSession.current = { clock: null, following: true, anchor: null }
        setReadingEpoch(value => value + 1)
        setSelectedId(null)
        setPreview(false)
      }
      captureActive = nextCaptureActive
      setSnapshot(next)
      if (next.state !== 'listening' && next.state !== 'starting') {
        microphoneGeneration.current++
        microphoneAbort.current?.abort()
        microphoneAbort.current = null
        microphoneStop.current?.()
        microphoneStop.current = null
      }
    }
    const unsubscribeSnapshot = api.onSnapshot(next => { receivedSnapshot = true; apply(next) })
    void api.getSnapshot().then(next => { if (!receivedSnapshot) apply(next) }).catch(error => { if (active) setNotice(errorText(error)) })
    const unsubscribeMicrophone = api.onMicrophone((enabled, run, deviceId) => {
      const generation = ++microphoneGeneration.current
      microphoneAbort.current?.abort()
      microphoneAbort.current = null
      microphoneStop.current?.()
      microphoneStop.current = null
      if (!enabled) return
      const controller = new AbortController()
      microphoneAbort.current = controller
      void startMicrophone(chunk => {
        if (active && generation === microphoneGeneration.current) api.pushMicrophone(chunk, run)
      }, message => {
        if (!active || generation !== microphoneGeneration.current) return
        microphoneGeneration.current++
        microphoneAbort.current?.abort()
        microphoneAbort.current = null
        microphoneStop.current?.()
        microphoneStop.current = null
        setNotice(message)
        api.microphoneFailed(message, run)
      }, { deviceId, platform: api.platform, signal: controller.signal }).then(stop => {
        if (!active || generation !== microphoneGeneration.current) stop()
        else { microphoneStop.current = stop; api.microphoneReady(run) }
      }).catch(error => {
        if (!active || generation !== microphoneGeneration.current) return
        microphoneGeneration.current++
        const message = errorText(error)
        setNotice(message)
        api.microphoneFailed(message, run)
      })
    })
    return () => {
      active = false
      microphoneGeneration.current++
      microphoneAbort.current?.abort()
      microphoneAbort.current = null
      microphoneStop.current?.()
      microphoneStop.current = null
      unsubscribeSnapshot()
      unsubscribeMicrophone()
    }
  }, [api])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => () => { if (opacityTimer.current) clearTimeout(opacityTimer.current) }, [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || composing.current || event.keyCode === 229) return
      if (event.key === 'Escape') { setPanel(null); setNotice('') }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        rememberPanelFocus('历史与收藏')
        void (async () => {
          if (snapshot.collapsed) {
            if (api) await api.setCollapsed(false)
            else setSnapshot(value => ({ ...value, collapsed: false }))
          }
          setNotice('')
          setPanel('history')
          setHistoryFocusVersion(value => value + 1)
        })().catch(error => setNotice(errorText(error)))
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [api, snapshot.collapsed])

  useEffect(() => {
    if (selectedId && !snapshot.captions.some(caption => caption.id === selectedId)) setSelectedId(null)
  }, [selectedId, snapshot.captions])

  useEffect(() => {
    if (!panel) return
    const surface = document.querySelector<HTMLElement>('.panel')
    const focusable = () => [...surface?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') || []].filter(element => element.getClientRects().length > 0)
    const first = panel === 'text' ? surface?.querySelector<HTMLElement>('textarea') : panel === 'history' ? surface?.querySelector<HTMLElement>('.history-search-input') : focusable()[0]
    first?.focus()
    const keepFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const current = document.activeElement
      if (event.shiftKey && (current === items[0] || !surface?.contains(current))) { event.preventDefault(); items.at(-1)?.focus() }
      else if (!event.shiftKey && (current === items.at(-1) || !surface?.contains(current))) { event.preventDefault(); items[0].focus() }
    }
    window.addEventListener('keydown', keepFocus)
    return () => window.removeEventListener('keydown', keepFocus)
  }, [panel])

  useEffect(() => {
    if (panel || !panelReturnFocus.current) return
    const origin = panelReturnFocus.current
    panelReturnFocus.current = null
    const target = origin.element?.isConnected && !origin.element.closest('[inert]')
      ? origin.element : document.querySelector<HTMLElement>(`button[aria-label="${origin.fallback}"]`)
    target?.focus()
  }, [panel])

  const streamCaptions = preview ? exampleStream : snapshot.captions
  const listening = snapshot.state === 'listening'
  const starting = snapshot.state === 'starting' || captureAction === 'start'
  const configured = snapshot.settings.hasAsrKey && snapshot.settings.hasTranslationKey
  const partial = Object.entries(snapshot.partial).filter(([, text]) => text).map(([source, text]) => ({ source: source as 'system' | 'microphone', text }))
  const expandedPartial = partial.map(item => ({ ...item, text: incomingText(item.text, snapshot.captions.slice().reverse().find(caption => caption.live && caption.source === item.source)) })).filter(item => item.text)
  const targets = snapshot.settings.targetLanguages || DEFAULT_LANGUAGES

  async function run(action: () => Promise<unknown>, success?: string) {
    setNotice('')
    try { await action(); if (success) setToast(success) } catch (error) { setNotice(errorText(error)) }
  }
  async function exportSaved() {
    if (!api || exportPending.current) return
    exportPending.current = true
    setExporting(true)
    setExportResult(null)
    try {
      if (await api.exportSaved()) setExportResult({ text: '收藏已导出', error: false })
    } catch (error) {
      setExportResult({ text: `导出未完成：${errorText(error)}`, error: true })
    } finally {
      exportPending.current = false
      setExporting(false)
    }
  }
  async function toggleListening() {
    if (captureAction === 'stop') return
    if (!api) { setNotice('浏览器仅供界面预览，请在 LingoBar 应用中开始收音。'); return }
    if (!listening && !starting && !configured) {
      rememberPanelFocus('设置')
      if (snapshot.collapsed) await api.setCollapsed(false)
      setPanel('settings'); setNotice('先连接语音识别和翻译服务，就可以开始实时字幕。'); return
    }
    const operation = ++captureOperation.current
    const shouldStop = listening || starting
    setCaptureAction(shouldStop ? 'stop' : 'start')
    setNotice('')
    setPreview(false)
    setSelectedId(null)
    if (shouldStop) {
      microphoneGeneration.current++
      microphoneAbort.current?.abort()
      microphoneAbort.current = null
      microphoneStop.current?.()
      microphoneStop.current = null
    }
    try { if (shouldStop) await api.stop(); else await api.start() }
    catch (error) { if (operation === captureOperation.current) setNotice(errorText(error)) }
    finally { if (operation === captureOperation.current) setCaptureAction(null) }
  }
  async function copyCaption(current: Caption) {
    await run(async () => {
      const lines = snapshot.settings.showOriginal ? [`原文：${alignedOriginal(current)}`] : []
      for (const code of targets) lines.push(`${languageInfo(code).nativeName}：${translationFor(current, code) || '未生成'}`)
      if (targets.includes('ja') && snapshot.settings.showFurigana && current.jaSegments?.map(segment => segment.text).join('') === translationFor(current, 'ja')) {
        lines.push(`読み方：${current.jaSegments.map(segment => segment.reading || segment.text).join('')}`)
      }
      const text = lines.join('\n')
      if (api) await api.copyText(text)
      else await navigator.clipboard.writeText(text)
      setCopiedId(current.id)
      window.setTimeout(() => setCopiedId(value => value === current.id ? null : value), 1800)
    }, '多语对照已复制')
  }
  async function submitText(event: FormEvent) {
    event.preventDefault()
    if (composing.current || !input.trim() || busy) return
    if (!api) { setNotice('请在 LingoBar 应用中使用文字翻译。'); return }
    setBusy(true)
    setNotice('')
    try { await api.translateText(input.trim()); setInput(''); setPanel(null); setSelectedId(null); setPreview(false) } catch (error) { setNotice(errorText(error)) }
    setBusy(false)
  }
  const saveSettings = async (next: SettingsInput) => {
    if (!api) throw new Error('界面预览不保存设置，请在 LingoBar 应用中配置。')
    const settings = await api.saveSettings(next)
    setSnapshot(value => ({ ...value, settings }))
    return settings
  }
  const commitOpacity = () => {
    if (opacityTimer.current) { clearTimeout(opacityTimer.current); opacityTimer.current = null }
    const value = opacityPending.current
    if (value === null) return
    opacityPending.current = null
    const revision = opacityRevision.current
    void saveSettings({ opacity: value }).then(() => { if (revision === opacityRevision.current) setOpacityPreview(null) }).catch(error => {
      if (revision === opacityRevision.current) { setOpacityPreview(null); setNotice(errorText(error)) }
    })
  }
  const adjustOpacity = (value: number) => {
    opacityRevision.current++
    opacityPending.current = value
    setOpacityPreview(value)
    if (opacityTimer.current) clearTimeout(opacityTimer.current)
    opacityTimer.current = setTimeout(commitOpacity, 180)
  }
  const displayedOpacity = opacityPreview ?? snapshot.settings.opacity

  const windowControls = <div className="titlebar-actions">
        <label className="quick-opacity" title="透明度调节：向左更透明，松开后自动保存"><Contrast size={12} /><input type="range" aria-label="背景不透明度，越低越透明" min="0.45" max="1" step="0.01" value={displayedOpacity} onChange={event => adjustOpacity(Number(event.target.value))} onPointerUp={commitOpacity} onKeyUp={commitOpacity} onBlur={commitOpacity} /><output>{Math.round(displayedOpacity * 100)}%</output></label>
        {snapshot.collapsed && <IconButton title={listening || starting ? '暂停聆听' : '开始聆听'} onClick={() => void toggleListening()} disabled={captureAction === 'stop'}>{listening || starting ? <Pause size={14} /> : <Play size={14} />}</IconButton>}
        <IconButton title={snapshot.settings.alwaysOnTop ? '取消置顶' : '始终置顶'} active={snapshot.settings.alwaysOnTop} onClick={() => void run(() => saveSettings({ alwaysOnTop: !snapshot.settings.alwaysOnTop }))}><Pin size={14} /></IconButton>
        <IconButton title="设置" active={panel === 'settings'} onClick={() => void run(async () => { if (panel !== 'settings') rememberPanelFocus('设置'); if (snapshot.collapsed) { if (api) await api.setCollapsed(false); else setSnapshot(value => ({ ...value, collapsed: false })) } setPanel(panel === 'settings' ? null : 'settings') })}><Settings2 size={15} /></IconButton>
        <IconButton title={snapshot.collapsed ? '展开翻译条' : '收起翻译条'} onClick={() => void run(async () => { const collapsed = !snapshot.collapsed; if (api) await api.setCollapsed(collapsed); else setSnapshot(value => ({ ...value, collapsed })); setPanel(null) })}>{snapshot.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</IconButton>
        <IconButton title={`隐藏到${labels.residentArea}`} onClick={() => { if (api) void run(() => api.hide()); else setToast(`在应用中会隐藏到${labels.residentArea}`) }}><X size={15} /></IconButton>
      </div>

  if (!available) return <main className="unavailable"><span className="brand-mark">L</span><h1>LingoBar · 语伴</h1><p>请从 LingoBar 桌面应用打开，即可使用电脑声音与麦克风实时字幕。</p></main>

  return <main className={`app-shell ${snapshot.collapsed ? 'is-collapsed' : ''}`} onCompositionStartCapture={() => { composing.current = true }} onCompositionEndCapture={() => { composing.current = false }} style={{ '--caption-size': `${snapshot.settings.fontSize}px`, '--surface-opacity': displayedOpacity } as CSSProperties}>
    {!snapshot.collapsed && <header className="titlebar">
      <div className="brand"><span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span><span>LingoBar</span><span className="brand-chinese">语伴</span></div>

      {windowControls}
    </header>}

    {snapshot.collapsed && <CompactCaption controls={windowControls} key={`${preview ? 'preview' : 'live'}:${readingEpoch}`} captions={streamCaptions} settings={snapshot.settings} preview={preview} readingSession={readingSession.current} partial={partial} listening={listening} notice={notice || (snapshot.state === 'error' ? snapshot.message : '')} onRetry={caption => api && void run(() => api.retry(caption.id))} onReturnLive={() => setSelectedId(null)} />}

    {!snapshot.collapsed && <>
      <div className="capture-toolbar" inert={panel !== null}>
        <div className="source-selector" aria-label="音频来源">{(['system', 'microphone', 'both'] as CaptureMode[]).map(mode => <button key={mode} type="button" className={snapshot.settings.captureMode === mode ? 'selected' : ''} aria-pressed={snapshot.settings.captureMode === mode} disabled={busy || listening || starting} title={listening || starting ? '暂停后可以切换音源' : modeNames[mode]} onClick={() => void run(() => saveSettings({ captureMode: mode }))}>{mode === 'system' ? <Monitor size={13} /> : mode === 'microphone' ? <Mic size={13} /> : <AudioLines size={13} />}<span>{mode === 'both' ? '双音源' : modeNames[mode]}</span></button>)}</div>
        <div className={`listening-label ${listening ? 'on' : ''}`}><span className="status-dot" />{preview ? '示例预览' : starting ? '正在连接' : listening ? '正在聆听' : snapshot.state === 'error' ? '连接中断' : '已暂停'}</div>
        <button type="button" className={`listen-button ${listening ? 'listening' : ''}`} disabled={captureAction === 'stop'} onClick={() => void toggleListening()}>{starting || captureAction === 'stop' ? <LoaderCircle size={14} className="spin" /> : listening ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}<span>{captureAction === 'stop' ? '正在暂停' : listening || starting ? '暂停' : '开始聆听'}</span></button>
      </div>

      <section className="caption-stage stream-stage" aria-label="多语连续字幕" inert={panel !== null}>
        {streamCaptions.length > 0 ? <CaptionStream readingSession={readingSession.current} key={`${preview ? 'preview' : 'live'}:${readingEpoch}`} captions={streamCaptions} settings={snapshot.settings} preview={preview} focusId={selectedId} focusVersion={focusVersion} copiedId={copiedId} onCopy={caption => void copyCaption(caption)} onSave={caption => api && void run(() => api.toggleSaved(caption.id), caption.saved ? '已取消收藏' : '已加入学习收藏')} onRetry={caption => api && void run(() => api.retry(caption.id))} onReturnLive={() => setSelectedId(null)} /> : <div className="welcome"><div className={`welcome-icon ${listening ? 'is-listening' : ''}`}><Headphones size={24} strokeWidth={1.4} />{listening && <span className="sound-rings" />}</div><div className="welcome-copy"><div className="eyebrow">LISTEN. UNDERSTAND. LEARN.</div><h1>{listening ? '正在听，第一句就快来了。' : '把听见的，变成学会的。'}</h1><p>{listening ? `正在接收${modeNames[snapshot.settings.captureMode]}，说句话或播放一段音频。` : '电脑声音与麦克风，随时变成你选择的多语字幕。'}</p><div className="language-pills">{snapshot.settings.showOriginal && <span>原文</span>}{targets.map(code => <span key={code}>{languageInfo(code).nativeName}</span>)}</div></div><div className="welcome-actions"><button className="text-button" onClick={() => { setPreview(true); setSelectedId(null) }}>看看示例 <ArrowRight size={13} /></button><button className="text-button muted" onClick={() => { rememberPanelFocus('输入文字翻译'); setNotice(''); setPanel('text') }}><Keyboard size={13} />输入文字试试</button></div></div>}
      </section>
      {snapshot.settings.showOriginal && !preview && expandedPartial.length > 0 && <div className="partial-caption live-partial" inert={panel !== null} aria-live="off"><span className="partial-indicator" /><span className="partial-stage-label">正在听</span>{expandedPartial.map(item => <span key={item.source}><b>{item.source === 'microphone' ? '麦克风' : '电脑'}</b>{item.text}</span>)}</div>}

      {(notice || (snapshot.state === 'error' && snapshot.message)) && !panel && <div className="inline-notice" role="alert"><span>{notice || snapshot.message}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={12} /></button></div>}
      <footer className="bottom-bar" inert={panel !== null}>
        <div className="stream-footer-note">{preview ? <button className="text-button" onClick={() => { setPreview(false); setSelectedId(null) }}>退出示例预览</button> : <><span className="small-dot" />{snapshot.captions.length ? '段落持续保留 · 向上滚动回看' : '实时译文持续更新，旧内容留在这里'}</>}</div>
        <div className="footer-actions"><IconButton title="输入文字翻译" onClick={() => { rememberPanelFocus('输入文字翻译'); setNotice(''); setPanel('text') }}><Keyboard size={15} /></IconButton><IconButton title="历史与收藏" active={panel === 'history'} onClick={() => { rememberPanelFocus('历史与收藏'); setNotice(''); setPanel('history') }}><History size={15} /></IconButton></div>
      </footer>
    </>}

    {toast && <div className="toast" role="status"><Check size={12} />{toast}</div>}
    {panel && !snapshot.collapsed && <div className="panel-backdrop"><section className={`panel panel-${panel}`} role="dialog" aria-modal="true" aria-label={panel === 'settings' ? '设置' : panel === 'history' ? '历史与收藏' : '文字翻译'}>
      <div className="panel-heading"><div><span className="panel-kicker">{panel === 'settings' ? 'PREFERENCES' : panel === 'history' ? 'YOUR LANGUAGE NOTES' : 'TEXT TRANSLATION'}</span><h2>{panel === 'settings' ? '让语伴适合你' : panel === 'history' ? '听过的，留下来' : '从一句话开始'}</h2></div><IconButton title="关闭面板" onClick={() => { setPanel(null); setNotice('') }}><X size={17} /></IconButton></div>
      {notice && <div className="panel-notice" role="alert">{notice}</div>}
      {panel === 'settings' && <SettingsPanel platform={platform} settings={snapshot.settings} listening={listening || starting} saveSettings={saveSettings} onSaved={() => { setNotice(''); setToast('设置已保存'); setPanel(null) }} onError={setNotice} onImport={async () => { if (!api) throw new Error('请在应用中导入本机密钥。'); const settings = await api.importLocalKey(); setSnapshot(value => ({ ...value, settings })); setToast('本机语音识别密钥已安全导入'); return settings }} />}
      {panel === 'text' && <form className="text-form" onSubmit={event => void submitText(event)}><label htmlFor="translation-input">输入或粘贴任何语言，翻译为你在设置中选择的字幕语言。</label><textarea id="translation-input" value={input} autoFocus onChange={event => setInput(event.target.value)} placeholder="例如：You don't have to be perfect to make progress." maxLength={5000} /><div className="text-form-footer"><span>{input.length} / 5000 · {labels.submitShortcut} 翻译</span><button className="primary-button" disabled={busy || !input.trim()} type="submit" onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation() }}>{busy ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />}翻译这句</button></div></form>}
      {panel === 'history' && <HistoryPanel captions={snapshot.captions} settings={snapshot.settings} filter={historyFilter} focusVersion={historyFocusVersion} onFilter={setHistoryFilter} onSelect={caption => { setSelectedId(caption.id); setFocusVersion(value => value + 1); setPreview(false); setPanel(null) }} onSave={caption => api && void run(() => api.toggleSaved(caption.id))} onExport={() => void exportSaved()} exporting={exporting} exportResult={exportResult} />}
    </section></div>}
    {panel === 'text' && <TextShortcut isComposing={() => composing.current} onSubmit={() => { if (input.trim() && !busy) void submitText({ preventDefault() {} } as FormEvent) }} />}
  </main>
}

function TextShortcut({ onSubmit, isComposing }: { onSubmit: () => void; isComposing: () => boolean }) {
  useEffect(() => { const callback = (event: KeyboardEvent) => { if (event.isComposing || isComposing() || event.keyCode === 229) return; if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); onSubmit() } }; window.addEventListener('keydown', callback); return () => window.removeEventListener('keydown', callback) }, [onSubmit, isComposing])
  return null
}

function SettingsPanel({ platform, settings, listening, saveSettings, onSaved, onError, onImport }: { platform: DesktopPlatform; settings: Settings; listening: boolean; saveSettings: (input: SettingsInput) => Promise<Settings>; onSaved: () => void; onError: (message: string) => void; onImport: () => Promise<Settings> }) {
  const [draft, setDraft] = useState(settings)
  const [asrKey, setAsrKey] = useState('')
  const [translationKey, setTranslationKey] = useState('')
  const [tab, setTab] = useState<'languages' | 'connection' | 'appearance'>(settings.hasAsrKey && settings.hasTranslationKey ? 'languages' : 'connection')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [devices, setDevices] = useState<MicrophoneDevice[]>([])
  const [deviceNotice, setDeviceNotice] = useState('')
  const refreshDevices = async () => {
    try { setDevices(await listMicrophones()); setDeviceNotice('') }
    catch { setDeviceNotice('无法列出设备，仍可选择默认麦克风。请检查设备连接和系统权限。') }
  }
  useEffect(() => {
    let active = true
    const update = () => { void listMicrophones().then(next => { if (active) { setDevices(next); setDeviceNotice('') } }).catch(() => { if (active) setDeviceNotice('无法列出设备，仍可选择默认麦克风。') }) }
    update()
    navigator.mediaDevices?.addEventListener?.('devicechange', update)
    return () => { active = false; navigator.mediaDevices?.removeEventListener?.('devicechange', update) }
  }, [])
  const isDeepSeek = (() => { try { return new URL(draft.translationBaseUrl).hostname === 'api.deepseek.com' } catch { return false } })()
  const field = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft(previous => ({ ...previous, [key]: value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!validTargetLanguages(draft.targetLanguages)) { onError('请选择 1–8 种不重复的字幕语言。'); return }
    setSaving(true)
    onError('')
    try {
      const { hasAsrKey: _asr, hasTranslationKey: _translation, ...preferences } = draft
      await saveSettings({ ...preferences, ...(asrKey.trim() ? { asrApiKey: asrKey.trim() } : {}), ...(translationKey.trim() ? { translationApiKey: translationKey.trim() } : {}) })
      setAsrKey(''); setTranslationKey(''); onSaved()
    } catch (error) { onError(errorText(error)) }
    setSaving(false)
  }
  return <form className="settings-form" onSubmit={event => void submit(event)}><div className="settings-layout"><nav className="settings-nav"><button type="button" className={tab === 'languages' ? 'selected' : ''} aria-pressed={tab === 'languages'} onClick={() => setTab('languages')}><Languages size={14} />字幕语言</button><button type="button" className={tab === 'connection' ? 'selected' : ''} aria-pressed={tab === 'connection'} onClick={() => setTab('connection')}><AudioLines size={14} />服务连接</button><button type="button" className={tab === 'appearance' ? 'selected' : ''} aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}><Settings2 size={14} />显示与启动</button><p>为每一句听见的语言，<br />留一扇理解的窗口。</p></nav><div className="settings-content">{tab === 'languages' ? <LanguageSettings draft={draft} onChange={next => setDraft(previous => ({ ...previous, ...next }))} /> : tab === 'connection' ? <><div className="privacy-note"><span className="small-dot" /><p>语音会发送到识别服务，文字会发送到翻译服务。密钥仅在本机加密保存。</p></div>{listening && <p className="settings-warning">修改音源、麦克风或服务配置会暂停聆听，保存后请重新开始。</p>}<section className="settings-section"><div className="section-title"><h3>声音设备</h3><button type="button" className="text-button" onClick={() => void refreshDevices()}>刷新设备</button></div><label htmlFor="microphone-device">麦克风</label><select id="microphone-device" className="device-select" value={draft.microphoneDeviceId} onChange={event => field('microphoneDeviceId', event.target.value)}><option value="default">跟随系统默认麦克风</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}{draft.microphoneDeviceId !== 'default' && !devices.some(device => device.deviceId === draft.microphoneDeviceId) && <option value={draft.microphoneDeviceId}>已选麦克风（未连接或尚未授权）</option>}</select><p className="settings-explanation">可在开始聆听前选择设备；系统权限受限时名称可能不可用。默认设备变化或所选设备断开时会暂停，请确认设备后重新开始。</p><p className="settings-explanation">电脑声音使用当前系统默认输出设备；切换输出设备后请重新开始。双音源建议使用耳机，减少重复收录。</p>{deviceNotice && <p className="settings-warning" role="status">{deviceNotice}</p>}</section><section className="settings-section"><div className="section-title"><h3>语音识别</h3><span className={`readiness ${settings.hasAsrKey ? 'ready' : ''}`}>{settings.hasAsrKey ? <><Check size={10} />已配置密钥</> : '等待配置'}</span></div><label htmlFor="asr-key">DashScope API Key</label><input id="asr-key" type="password" autoComplete="off" spellCheck={false} value={asrKey} onChange={event => setAsrKey(event.target.value)} placeholder={settings.hasAsrKey ? '已安全保存 · 留空保留现有密钥' : '输入语音识别密钥'} /><div className="settings-fields"><div><label htmlFor="asr-model">识别模型 · 推荐 Qwen Audio 3.1</label><input id="asr-model" list="asr-model-options" value={draft.asrModel} onChange={event => field('asrModel', event.target.value)} required /><datalist id="asr-model-options"><option value="qwen-audio-3.1-asr-flash-streaming">Qwen Audio 3.1 · 推荐</option><option value="qwen-audio-3.0-asr-flash-streaming">Qwen Audio 3.0</option><option value="qwen3-asr-flash-realtime">Qwen3 ASR · 旧版实时模型</option></datalist></div><div><label htmlFor="asr-endpoint">服务地址</label><input id="asr-endpoint" value={draft.asrEndpoint} onChange={event => field('asrEndpoint', event.target.value)} required spellCheck={false} /></div></div></section><section className="settings-section"><div className="section-title"><h3>字幕翻译</h3><span className={`readiness ${settings.hasTranslationKey ? 'ready' : ''}`}>{settings.hasTranslationKey ? <><Check size={10} />已配置密钥</> : '等待配置'}</span></div><label htmlFor="translation-key">{isDeepSeek ? 'DeepSeek API Key · 与语音识别密钥不同' : '翻译服务 API Key · 与语音识别密钥分别配置'}</label><input id="translation-key" type="password" autoComplete="off" spellCheck={false} value={translationKey} onChange={event => setTranslationKey(event.target.value)} placeholder={settings.hasTranslationKey ? '已安全保存 · 留空保留现有密钥' : isDeepSeek ? '输入 DeepSeek 密钥，仅用于字幕翻译' : '输入此翻译服务对应的 API Key'} /><div className="settings-fields"><div><label htmlFor="translation-model">{isDeepSeek ? '翻译模型 · 推荐 DeepSeek Flash' : '翻译模型'}</label><input id="translation-model" value={draft.translationModel} onChange={event => field('translationModel', event.target.value)} required /></div><div><label htmlFor="translation-endpoint">兼容 OpenAI 的服务地址</label><input id="translation-endpoint" value={draft.translationBaseUrl} onChange={event => field('translationBaseUrl', event.target.value)} required spellCheck={false} /></div></div></section>{platform === 'darwin' && <div className="import-key"><div><b>已经在本机用过 DashScope？</b><p>点击后，读取本机 DashScope 密钥，仅用于语音识别。</p></div><button type="button" className="secondary-button" disabled={importing || saving} onClick={async () => { setImporting(true); onError(''); try { const imported = await onImport(); setDraft(previous => ({ ...previous, hasAsrKey: imported.hasAsrKey, asrModel: imported.asrModel, asrEndpoint: imported.asrEndpoint })); setAsrKey('') } catch (error) { onError(errorText(error)) } setImporting(false) }}>{importing ? <LoaderCircle size={12} className="spin" /> : <ArrowDownToLine size={12} />}导入语音识别密钥</button></div>}</> : <><section className="settings-section"><h3>阅读舒适度</h3><div className="range-setting"><label htmlFor="font-size">字幕字号 <b>{draft.fontSize} px</b></label><input id="font-size" type="range" min="14" max="24" step="1" value={draft.fontSize} onChange={event => field('fontSize', Number(event.target.value))} /><div className="font-sample" style={{ fontSize: draft.fontSize }}>每天学会一点点。<span>A little, every day.</span></div></div><div className="range-setting"><label htmlFor="opacity">窗口不透明度 <b>{Math.round(draft.opacity * 100)}%</b></label><input id="opacity" type="range" min="0.45" max="1" step="0.01" value={draft.opacity} onChange={event => field('opacity', Number(event.target.value))} /></div></section><section className="settings-section"><label className="toggle-setting"><div><b>始终置顶</b><span>在其他窗口上方显示翻译条</span></div><input type="checkbox" checked={draft.alwaysOnTop} onChange={event => field('alwaysOnTop', event.target.checked)} /><i /></label><label className="toggle-setting"><div><b>登录时启动</b><span>打开电脑时，让语伴一起就位</span></div><input type="checkbox" checked={draft.launchAtLogin} onChange={event => field('launchAtLogin', event.target.checked)} /><i /></label></section></>}</div></div><div className="panel-footer"><span>设置只影响 LingoBar</span><button type="submit" className="primary-button" disabled={saving || importing}>{saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}保存设置</button></div></form>
}
