import { useEffect, useRef, useState } from 'react'
import { LANGUAGES, type TargetLanguage } from '../shared/languages'
import { validPhrase, type Phrase } from '../shared/learning'
import type { DictionaryAPI, DictionaryHandleResult } from '../shared/dictionary'
import type { OfflineHit, OfflineLookupResult } from '../shared/offline-dictionary'

const errorText = (error: unknown) => error instanceof Error ? error.message : '离线查询未完成。'
const languageLabels: Record<string, string> = { en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语', zh: '中文' }
function knownLanguage(value: string): string {
  const normalized = value.trim().toLocaleLowerCase()
  const aliases: Record<string, string[]> = { en: ['english', '英语', '英文'], ja: ['japanese', '日本語', '日语', '日文'], ko: ['korean', '한국어', '韩语', '韩文'], fr: ['french', 'français', '法语'], de: ['german', 'deutsch', '德语'], es: ['spanish', 'español', '西班牙语'], ru: ['russian', 'русский', '俄语'], zh: ['chinese', '中文', '汉语', '简体中文', '繁體中文'] }
  if (LANGUAGES.some(item => item.code.toLowerCase() === normalized)) return normalized
  return Object.keys(aliases).find(code => aliases[code].includes(normalized)) || ''
}
const hitKey = (hit: OfflineHit, senseId: string) => JSON.stringify([hit.pack.packId, hit.pack.version, hit.entry.id, senseId])
const matchLabels = { exact: '原形精确匹配', nfc: 'Unicode NFC 匹配', form: '词库收录词形', 'nfc-form': 'Unicode NFC 词形匹配' }

export default function OfflinePhraseLookup({ api, handle, source, phrase, defaultLanguage, onOpenHistory }: {
  api: DictionaryAPI; handle: DictionaryHandleResult | null; source: string; phrase?: Phrase; defaultLanguage: TargetLanguage; onOpenHistory?: () => void
}) {
  const [language, setLanguage] = useState('')
  const [glossLanguage, setGlossLanguage] = useState<string>(defaultLanguage)
  const [result, setResult] = useState<OfflineLookupResult | null>(null)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState<Set<string>>(() => new Set())
  const alive = useRef(true), busy = useRef(false), epoch = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++ } }, [])
  useEffect(() => { setLanguage(knownLanguage(handle?.source?.language || '')) }, [handle?.source?.language, source])
  useEffect(() => { epoch.current++; setResult(null); setMessage(''); setSaved(new Set()); busy.current = false; setPending(false) }, [source, phrase?.start, phrase?.end, language, glossLanguage, handle?.handle])
  const valid = Boolean(phrase && validPhrase(source, phrase) && phrase.exact.length <= 256 && source.length <= 2000 && handle?.handle && language.trim())
  const lookup = async () => {
    if (!valid || busy.current || !api.offlineLookup || !handle?.handle || !phrase) return
    busy.current = true; setPending(true); setMessage(''); setResult(null); setSaved(new Set())
    const version = ++epoch.current
    try {
      const value = await api.offlineLookup({ handle: handle.handle, span: structuredClone(phrase), language: language.trim(), ...(glossLanguage.trim() ? { glossLanguage: glossLanguage.trim() } : {}) })
      if (alive.current && version === epoch.current) setResult(value)
    } catch (error) { if (alive.current && version === epoch.current) setMessage(errorText(error)) }
    finally { if (alive.current && version === epoch.current) { busy.current = false; setPending(false) } }
  }
  const save = async (hit: OfflineHit, senseId: string) => {
    if (!valid || busy.current || !api.saveOffline || !handle?.handle || !phrase || saved.has(hitKey(hit, senseId))) return
    busy.current = true; setPending(true); setMessage('')
    const version = epoch.current
    try {
      await api.saveOffline({ handle: handle.handle, span: structuredClone(phrase), language: language.trim(), ...(glossLanguage.trim() ? { glossLanguage: glossLanguage.trim() } : {}), packId: hit.pack.packId, packVersion: hit.pack.version, packSha256: hit.pack.dbSha256, entryId: hit.entry.id, senseId })
      if (alive.current && version === epoch.current) { setSaved(previous => new Set([...previous, hitKey(hit, senseId)])); setMessage('此义项与冻结原句已收藏到学习历史。') }
    } catch (error) { if (alive.current && version === epoch.current) setMessage(errorText(error)) }
    finally { if (alive.current && version === epoch.current) { busy.current = false; setPending(false) } }
  }
  if (!api.offlineLookup || !api.saveOffline) return null
  const noChinese = result && /^zh(?:-|$)/i.test(result.requestedGlossLanguage) && result.results.length > 0 && result.results.every(hit => !/^zh(?:-|$)/i.test(hit.pack.glossLanguage))
  return <section className="dictionary-offline-tool" aria-label="离线词典查询">
    <h3>离线词典</h3>
    <p className="dictionary-offline-target" dir="auto">{phrase?.exact || '请先加入一个原文短语'}</p>
    <div className="dictionary-offline-languages"><label>词条语言<input aria-label="离线词条语言" list="offline-source-languages" value={language} maxLength={35} onChange={event => setLanguage(event.target.value)} placeholder="选择或填写语言代码" disabled={pending} /></label><label>优先释义语言<input aria-label="离线释义语言" list="offline-source-languages" value={glossLanguage} maxLength={35} onChange={event => setGlossLanguage(event.target.value)} placeholder="例如 zh、en" disabled={pending} /></label><datalist id="offline-source-languages">{LANGUAGES.map(item => <option key={item.code} value={item.code}>{item.nativeName}</option>)}</datalist></div>
    <button type="button" className="dictionary-offline-query" disabled={!valid || pending} aria-busy={pending} onClick={() => void lookup()}>{pending ? '正在处理…' : '查询本机词典'}</button>
    {!language && <p>请选择原文语言。</p>}
    {message && <p role="status" className="dictionary-error">{message}</p>}
    {result && <p role="status">{result.message || (result.results.length ? `找到 ${result.results.length} 个来源词条` : '本机已启用词库未找到该词；可选择其他语言或主动使用下方 AI 解释。')}</p>}
    {noChinese && <p className="dictionary-warning">本机已安装词库暂无中文释义，当前显示英语/原语言（{[...new Set(result.results.map(hit => languageLabels[hit.pack.glossLanguage] || hit.pack.glossLanguage))].join('、')}）。没有自动翻译或调用 AI。</p>}
    {result?.results.map(hit => <article className="dictionary-offline-hit" key={JSON.stringify([hit.pack.packId, hit.pack.version, hit.entry.id])} data-offline-entry={hit.entry.id}>
      <h4 dir="auto">{hit.entry.headword}</h4><p>{hit.entry.readings.join(' · ') || '未提供读音'} · {hit.entry.partOfSpeech || '未提供词性'}</p>
      <p className="dictionary-version">{hit.pack.sourceName} · {hit.pack.sourceLanguage} → {hit.pack.glossLanguage} · {matchLabels[hit.matchPath]}</p>
      {hit.entry.senses.map((sense, index) => <section className="dictionary-offline-sense" key={sense.id} data-offline-sense={sense.id}>
        <h5>义项 {index + 1}</h5><ul>{sense.glosses.map((gloss, i) => <li key={i} dir="auto">{gloss}</li>)}</ul>
        {sense.tags.length > 0 && <p>{sense.tags.join(' · ')}</p>}
        {sense.examples.map((example, i) => <div className="dictionary-example" key={i}><p dir="auto">{example.text}</p>{example.translation && <p dir="auto">{example.translation}</p>}</div>)}
        <button type="button" disabled={pending || saved.has(hitKey(hit, sense.id))} onClick={() => void save(hit, sense.id)}>{saved.has(hitKey(hit, sense.id)) ? '此义项已收藏' : '收藏此义项与原句'}</button>
      </section>)}
      <details><summary>来源与许可</summary><p>{hit.pack.sourceUrl}</p><p>词库版本 {hit.pack.version} · 来源快照 {hit.pack.sourceRevision}</p><p>{hit.pack.license} · {hit.pack.licenseUrl}</p><p>{hit.pack.attribution}</p></details>
    </article>)}
    {onOpenHistory && saved.size > 0 && <button type="button" onClick={onOpenHistory}>查看学习历史中的收藏</button>}
  </section>
}
