const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { machineIdSync } = require('node-machine-id');

let config = { api: 'http://localhost:3000' };
try {
  config = require('./config.json');
} catch {
  console.warn('config.json missing, falling back to localhost');
}
const API = config.api.replace(/\/$/, '');
const OAUTH_PORT = 47823;

let win;
let oauthServer = null;

function storePath() {
  return path.join(app.getPath('userData'), 'session.bin');
}

function saveToken(token) {
  const { safeStorage } = require('electron');
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(storePath(), safeStorage.encryptString(token));
  } else {
    fs.writeFileSync(storePath(), token, 'utf8');
  }
}

function readToken() {
  const { safeStorage } = require('electron');
  try {
    const buf = fs.readFileSync(storePath());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8');
  } catch { return null; }
}

function clearToken() {
  try { fs.unlinkSync(storePath()); } catch {}
}

let cachedHwid = null;
function getHwid() {
  if (cachedHwid) return cachedHwid;
  const raw = [
    machineIdSync(true),
    process.env.COMPUTERNAME || '',
    process.arch,
    process.platform
  ].join('|');
  cachedHwid = crypto.createHash('sha256').update(raw).digest('hex');
  return cachedHwid;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#03060f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('app:api', () => API);
ipcMain.handle('app:hwid', () => getHwid());
ipcMain.handle('app:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:launch', (_e, p) => {
  if (!p || !fs.existsSync(p)) return { ok: false };
  require('child_process').spawn(p, { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

ipcMain.handle('auth:logout', () => { clearToken(); return true; });

ipcMain.handle('auth:restore', async () => {
  const token = readToken();
  if (!token) return { ok: false, reason: 'NO_SESSION' };
  try {
    const r = await fetch(`${API}/session/me`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (r.status === 403) { clearToken(); return { ok: false, reason: data.error }; }
    if (!r.ok) { clearToken(); return { ok: false, reason: 'EXPIRED' }; }
    return { ok: true, token, ...data };
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }
});

ipcMain.handle('auth:start', () => new Promise((resolve) => {
  const state = crypto.randomBytes(16).toString('hex');
  let settled = false;

  const done = (payload) => {
    if (settled) return;
    settled = true;
    try { oauthServer?.close(); } catch {}
    oauthServer = null;
    resolve(payload);
  };

  oauthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

    const code = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="background:#03060f;color:#7fd7ff;font-family:sans-serif;display:grid;place-items:center;height:100vh"><h2>Login complete. You can close this tab.</h2></body></html>');

    if (!code) return done({ ok: false, reason: 'NO_CODE' });

    try {
      const r = await fetch(`${API}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, hwid: getHwid() })
      });
      const data = await r.json();
      if (!r.ok) return done({ ok: false, reason: data.error || 'EXCHANGE_FAILED' });
      saveToken(data.token);
      done({ ok: true, token: data.token, user: data.user, license: data.license });
    } catch {
      done({ ok: false, reason: 'NETWORK' });
    }
  });

  oauthServer.on('error', () => done({ ok: false, reason: 'PORT_BUSY' }));
  oauthServer.listen(OAUTH_PORT, '127.0.0.1', () => {
    shell.openExternal(`${API}/auth/discord?state=${state}`);
  });

  setTimeout(() => done({ ok: false, reason: 'TIMEOUT' }), 180_000);
}));

ipcMain.handle('license:redeem', async (_e, key) => {
  const token = readToken();
  if (!token) return { ok: false, reason: 'NO_SESSION' };
  try {
    const r = await fetch(`${API}/license/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key })
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, reason: data.error || 'FAILED' };
    saveToken(data.token);
    return { ok: true, license: data.license };
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
});
