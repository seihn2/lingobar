import { useEffect, useRef, useState } from 'react'
import { authRequest, quotaMicroCny, type AccountSummary, type AuthStatus } from './auth-client'

export default function AuthSettings({ stop, origin = location.origin }: { stop(): void; origin?: string }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [quota, setQuota] = useState<Record<string, string>>({})
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [translationKey, setTranslationKey] = useState(''), [asrKey, setAsrKey] = useState('')
  const [consent, setConsent] = useState(false), [pending, setPending] = useState(false)
  const [notice, setNotice] = useState(''), [refresh, setRefresh] = useState(false)
  const owner = useRef<AbortController | null>(null), fields = useRef<HTMLFieldSetElement>(null)
  const mounted = useRef(true)
  const clearSecrets = () => { setPassword(''); setTranslationKey(''); setAsrKey(''); setConsent(false) }
  const call = async (action: 'login' | 'guest' | 'logout' | 'bootstrap' | 'accounts', body: unknown, method: 'POST' | 'DELETE' | 'PATCH' = 'POST') => {
    if (owner.current) return
    const controller = new AbortController(); owner.current = controller; setPending(true); setNotice('')
    try {
      if (action === 'logout') stop()
      await authRequest(origin, action, method, body, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      clearSecrets(); setNotice(action === 'accounts' ? '账号已更新；额度变更会撤销该账号会话，请刷新查看。' : '操作成功。请刷新页面加载当前身份及服务状态。')
      setRefresh(true)
    } catch { if (mounted.current && !controller.signal.aborted) setNotice('账号操作未完成，请检查输入、权限或服务配置。') }
    finally { if (owner.current === controller) owner.current = null; if (mounted.current) setPending(false) }
  }
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController(); owner.current = controller; setPending(true)
    void (async () => {
      try {
        const current = await authRequest(origin, 'status', 'GET', undefined, controller.signal) as AuthStatus
        if (!mounted.current || controller.signal.aborted) return
        setStatus(current)
        if (current.kind === 'owner' || current.role === 'admin') {
          const result = await authRequest(origin, 'accounts', 'GET', undefined, controller.signal) as { accounts: AccountSummary[] }
          if (mounted.current && !controller.signal.aborted) setAccounts(result.accounts)
        }
      } catch { if (mounted.current && !controller.signal.aborted) setNotice('账号状态暂不可用。') }
      finally { if (owner.current === controller) owner.current = null; if (mounted.current) setPending(false) }
    })()
    const element = fields.current
    return () => { mounted.current = false; owner.current?.abort(); owner.current = null; element?.querySelectorAll('input').forEach(input => { input.value = '' }) }
  }, [])
  const administrator = status?.kind === 'owner' || status?.role === 'admin'
  const credentials = <>
    <label htmlFor="web-account-name">账号<input id="web-account-name" value={username} maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={event => setUsername(event.target.value)} /></label>
    <label htmlFor="web-account-password">密码（至少 12 位）<input id="web-account-password" type="password" value={password} maxLength={256} autoComplete="off" onChange={event => setPassword(event.target.value)} /></label>
  </>
  return <fieldset className="web-key-settings" ref={fields} disabled={pending} onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault() }}>
    <legend>账号与自带密钥</legend>
    <a href="/owner">所有者管理（Cloudflare Access）</a>
    <p>{status ? status.kind === 'anonymous' ? '请登录或使用自己的 API Key' : `当前身份：${status.username || ({ owner: '所有者', account: '账号', guest: '临时访客' } as const)[status.kind]}` : '正在读取身份…'}</p>
    {(status?.kind === 'anonymous' || status?.bootstrapAllowed || administrator) && credentials}
    {status?.kind === 'anonymous' && <button type="button" disabled={!username.trim() || password.length < 12 || refresh} onClick={() => void call('login', { username, password })}>登录</button>}
    {status?.bootstrapAllowed && <button type="button" disabled={!username.trim() || password.length < 12 || refresh} onClick={() => void call('bootstrap', { username, password })}>初始化管理员账号</button>}
    {administrator && <>
      <p>普通账号默认额度为 0。以下为累计账号额度（人民币，最多 100 元），不是每日重置额度；更改会撤销该账号会话。全站额度另行配置、默认 0，只改个人额度不会开放全站消费；不使用所有者本次 1 元测试预算。</p>
      <button type="button" disabled={!username.trim() || password.length < 12 || refresh} onClick={() => void call('accounts', { username, password, limitMicroCny: 0 })}>创建零额度普通账号</button>
      <ul>{accounts.map(account => <li key={account.username}>{account.username} · {account.role}
        <label>累计额度（元）<input aria-label={`${account.username} 累计额度`} inputMode="decimal" value={quota[account.username] ?? String(account.limitMicroCny / 1_000_000)} onChange={event => setQuota(previous => ({ ...previous, [account.username]: event.target.value }))} /></label>
        <button type="button" disabled={refresh || quotaMicroCny(quota[account.username] ?? String(account.limitMicroCny / 1_000_000)) === null} onClick={() => void call('accounts', { username: account.username, limitMicroCny: quotaMicroCny(quota[account.username] ?? String(account.limitMicroCny / 1_000_000)) }, 'PATCH')}>保存累计额度</button>
        {account.role !== 'admin' && <button type="button" disabled={refresh} onClick={() => { if (confirm(`撤销账号 ${account.username}？`)) void call('accounts', { username: account.username }, 'DELETE') }}>撤销账号</button>}</li>)}</ul>
    </>}
    {status?.kind === 'anonymous' && <>
      <label htmlFor="web-guest-translation">自己的 DeepSeek API Key<input id="web-guest-translation" type="password" autoComplete="off" value={translationKey} maxLength={2048} onChange={event => setTranslationKey(event.target.value)} /></label>
      <label htmlFor="web-guest-asr">自己的百炼北京 ASR Key（可选）<input id="web-guest-asr" type="password" autoComplete="off" value={asrKey} maxLength={2048} onChange={event => setAsrKey(event.target.value)} /></label>
      <label className="web-key-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我同意语音发送至百炼北京、文字发送至 DeepSeek，由自己的供应商账号计费。密钥只在服务器内存临时保留，1 小时后过期，不在浏览器持久保存。</label>
      <button type="button" disabled={!translationKey.trim() || !consent || refresh} onClick={() => void call('guest', { translationKey, ...(asrKey ? { asrKey } : {}), acceptCharges: true })}>使用自己的密钥</button>
    </>}
    {status && status.kind !== 'anonymous' && <button type="button" disabled={refresh} onClick={() => void call('logout', {})}>退出应用会话</button>}
    <p role="status">{notice}</p>
    {refresh && <button type="button" onClick={() => { stop(); location.reload() }}>刷新身份与服务状态</button>}
  </fieldset>
}
