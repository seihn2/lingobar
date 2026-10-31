import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import AuthSettings from '../../src/web/AuthSettings'
import { TranslationKeySettings } from '../../src/web/App'
import { BrowserSession } from '../../src/web/session'
import '../../src/renderer/style.css'
import '../../src/web/style.css'
let kind = 'anonymous', bootstrap = false, hanging = false, calls: Array<{ path: string; method: string; rawPath: string }> = [], aborted = 0
let passwordFailures = 0
const root = createRoot(document.getElementById('root')!)
const wait = () => new Promise(resolve => setTimeout(resolve, 30))
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() { throw new Error('Forbidden media') } } })
window.fetch = async (input, init) => {
  const rawPath = new URL(String(input)).pathname, path = rawPath.replace(/^\/owner(?=\/api\/)/u, ''); calls.push({ path, rawPath, method: init?.method || 'GET' })
  if (path === '/api/auth/status') return Response.json({ kind, initialized: !bootstrap, bootstrapAllowed: bootstrap, ...(['owner', 'account'].includes(kind) ? { role: 'admin' } : {}) })
  if (path === '/api/auth/accounts' && init?.method === 'GET') return Response.json({ accounts: [{ username: 'synthetic-user', role: 'user', limitMicroCny: 0 }] })
  if (!path.startsWith('/api/auth/')) throw new Error('Provider request forbidden')
  if (hanging) return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('Synthetic cancelled')) }) })
  if (path === '/api/auth/password') {
    check(rawPath === '/owner/api/auth/password' && init?.method === 'POST', 'Password rotation must use protected owner POST')
    const body = JSON.parse(init!.body as string)
    check(Object.keys(body).sort().join(',') === 'confirmation,password,username' && body.password === body.confirmation, 'Exact matching rotation payload required')
    await wait()
    if (passwordFailures-- > 0) return Response.json({ error: 'synthetic_failure' }, { status: 503 })
  }
  return Response.json({ ok: true })
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
function fill(id: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(id)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
async function mount(nextKind: string, allowed = false) {
  flushSync(() => root.render(null)); kind = nextKind; bootstrap = allowed; calls = []; hanging = false
  flushSync(() => root.render(<main className="web-shell"><section className="web-panel"><div className="settings-content"><AuthSettings origin="https://lingobar.example" stop={() => {}} /></div></section></main>))
  await wait()
}
Object.assign(window, { __authTest: {
  async anonymous() {
    await mount('anonymous')
    check(!button('初始化管理员账号'), 'Anonymous must not see owner bootstrap')
    check(button('使用自己的密钥').disabled, 'Guest consent required')
    fill('#web-guest-translation', 'synthetic-key-not-real'); await wait()
    check(button('使用自己的密钥').disabled, 'Key alone must not allow BYOK')
    document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); await wait()
    check(!button('使用自己的密钥').disabled, 'Explicit consent enables BYOK submit')
    check(document.documentElement.scrollWidth <= innerWidth, 'Mobile layout overflow')
    const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!.getBoundingClientRect()
    check(checkbox.width <= 24 && checkbox.height <= 24, 'Consent checkbox must not inherit full-width password styling')
    const consentStyle = getComputedStyle(document.querySelector('.web-key-consent')!)
    check(parseFloat(consentStyle.fontSize) >= 13 && parseFloat(consentStyle.lineHeight) >= 19.5, 'Billing consent must be readable')
    check(getComputedStyle(document.querySelector('.web-key-settings a')!).color === 'rgb(160, 222, 215)', 'Owner link must use high-contrast theme accent')
    return { checks: ['anonymous no bootstrap', 'guest consent', '375px fits', 'readable consent and owner link'], calls }
  },
  async interruption() {
    await mount('anonymous'); fill('#web-account-name', 'synthetic-user'); fill('#web-account-password', 'synthetic-password-not-real'); await wait()
    hanging = true; button('登录').click(); button('登录').click(); await wait()
    check(calls.filter(c => c.path.endsWith('/login')).length === 1, 'Duplicate login dispatched')
    flushSync(() => root.render(null)); await wait(); check(aborted === 1, 'Close must abort login')
    await mount('anonymous'); check(document.querySelector<HTMLInputElement>('#web-account-password')!.value === '', 'Secret retained after close')
    return { checks: ['duplicate login blocked', 'close aborts', 'password cleared'] }
  },
  async owner() {
    history.replaceState(null, '', '/owner')
    await mount('owner', true);
    check(calls.every(call => call.rawPath.startsWith('/owner/api/auth/')), 'Owner requests must keep Access namespace'); check(Boolean(button('初始化管理员账号')), 'Owner bootstrap missing')
    check(document.documentElement.scrollWidth <= innerWidth, 'Owner layout overflow')
    return { checks: ['owner bootstrap visible', 'zero quota shown', 'mobile owner fits'] }
  },
  async credentials() {
    history.replaceState(null, '', '/owner')
    let stored = false, readFailure = false, saveFailure = false, delayRead = false, captures = 0, sockets = 0
    let resolveRead: ((response: Response) => void) | undefined, latestReadSignal: AbortSignal | undefined
    const observed: Array<{ method: string; path: string }> = []
    const synthetic = 'synthetic-only-asr-key-not-a-real-provider-key'
    const session = new BrowserSession({ backend: null, textBackend: null, origin: 'https://lingobar.example',
      credentialsBackend: '/api/settings/translation-key', asrCredentialsBackend: '/api/settings/asr-key', audioStatus: 'missing-key',
      socket: () => { sockets++; throw new Error('Forbidden synthetic socket') }, capture: async () => { captures++; throw new Error('Forbidden synthetic capture') },
      credentialsFetch: async (url, init) => {
        const path = new URL(String(url)).pathname; observed.push({ method: init!.method!, path })
        check(['/owner/api/settings/asr-key', '/owner/api/settings/translation-key'].includes(path), 'Unexpected credential destination')
        if (init?.method === 'GET') {
          latestReadSignal = init.signal as AbortSignal
          if (delayRead) { delayRead = false; return new Promise<Response>(resolve => { resolveRead = resolve }) }
          if (readFailure) return new Response('synthetic unavailable', { status: 503 })
          return Response.json({ configured: stored })
        }
        check(Object.keys(JSON.parse(init!.body as string)).join(',') === 'apiKey', 'Credential save shape changed')
        if (saveFailure) return new Response('synthetic unavailable', { status: 503 })
        stored = true; return Response.json({ configured: true })
      }
    })
    const mountCredentials = async (asr = true) => {
      flushSync(() => root.render(null))
      flushSync(() => root.render(<main className="web-shell"><section className="web-panel"><div className="settings-content"><TranslationKeySettings session={session} asr={asr} /></div></section></main>))
      await wait()
    }
    try {
      await mountCredentials()
      check(document.body.textContent!.includes('未配置，请填写'), 'Initial GET false must be explicit')
      fill('#web-asr-key', synthetic); await wait(); button('保存密钥').click(); await wait()
      check(document.querySelector<HTMLInputElement>('#web-asr-key')!.value === '', 'Save must clear the input')
      check(document.body.textContent!.includes('已配置，输入框留空不会删除密钥；仅更换时填写'), 'Saved key state missing')
      await mountCredentials() // Reopening simulates reload: only GET can restore status.
      check(document.querySelector<HTMLInputElement>('#web-asr-key')!.value === '' && document.body.textContent!.includes('已配置，输入框留空不会删除密钥'), 'Refresh must retain configured with empty input')
      check(!document.body.textContent!.includes('请在字幕设置中保存'), 'Saved ASR must not ask to save again')
      readFailure = true; await mountCredentials()
      check(document.body.textContent!.includes('配置状态读取失败，不代表密钥未配置'), 'Read failure must not claim unconfigured')
      fill('#web-asr-key', synthetic); await wait(); check(!button('保存密钥').disabled, 'Failed GET must not block explicit save')
      button('保存密钥').click(); await wait()
      check(document.body.textContent!.includes('已配置，输入框留空不会删除密钥'), 'Manual save after read failure must report configured')
      await mountCredentials(); check(Boolean(button('重试读取状态')), 'Failed read must offer retry')
      readFailure = false; button('重试读取状态').click(); await wait()
      check(document.body.textContent!.includes('已配置，输入框留空不会删除密钥'), 'Read retry failed')
      saveFailure = true; fill('#web-asr-key', synthetic); await wait(); button('保存密钥').click(); await wait()
      check(document.body.textContent!.includes('密钥保存未完成') && document.body.textContent!.includes('已配置，输入框留空不会删除密钥'), 'Save failure must preserve known configured status')
      saveFailure = false; button('保存密钥').click(); await wait()
      check(document.querySelector<HTMLInputElement>('#web-asr-key')!.value === '', 'Successful retry must clear input')
      delayRead = true; await mountCredentials()
      check(document.body.textContent!.includes('正在读取配置状态'), 'Loading must be explicit')
      fill('#web-asr-key', synthetic); await wait(); button('保存密钥').click(); await wait()
      check(latestReadSignal!.aborted, 'Save must cancel older read')
      resolveRead!(Response.json({ configured: false })); await wait()
      check(document.body.textContent!.includes('已配置，输入框留空不会删除密钥'), 'Late false GET overwrote successful POST')
      delayRead = true; await mountCredentials(); flushSync(() => root.render(null))
      check(latestReadSignal!.aborted, 'Close must abort pending status GET')
      resolveRead!(Response.json({ configured: false })); await wait()
      await mountCredentials(false)
      check(document.body.textContent!.includes('已配置，输入框留空不会删除密钥'), 'DeepSeek must read persisted status too')
      await mountCredentials()
      check(!document.body.textContent!.includes(synthetic) && !JSON.stringify(session.snapshot()).includes(synthetic), 'Credential leaked into displayed state')
      check(captures === 0 && sockets === 0, 'Credential actions must never capture or open sockets')
      check(document.documentElement.scrollWidth <= innerWidth, 'Credential settings overflow mobile width')
      return { checks: ['GET restores configured after refresh with empty input', 'read failure explicit and retryable', 'save failure preserves prior status and retries', 'late false GET cannot overwrite successful POST', 'close cancels read', 'DeepSeek status restored', 'no key display or capture', '375px fits'], requests: observed }
    } finally { session.dispose() }
  },
  async password() {
    history.replaceState(null, '', '/') // A public page still must target the owner namespace.
    for (const identity of ['anonymous', 'guest', 'account']) {
      await mount(identity)
      check(!document.querySelector('#web-replacement-password'), 'Nonowner including cookie admin must not see rotation')
    }
    await mount('owner', true)
    check(!document.querySelector('#web-replacement-password'), 'Uninitialized owner must bootstrap first')
    await mount('owner')
    const select = document.querySelector<HTMLSelectElement>('#web-replacement-account')!
    select.value = 'synthetic-user'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait()
    const synthetic = 'Synthetic!K7-long-replacement-only'
    fill('#web-replacement-password', synthetic); fill('#web-replacement-confirmation', synthetic + '-mismatch'); await wait()
    check(button('更改密码并撤销旧会话').disabled, 'Mismatched confirmation must disable submit')
    button('更改密码并撤销旧会话').click(); await wait()
    check(!calls.some(c => c.path.endsWith('/password')), 'Mismatch dispatched')
    fill('#web-replacement-password', 'aaaaaaaaaaaaaaaa'); fill('#web-replacement-confirmation', 'aaaaaaaaaaaaaaaa'); await wait()
    check(button('更改密码并撤销旧会话').disabled, 'Obviously weak password accepted')
    fill('#web-replacement-password', synthetic); fill('#web-replacement-confirmation', synthetic); await wait()
    passwordFailures = 1
    button('更改密码并撤销旧会话').click(); button('更改密码并撤销旧会话').click(); await wait(); await wait()
    check(calls.filter(c => c.path.endsWith('/password')).length === 1, 'Duplicate pending rotation dispatched')
    check(document.querySelector<HTMLInputElement>('#web-replacement-password')!.value === synthetic, 'Failure must permit correction and retry')
    check(!button('更改密码并撤销旧会话').disabled, 'Failure blocked retry')
    button('更改密码并撤销旧会话').click(); await wait(); await wait()
    check(calls.filter(c => c.path.endsWith('/password')).length === 2, 'Explicit retry missing')
    check(document.querySelector<HTMLInputElement>('#web-replacement-password')!.value === '' && document.querySelector<HTMLInputElement>('#web-replacement-confirmation')!.value === '', 'Success must clear both password fields')
    check(document.body.textContent!.includes('全部旧会话已撤销') && !document.body.textContent!.includes(synthetic), 'Fixed success without secret echo required')
    check(document.querySelector<HTMLInputElement>('#web-replacement-password')!.type === 'password' && document.querySelector<HTMLInputElement>('#web-replacement-confirmation')!.maxLength === 128, 'Password field constraints required')
    check(document.documentElement.scrollWidth <= innerWidth, 'Rotation mobile layout overflow')
    const rotation = document.querySelector<HTMLElement>('.web-password-rotation')!
    rotation.scrollIntoView({ block: 'start' }); await wait()
    for (const element of [rotation, ...rotation.querySelectorAll('input, select')]) {
      const box = element.getBoundingClientRect()
      check(box.left >= 0 && box.right <= innerWidth, 'Rotation field or input horizontally overflows mobile viewport')
    }
    return { checks: ['nonowner and cookie admin hidden', 'initialized owner only', 'mismatch and weak password blocked', 'duplicate pending blocked', 'failed rotation retries', 'success clears both secrets', 'protected owner path from public page', '375px fits'] }
  },
  async quota() {
    await mount('owner'); const input = document.querySelector<HTMLInputElement>('[aria-label="synthetic-user 累计额度"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '100.000001'); input.dispatchEvent(new Event('input', { bubbles: true })); await wait()
    check(button('保存累计额度').disabled, 'Quota >100 accepted')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1.5'); input.dispatchEvent(new Event('input', { bubbles: true })); await wait()
    check(!button('保存累计额度').disabled, 'Valid quota disabled'); button('保存累计额度').click(); await wait()
    check(calls.some(c => c.path === '/api/auth/accounts' && c.method === 'PATCH'), 'PATCH not dispatched')
    return { checks: ['100CNY cap', 'explicit PATCH quota save'], providerCalls: calls.filter(c => !c.path.startsWith('/api/auth/')).length }
  }
} })
