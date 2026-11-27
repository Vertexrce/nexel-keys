const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
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
let activeChild = null;

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

/* ---------------- launch profile ---------------- */
const FORTNITE_EXE = 'FortniteClient-Win64-Shipping.exe';
const EAC_WRAPPERS = [
  'fortniteclient-win64-shipping_eac_eos.exe',
  'fortniteclient-win64-shipping_eac.exe',
  'fortnitelauncher.exe'
];
// Base args Fortnite needs when it is started outside the Epic Games Launcher.
// -fromfl / -caldera / -startup are deliberately omitted: they belong to the
// EAC bootstrap path we are skipping.
const BASE_ARGS = [
  '-epicapp=Fortnite',
  '-epicenv=Prod',
  '-epiclocale=en-us',
  '-epicsandboxid=fn'
];

function cfgPath() {
  return path.join(app.getPath('userData'), 'launch.json');
}

function readCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    return { target: c.target || null, args: c.args || '' };
  } catch {
    return { target: null, args: '' };
  }
}

function writeCfg(c) {
  try { fs.writeFileSync(cfgPath(), JSON.stringify({ target: c.target || null, args: c.args || '' })); } catch {}
}

// Point any EAC wrapper at the plain Shipping binary in the same directory.
function stripEac(target) {
  const base = path.basename(target).toLowerCase();
  if (!EAC_WRAPPERS.includes(base)) return { target, swapped: false };
  const clean = path.join(path.dirname(target), FORTNITE_EXE);
  if (fs.existsSync(clean)) return { target: clean, swapped: true };
  return { target, swapped: false };
}

function splitArgs(s) {
  return (String(s || '').match(/"[^"]*"|\S+/g) || []).map(a => a.replace(/^"|"$/g, ''));
}

function findFortnite() {
  const roots = [];
  const manifestDir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  try {
    for (const f of fs.readdirSync(manifestDir)) {
      if (!f.endsWith('.item')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(manifestDir, f), 'utf8'));
        if (String(j.AppName || '').toLowerCase() === 'fortnite' && j.InstallLocation) {
          roots.push(j.InstallLocation);
        }
      } catch {}
    }
  } catch {}
  roots.push(
    'C:\\Program Files\\Epic Games\\Fortnite',
    'C:\\Program Files (x86)\\Epic Games\\Fortnite',
    'D:\\Epic Games\\Fortnite',
    'E:\\Epic Games\\Fortnite',
    'D:\\Fortnite',
    'E:\\Fortnite'
  );
  for (const root of roots) {
    const exe = path.join(root, 'FortniteGame', 'Binaries', 'Win64', FORTNITE_EXE);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
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
ipcMain.handle('window:minimize', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && !target.isDestroyed()) target.minimize();
  return true;
});
ipcMain.handle('window:close', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && !target.isDestroyed()) target.close();
  return true;
});
// Fire-and-forget handlers back the visible custom title-bar controls. These
// avoid a renderer awaiting an invoke response while the window is closing.
ipcMain.on('window:minimize-now', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && !target.isDestroyed()) target.minimize();
});
ipcMain.on('window:close-now', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && !target.isDestroyed()) target.close();
});
ipcMain.handle('app:hwid', () => getHwid());
ipcMain.handle('app:open', (_e, url) => shell.openExternal(url));

ipcMain.handle('app:cfg:get', () => {
  const cfg = readCfg();
  return { target: cfg.target, args: cfg.args };
});

ipcMain.handle('app:cfg:set', (_e, c) => {
  const cur = readCfg();
  writeCfg({ target: c?.target ?? cur.target, args: c?.args ?? cur.args });
  return true;
});

ipcMain.handle('app:detect', () => {
  const found = findFortnite();
  if (!found) return { ok: false, reason: 'NOT_FOUND' };
  const cfg = readCfg();
  writeCfg({ target: found, args: cfg.args });
  return { ok: true, target: found };
});

ipcMain.handle('app:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Executable or shortcut', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
  });
  if (r.canceled) return null;
  const picked = r.filePaths[0];
  const cfg = readCfg();
  writeCfg({ target: picked, args: cfg.args });
  return picked;
});

// Pull the real auth args off a game that the Epic launcher started, so the
// no-EAC launch can reuse them instead of landing on a sign-in screen.
ipcMain.handle('app:capture', () => new Promise((resolve) => {
  const ps = [
    'Get-CimInstance Win32_Process -Filter',
    '"Name=\'FortniteClient-Win64-Shipping_EAC_EOS.exe\' OR Name=\'FortniteClient-Win64-Shipping.exe\'"',
    '| Select-Object -First 1 -ExpandProperty CommandLine'
  ].join(' ');
  execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    const raw = (stdout || '').trim();
    if (err || !raw) return resolve({ ok: false, reason: 'NOT_RUNNING' });
    let args = raw;
    if (args.startsWith('"')) {
      args = args.slice(args.indexOf('"', 1) + 1);
    } else {
      const sp = args.indexOf(' ');
      args = sp === -1 ? '' : args.slice(sp + 1);
    }
    args = args.trim();
    if (!args) return resolve({ ok: false, reason: 'NO_ARGS' });
    const cfg = readCfg();
    writeCfg({ target: cfg.target, args });
    resolve({ ok: true, args });
  });
}));

ipcMain.handle('app:launch', async (_event, payload) => {
  // Enforce licensing in the main process as well as the renderer. This makes
  // launch fail closed if a key was paused/revoked/deleted or the server is down.
  const token = readToken();
  if (!token) return { ok: false, reason: 'NO_SESSION' };
  try {
    const check = await fetch(`${API}/session/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await check.json();
    if (!check.ok) return { ok: false, reason: data.error || 'SESSION_CHECK_FAILED' };
    if (!data.license?.active) return { ok: false, reason: 'EXPIRED' };
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }

  const cfg = readCfg();
  const requested = (typeof payload === 'string' ? payload : payload?.target) || cfg.target;
  if (!requested || !fs.existsSync(requested)) return { ok: false, reason: 'TARGET_MISSING' };

  const extra = typeof payload === 'object' && payload ? (payload.args ?? cfg.args) : cfg.args;

  // Anti-cheat is disabled here: any EAC wrapper is replaced by the plain
  // Shipping binary, which boots without EAC ever being deployed.
  const { target, swapped } = stripEac(requested);
  if (swapped) win?.webContents.send('launch:out', '[ac] EAC wrapper bypassed -> ' + FORTNITE_EXE + '\n');

  writeCfg({ target: requested, args: extra });

  const ext = path.extname(target).toLowerCase();
  if (ext === '.lnk' || ext === '.url') {
    const err = await shell.openPath(target);
    return err ? { ok: false, reason: 'LAUNCH_FAILED', detail: err } : { ok: true, wrapped: true };
  }

  killTree(activeChild);
  activeChild = null;

  const args = [...BASE_ARGS, ...splitArgs(extra)];
  win?.webContents.send('launch:out', `[spawn] ${target}\n[args] ${args.join(' ') || '(none)'}\n`);

  try {
    const child = spawn(target, args, {
      cwd: path.dirname(target),
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChild = child;

    child.stdout?.on('data', d => win?.webContents.send('launch:out', String(d)));
    child.stderr?.on('data', d => win?.webContents.send('launch:out', String(d)));

    child.on('error', (err) => {
      activeChild = null;
      win?.webContents.send('launch:out', `[spawn error] ${err.message}\n`);
      win?.webContents.send('launch:exit', -1);
    });
    child.on('exit', (code) => {
      activeChild = null;
      win?.webContents.send('launch:exit', code);
    });

    return { ok: true, target };
  } catch (e) {
    activeChild = null;
    return { ok: false, reason: 'LAUNCH_FAILED', detail: String(e) };
  }
});

ipcMain.handle('app:stop', () => {
  killTree(activeChild);
  activeChild = null;
  return true;
});

ipcMain.handle('auth:logout', () => { clearToken(); return true; });

ipcMain.handle('auth:restore', async () => {
  const token = readToken();
  if (!token) return { ok: false, reason: 'NO_SESSION' };
  try {
    const r = await fetch(`${API}/session/me`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (r.status === 403 && ['KEY_PAUSED', 'KEY_DELETED', 'KEY_REVOKED'].includes(data.error)) {
      return { ok: false, reason: data.error, token, user: data.user, license: data.license };
    }
    if (r.status === 403) { clearToken(); return { ok: false, reason: data.error || 'FORBIDDEN' }; }
    if (!r.ok) { clearToken(); return { ok: false, reason: 'EXPIRED' }; }
    return { ok: true, token, ...data };
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }
});

// Periodic desktop check used to enforce admin pause/delete actions on active sessions.
ipcMain.handle('auth:check', async () => {
  const token = readToken();
  if (!token) return { ok: false, reason: 'NO_SESSION' };
  try {
    const r = await fetch(`${API}/session/me`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (r.status === 403 && ['KEY_PAUSED', 'KEY_DELETED', 'KEY_REVOKED'].includes(data.error)) {
      return { ok: false, reason: data.error, token, user: data.user, license: data.license };
    }
    if (r.status === 403) return { ok: false, reason: data.error || 'FORBIDDEN' };
    if (!r.ok) return { ok: false, reason: data.error || 'SESSION_CHECK_FAILED' };
    return { ok: true, token, ...data };
  } catch {
    return { ok: false, reason: 'OFFLINE' };
  }
});

ipcMain.handle('auth:start', () => new Promise((resolve) => {
  const state = crypto.randomBytes(16).toString('hex');
  let settled = false;
  let timeoutHandle = null;

  const done = (payload) => {
    if (settled) return;
    settled = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { oauthServer?.close(); } catch {}
    oauthServer = null;
    resolve(payload);
  };

  oauthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

    const returnedState = url.searchParams.get('state');
    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('OAuth state validation failed. You can close this tab.');
      return done({ ok: false, reason: 'STATE_MISMATCH' });
    }

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
      done({ ok: true, token: data.token, user: data.user, license: data.license, licenseStatus: data.licenseStatus || null });
    } catch {
      done({ ok: false, reason: 'NETWORK' });
    }
  });

  oauthServer.on('error', () => done({ ok: false, reason: 'PORT_BUSY' }));
  oauthServer.listen(OAUTH_PORT, '127.0.0.1', () => {
    shell.openExternal(`${API}/auth/discord?state=${state}`);
  });

  timeoutHandle = setTimeout(() => done({ ok: false, reason: 'TIMEOUT' }), 180_000);
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
