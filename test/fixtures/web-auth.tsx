import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import AuthSettings from '../../src/web/AuthSettings'
import '../../src/renderer/style.css'
import '../../src/web/style.css'
let kind = 'anonymous', bootstrap = false, hanging = false, calls: Array<{ path: string; method: string; rawPath: string }> = [], aborted = 0
const root = createRoot(document.getElementById('root')!)
const wait = () => new Promise(resolve => setTimeout(resolve, 30))
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() { throw new Error('Forbidden media') } } })
window.fetch = async (input, init) => {
  const rawPath = new URL(String(input)).pathname, path = rawPath.replace(/^\/owner(?=\/api\/)/u, ''); calls.push({ path, rawPath, method: init?.method || 'GET' })
  if (path === '/api/auth/status') return Response.json({ kind, initialized: !bootstrap, bootstrapAllowed: bootstrap, ...(kind === 'owner' ? { role: 'admin' } : {}) })
  if (path === '/api/auth/accounts' && init?.method === 'GET') return Response.json({ accounts: [{ username: 'synthetic-user', role: 'user', limitMicroCny: 0 }] })
  if (!path.startsWith('/api/auth/')) throw new Error('Provider request forbidden')
  if (hanging) return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { aborted++; reject(new Error('Synthetic cancelled')) }) })
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
    return { checks: ['anonymous no bootstrap', 'guest consent', '375px fits'], calls }
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
