import { contextBridge, ipcRenderer } from 'electron'
import type { LingoAPI, Snapshot } from '../shared/types'
const api: LingoAPI = {
  learning: {
    pin: target => ipcRenderer.invoke('lingo:learning-pin', target),
    save: edit => ipcRenderer.invoke('lingo:learning-save', edit),
    session: name => ipcRenderer.invoke('lingo:learning-session', name),
    removeNotes: id => ipcRenderer.invoke('lingo:learning-remove-notes', id),
    onQuickPin: callback => {
      const listener = () => callback()
      ipcRenderer.on('lingo:quick-pin', listener)
      return () => ipcRenderer.removeListener('lingo:quick-pin', listener)
    }
  },
  platform: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'other',
  getSnapshot: () => ipcRenderer.invoke('lingo:snapshot'),
  saveSettings: input => ipcRenderer.invoke('lingo:settings', input),
  start: () => ipcRenderer.invoke('lingo:start'),
  stop: () => ipcRenderer.invoke('lingo:stop'),
  pushMicrophone: (chunk, run) => ipcRenderer.send('lingo:pcm', chunk, run),
  microphoneFailed: (message, run) => ipcRenderer.send('lingo:microphone-failed', message, run),
  microphoneReady: run => ipcRenderer.send('lingo:microphone-ready', run),
  translateText: text => ipcRenderer.invoke('lingo:text', text),
  retry: id => ipcRenderer.invoke('lingo:retry', id),
  retryAnnotation: id => ipcRenderer.invoke('lingo:retry-annotation', id),
  toggleSaved: id => ipcRenderer.invoke('lingo:save-caption', id),
  exportSaved: () => ipcRenderer.invoke('lingo:export'),
  copyText: text => ipcRenderer.invoke('lingo:copy', text),
  importLocalKey: () => ipcRenderer.invoke('lingo:import-local-key'),
  setCollapsed: value => ipcRenderer.invoke('lingo:collapse', value),
  setCompactHeight: height => ipcRenderer.invoke('lingo:compact-height', height),
  hide: () => ipcRenderer.invoke('lingo:hide'),
  quit: () => ipcRenderer.invoke('lingo:quit'),
  onSnapshot: callback => {
    const listener = (_event: unknown, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('lingo:changed', listener)
    return () => ipcRenderer.removeListener('lingo:changed', listener)
  },
  onMicrophone: callback => {
    const listener = (_event: unknown, enabled: boolean, run: number, deviceId: string) => callback(enabled, run, deviceId)
    ipcRenderer.on('lingo:microphone', listener)
    return () => ipcRenderer.removeListener('lingo:microphone', listener)
  }
}
contextBridge.exposeInMainWorld('lingo', api)
