const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexel', {
  hwid: () => ipcRenderer.invoke('app:hwid'),
  login: () => ipcRenderer.invoke('auth:start'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  restore: () => ipcRenderer.invoke('auth:restore'),
  checkSession: () => ipcRenderer.invoke('auth:check'),
  redeem: (key) => ipcRenderer.invoke('license:redeem', key),
  launch: (payload) => ipcRenderer.invoke('app:launch', payload),
  stop: () => ipcRenderer.invoke('app:stop'),
  pickExe: () => ipcRenderer.invoke('app:pick'),
  detect: () => ipcRenderer.invoke('app:detect'),
  captureArgs: () => ipcRenderer.invoke('app:capture'),
  cfgGet: () => ipcRenderer.invoke('app:cfg:get'),
  cfgSet: (c) => ipcRenderer.invoke('app:cfg:set', c),
  epicStatus: () => ipcRenderer.invoke('epic:status'),
  epicStart: () => ipcRenderer.invoke('epic:start'),
  epicLogout: () => ipcRenderer.invoke('epic:logout'),
  onEpicState: (cb) => ipcRenderer.on('epic:state', (_e, d) => cb(d)),
  onLaunchOut: (cb) => ipcRenderer.on('launch:out', (_e, d) => cb(d)),
  onLaunchExit: (cb) => ipcRenderer.on('launch:exit', (_e, c) => cb(c)),
  openExternal: (url) => ipcRenderer.invoke('app:open', url),
  apiBase: () => ipcRenderer.invoke('app:api'),
  minimize: () => ipcRenderer.send('window:minimize-now'),
  close: () => ipcRenderer.send('window:close-now')
});
