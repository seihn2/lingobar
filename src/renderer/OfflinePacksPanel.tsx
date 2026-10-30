import { useEffect, useRef, useState } from 'react'
import type { OfflineDictionaryAPI, OfflinePackInfo } from '../shared/offline-dictionary'

type PackActions = Omit<OfflineDictionaryAPI, 'lookup'>
const errorText = (error: unknown) => error instanceof Error ? error.message : '语言包操作未完成。'

export default function OfflinePacksPanel({ api, onBack }: { api: PackActions; onBack: () => void }) {
  const [packs, setPacks] = useState<OfflinePackInfo[]>([])
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const alive = useRef(true), busy = useRef(false)
  useEffect(() => {
    alive.current = true
    void api.list().then(value => { if (alive.current) setPacks(value) }).catch(error => { if (alive.current) setMessage(errorText(error)) })
    return () => { alive.current = false }
  }, [api])
  const action = async (operation: () => Promise<string>) => {
    if (busy.current) return
    busy.current = true; setPending(true); setMessage('')
    try {
      const result = await operation(), next = await api.list()
      if (alive.current) { setPacks(next); setMessage(result) }
    } catch (error) { if (alive.current) setMessage(errorText(error)) }
    finally { if (alive.current) { busy.current = false; setPending(false) } }
  }
  return <section className="dictionary-packs">
    <h3 className="dictionary-packs-heading" tabIndex={-1}>本机离线语言包</h3>
    <div className="dictionary-toolbar"><button type="button" disabled={pending} onClick={onBack}>返回学习历史</button><button type="button" disabled={pending} onClick={() => void action(async () => (await api.install()).installed ? '语言包已安装；同一包的新版本会替换查询版本。' : '导入已取消。')}>导入语言包</button></div>
    <p>选择已构建语言包的 manifest.json。本地导入、查询和复习不调用服务。卸载或更新词库不会改动已收藏的义项快照。</p>
    {message && <p role="status" className="dictionary-error">{message}</p>}
    {!packs.length && <p className="dictionary-empty">尚未安装语言包。</p>}
    {packs.map(({ manifest, enabled }) => <article className="dictionary-pack" key={manifest.packId} data-pack-id={manifest.packId}>
      <h4>{manifest.sourceName}</h4>
      <p>{manifest.sourceLanguage} → {manifest.glossLanguage} · {manifest.counts.entries} 词条 / {manifest.counts.senses} 义项</p>
      <p>版本 {manifest.version} · 来源快照 {manifest.sourceRevision}</p>
      <div className="dictionary-toolbar"><label><input type="checkbox" aria-label={`启用语言包 ${manifest.packId}`} checked={enabled} disabled={pending} onChange={event => { const next = event.target.checked; void action(async () => { await api.setEnabled(manifest.packId, next); return next ? '语言包已启用。' : '语言包已停用。' }) }} />启用查询</label><button type="button" disabled={pending} aria-label={`卸载语言包 ${manifest.packId}`} onClick={() => void action(async () => { await api.uninstall(manifest.packId); return '语言包已卸载，学习历史中的快照保留。' })}>卸载语言包</button></div>
      <details><summary>来源与许可</summary><p>{manifest.sourceUrl}</p><p>{manifest.license} · {manifest.licenseUrl}</p><p>{manifest.attribution}</p></details>
    </article>)}
  </section>
}
