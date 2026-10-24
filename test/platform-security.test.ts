import { describe, expect, it } from 'vitest'
import { desktopPlatform, platformLabels, validMicrophoneDeviceId } from '../src/shared/platform'
import { mayCaptureMicrophone, mayUseLocalKeyImport, trustedRendererUrl } from '../src/main/ipc-security'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('desktop platform behavior', () => {
  it('keeps Windows actions separate from macOS keychain and permission labels', () => {
    const windows = platformLabels('win32')
    expect(windows).toMatchObject({ residentArea: '系统托盘', shortcut: 'Ctrl+Alt+L', submitShortcut: 'Ctrl+Enter' })
    expect(windows.microphonePermission).toContain('桌面应用')
    expect(windows.systemPermission).toContain('不需要屏幕录制')
    expect(mayUseLocalKeyImport('win32')).toBe(false)
    expect(mayUseLocalKeyImport('linux')).toBe(false)
    expect(mayUseLocalKeyImport('darwin')).toBe(true)
    expect(platformLabels('darwin')).toMatchObject({ residentArea: '菜单栏', shortcut: '⌘⌥L' })
    expect(desktopPlatform('linux')).toBe('other')
  })

  it('validates bounded opaque microphone identifiers', () => {
    expect(validMicrophoneDeviceId('default')).toBe(true)
    expect(validMicrophoneDeviceId('fixture-123abc')).toBe(true)
    for (const value of ['', null, 5, 'a b', 'line\nfeed', 'x'.repeat(513)]) expect(validMicrophoneDeviceId(value)).toBe(false)
  })
})

describe('renderer IPC and microphone permission policy', () => {
  const htmlPath = resolve('out/renderer/index.html')
  const bundled = { packaged: true, htmlPath, developmentUrl: 'http://127.0.0.1:5173' }
  it('accepts the exact bundled file and rejects unrelated files, URLs and malformed values', () => {
    expect(trustedRendererUrl(pathToFileURL(htmlPath).href, bundled)).toBe(true)
    for (const url of ['https://example.invalid', pathToFileURL(resolve('out/renderer/other.html')).href, pathToFileURL(resolve('out/renderer/index.html.evil')).href, 'file://host.invalid/index.html', 'garbage', 'http://127.0.0.1:5173/']) {
      expect(trustedRendererUrl(url, bundled)).toBe(false)
    }
  })

  it('compares full development URLs rather than trusting URL prefixes or origins', () => {
    const development = { ...bundled, packaged: false }
    expect(trustedRendererUrl('http://127.0.0.1:5173/', development)).toBe(true)
    expect(trustedRendererUrl('http://127.0.0.1:5173/?preview=1', development)).toBe(true)
    for (const url of ['http://127.0.0.1:5173/other', 'http://127.0.0.1:5173.evil.invalid/', 'http://127.0.0.1:5174/', 'http://account:password@127.0.0.1:5173/']) expect(trustedRendererUrl(url, development)).toBe(false)
  })

  const allowed = { sameContents: true, mainFrame: true, trustedUrl: true, permission: 'media', audioOnly: true, microphoneRun: 12, state: 'starting' }
  it('grants audio only to the active, trusted main frame during an explicit microphone run', () => {
    expect(mayCaptureMicrophone(allowed)).toBe(true)
    expect(mayCaptureMicrophone({ ...allowed, state: 'listening' })).toBe(true)
    for (const denied of [
      { sameContents: false }, { mainFrame: false }, { trustedUrl: false }, { permission: 'display-capture' },
      { permission: 'speaker-selection' }, { audioOnly: false }, { microphoneRun: null }, { state: 'idle' }, { state: 'error' }
    ]) expect(mayCaptureMicrophone({ ...allowed, ...denied })).toBe(false)
  })
})
