import { contextBridge, ipcRenderer } from 'electron'
import type { LingoAPI, Snapshot } from '../shared/types'
const api: LingoAPI = {
  dictionary: {
    availability: () => ipcRenderer.invoke('lingo:dictionary-availability'),
    open: input => ipcRenderer.invoke('lingo:dictionary-open', input),
    openEncounter: id => ipcRenderer.invoke('lingo:dictionary-open-encounter', id),
    release: handle => ipcRenderer.invoke('lingo:dictionary-release', handle),
    explain: input => ipcRenderer.invoke('lingo:dictionary-explain', input),
    cancel: (id, attempt) => ipcRenderer.invoke('lingo:dictionary-cancel', id, attempt),
    retrySave: (id, attempt) => ipcRenderer.invoke('lingo:dictionary-retry-save', id, attempt),
    discardUnsaved: (id, attempt) => ipcRenderer.invoke('lingo:dictionary-discard-unsaved', id, attempt),
    list: query => ipcRenderer.invoke('lingo:dictionary-list', query),
    get: id => ipcRenderer.invoke('lingo:dictionary-get', id),
    edit: (id, input) => ipcRenderer.invoke('lingo:dictionary-edit', id, input),
    remove: id => ipcRenderer.invoke('lingo:dictionary-remove', id),
    export: format => ipcRenderer.invoke('lingo:dictionary-export', format),
    reviewState: session => ipcRenderer.invoke('lingo:dictionary-review-state', session),
    endReview: session => ipcRenderer.invoke('lingo:dictionary-review-end', session),
    startReview: () => ipcRenderer.invoke('lingo:dictionary-review-start'),
    reveal: (session, id, explanation) => ipcRenderer.invoke('lingo:dictionary-review-reveal', session, id, explanation),
    rate: (session, reveal, response) => ipcRenderer.invoke('lingo:dictionary-review-rate', session, reveal, response),
    skip: session => ipcRenderer.invoke('lingo:dictionary-review-skip', session),
    undo: (session, event) => ipcRenderer.invoke('lingo:dictionary-review-undo', session, event),
    onChanged: callback => {
      const listener = () => callback()
      ipcRenderer.on('lingo:dictionary-changed', listener)
      return () => ipcRenderer.removeListener('lingo:dictionary-changed', listener)
    }
  },
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
