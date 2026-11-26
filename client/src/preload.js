const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexel', {
  hwid: () => ipcRenderer.invoke('app:hwid'),
  login: () => ipcRenderer.invoke('auth:start'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  restore: () => ipcRenderer.invoke('auth:restore'),
  checkSession: () => ipcRenderer.invoke('auth:check'),
  redeem: (key) => ipcRenderer.invoke('license:redeem', key),
  launch: (path) => ipcRenderer.invoke('app:launch', path),
  stop: () => ipcRenderer.invoke('app:stop'),
  pickExe: () => ipcRenderer.invoke('app:pick'),
  openExternal: (url) => ipcRenderer.invoke('app:open', url),
  apiBase: () => ipcRenderer.invoke('app:api'),
  minimize: () => ipcRenderer.send('window:minimize-now'),
  close: () => ipcRenderer.send('window:close-now')
});