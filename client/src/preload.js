
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('nexel', {
  apiBase: invoke('app:api'),
  hwid: invoke('app:hwid'),

  login: invoke('auth:start'),
  restore: invoke('auth:restore'),
  checkSession: invoke('auth:check'),
  logout: invoke('auth:logout'),
  redeem: invoke('license:redeem'),

  minimize: () => ipcRenderer.send('window:minimize-now'),
  close: () => ipcRenderer.send('window:close-now'),

  cfgGet: invoke('app:cfg:get'),
  cfgSet: invoke('app:cfg:set'),
  launcherStatus: invoke('app:launcher:status'),
  detect: invoke('app:detect'),
  pickExe: invoke('app:pick'),
  captureArgs: invoke('app:capture'),
  eacDisable: invoke('app:eac:disable'),
  eacRestore: invoke('app:eac:restore'),
  launch: invoke('app:launch'),
  stop: invoke('app:stop'),

  epicStatus: invoke('epic:status'),
  epicStart: invoke('epic:start'),
  epicFinish: invoke('epic:finish'),
  epicLogout: invoke('epic:logout'),
  epicLauncher: invoke('epic:launcher'),
  epicLauncherDetect: invoke('epic:launcher:detect'),
  epicCreds: invoke('epic:creds:get'),
  epicCredsSet: invoke('epic:creds:set'),

  onLaunchOut: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('launch:out', listener);
    return () => ipcRenderer.removeListener('launch:out', listener);
  },

  onLaunchExit: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, code) => callback(code);
    ipcRenderer.on('launch:exit', listener);
    return () => ipcRenderer.removeListener('launch:exit', listener);
  }
});
