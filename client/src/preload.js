const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexel', {
  hwid: () => ipcRenderer.invoke('app:hwid'),
  login: () => ipcRenderer.invoke('auth:start'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  restore: () => ipcRenderer.invoke('auth:restore'),
  redeem: (key) => ipcRenderer.invoke('license:redeem', key),
  launch: (path) => ipcRenderer.invoke('app:launch', path),
  pickExe: () => ipcRenderer.invoke('app:pick'),
  openExternal: (url) => ipcRenderer.invoke('app:open', url),
  apiBase: () => ipcRenderer.invoke('app:api')
});