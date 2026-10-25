// Test-only facade: real hidden BrowserWindow/IPC/safeStorage, inert OS controls.
const electron = require('electron')
const assert = require('node:assert/strict')
class BrowserWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences,
      preload: process.env.LINGOBAR_SNAPSHOT_PRELOAD, backgroundThrottling: false } })
  }
  show() {}
  focus() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
}
class Tray { setTitle() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} }
const inertImage = { setTemplateImage() {} }
module.exports = {
  app: electron.app, BrowserWindow, Tray, ipcMain: electron.ipcMain, safeStorage: electron.safeStorage,
  clipboard: { writeText() { throw new Error('Clipboard is disabled in the snapshot benchmark') } },
  dialog: { showSaveDialog() { throw new Error('File export is disabled in the snapshot benchmark') } },
  globalShortcut: { register: () => true, unregisterAll() {} },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  nativeImage: { createFromDataURL: () => inertImage, createFromPath: () => inertImage },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
  session: { get defaultSession() {
    assert.ok(electron.app.isReady())
    return {
      setPermissionRequestHandler() { electron.session.defaultSession.setPermissionRequestHandler((_c, _p, respond) => respond(false)) },
      setPermissionCheckHandler() { electron.session.defaultSession.setPermissionCheckHandler(() => false) }
    }
  } }
}
