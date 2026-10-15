// The only bridge between the page and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['context-menu', 'request-close', 'open-files', 'theme-changed']);

contextBridge.exposeInMainWorld('noteai', {
  init: () => ipcRenderer.invoke('init'),
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  saveDialog: (suggestedName) => ipcRenderer.invoke('save-dialog', suggestedName),
  saveFile: (req) => ipcRenderer.invoke('save-file', req),
  saveSession: (payload) => ipcRenderer.invoke('save-session', payload),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  rephrase: (req) => ipcRenderer.invoke('rephrase', req),
  cancelRephrase: (jobId) => ipcRenderer.invoke('cancel-rephrase', jobId),
  claudeInfo: () => ipcRenderer.invoke('claude-info'),
  replaceMisspelling: (word) => ipcRenderer.send('replace-misspelling', word),
  addToDictionary: (word) => ipcRenderer.send('add-to-dictionary', word),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  closeWindow: () => ipcRenderer.send('window:close'),
  on: (event, callback) => {
    if (EVENTS.has(event)) ipcRenderer.on(event, (_e, data) => callback(data));
  },
});
