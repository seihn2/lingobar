import type { App } from 'electron'
import type { DesktopPlatform } from '../shared/platform'

const ITEM_NAME = 'com.lingobar.app'
const UNKNOWN = '无法确认系统登录项状态，本地设置未保存；请核对系统登录项。'
const PENDING = '系统仍保留待批准的语伴登录项，尚未确认移除；本应用不会启用它或自动重试，请核对系统登录项。'
type Observation = 'absent' | 'present' | 'pending' | 'unknown'
type LoginApi = Pick<App, 'isPackaged' | 'getPath' | 'getLoginItemSettings' | 'setLoginItemSettings'>

/** Removal only, on an explicit user request. Never register, enable or restore startup. */
export class LoginItems {
  constructor(private app: LoginApi, private platform: DesktopPlatform) {}

  remove(): void {
    if (!this.app.isPackaged || this.platform === 'other') throw new Error('请在打包后的 Windows/macOS 应用中移除登录项；本地设置未保存。')
    const options = this.platform === 'win32' ? { path: this.app.getPath('exe'), args: [] as string[] } : undefined
    const read = (): Observation => {
      let value: Electron.LoginItemSettings
      try { value = options ? this.app.getLoginItemSettings(options) : this.app.getLoginItemSettings() }
      catch { return 'unknown' }
      if (!value || typeof value.openAtLogin !== 'boolean') return 'unknown'
      if (this.platform === 'darwin') {
        if (value.status === 'enabled' && value.openAtLogin) return 'present'
        if ((value.status === 'not-registered' || value.status === 'not-found') && !value.openAtLogin) return 'absent'
        if (value.status === 'requires-approval' && !value.openAtLogin) return 'pending'
      } else if (Array.isArray(value.launchItems)) {
        // The aggregate executable flag can belong to another name/args/scope.
        // Confirm only this app's HKCU entry; never remove a machine/alias entry.
        const own = value.launchItems.filter(item => item?.name === ITEM_NAME && item.scope === 'user')
        if (!value.openAtLogin && own.length === 0) return 'absent'
        if (value.openAtLogin || own.length > 0) return 'present'
      }
      return 'unknown'
    }
    const before = read()
    // Windows readback filters by the current exe path. A missing match can
    // hide this same AUMID at an older path, so still request its removal once.
    if (this.platform === 'darwin' && before === 'absent') return
    try {
      this.app.setLoginItemSettings({ openAtLogin: false, ...(options ? { ...options, name: ITEM_NAME } : {}) })
    } catch { throw new Error(UNKNOWN) }
    const after = read()
    if (after === 'pending') throw new Error(PENDING)
    if (after !== 'absent') throw new Error(UNKNOWN)
    if (this.platform === 'win32' && (before === 'absent' || before === 'unknown')) throw new Error('已请求移除语伴自身用户登录项，但系统接口无法确认旧路径残留；请在系统中核对，应用不会自动重试。')
  }
}
