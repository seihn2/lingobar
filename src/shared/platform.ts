export type DesktopPlatform = 'darwin' | 'win32' | 'other'

export function desktopPlatform(value: string): DesktopPlatform {
  return value === 'darwin' || value === 'win32' ? value : 'other'
}

export function platformLabels(platform: DesktopPlatform) {
  return {
    residentArea: platform === 'darwin' ? '菜单栏' : '系统托盘',
    shortcut: platform === 'darwin' ? '⌘⌥L' : 'Ctrl+Alt+L',
    submitShortcut: platform === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter',
    microphonePermission: platform === 'win32'
      ? '请在 Windows 设置 → 隐私和安全性（Windows 10 为“隐私”）→ 麦克风中启用麦克风访问，并允许桌面应用访问麦克风。'
      : platform === 'darwin'
        ? '请在系统设置 → 隐私与安全性 → 麦克风中允许 LingoBar 使用麦克风。'
        : '请允许 LingoBar 使用麦克风，并检查系统的麦克风权限。',
    systemPermission: platform === 'win32'
      ? 'Windows 拒绝了系统声音访问，请检查声音输出设备及系统隐私设置，然后重新开始。系统声音不需要屏幕录制权限。'
      : '请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 LingoBar 录制系统声音。',
    unsupportedAudio: platform === 'win32'
      ? '电脑声音需要 Windows 10/11 x64，可以改用麦克风。'
      : '电脑声音需要 macOS 14.2 或更新版本，可以改用麦克风。'
  }
}

/** An opaque Chromium device identifier, never a path or executable argument. */
export function validMicrophoneDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value)
}
