const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { machineIdSync } = require('node-machine-id');

let config = { api: 'http://localhost:3000', epic: {} };
try {
  config = { ...config, ...require('./config.json') };
} catch {
  console.warn('config.json missing, falling back to localhost');
}
const API = String(config.api || '').replace(/\/$/, '');
const EPIC = String(config.epic?.base || 'https://account-public-service-prod.ol.epicgames.com').replace(/\/$/, '');
const EPIC_DEFAULT_ID = config.epic?.clientId || '';
const EPIC_DEFAULT_SECRET = config.epic?.clientSecret || '';
const OAUTH_PORT = 47823;
const DEEP_LINK = 'com.epicgames.launcher://apps/fn?action=launch&silent=true';

let win;
let oauthServer = null;
let activeChild = null;
let gameWatch = null;

/* ---------------- session token ---------------- */

function storePath() {
  return path.join(app.getPath('userData'), 'session.bin');
}

function saveToken(token) {
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(storePath(), safeStorage.encryptString(token));
  } else {
    fs.writeFileSync(storePath(), token, 'utf8');
  }
}

function readToken() {
  try {
    const buf = fs.readFileSync(storePath());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    return buf.toString('utf8');
  } catch { return null; }
}

function clearToken() {
  try { fs.unlinkSync(storePath()); } catch {}
}

/* ---------------- hwid ---------------- */

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
const BOOTSTRAPPER_EXE = 'FortniteBootstrapper.exe';
const EAC_EXES = ['EasyAntiCheat_EOS.exe', 'EasyAntiCheat.exe'];
const GAME_PROCS = [
  'FortniteBootstrapper.exe',
  'FortniteLauncher.exe',
  'FortniteClient-Win64-Shipping_EAC_EOS.exe',
  'FortniteClient-Win64-Shipping.exe'
];

const EAC_WRAPPERS = [
  'fortniteclient-win64-shipping_eac_eos.exe',
  'fortniteclient-win64-shipping_eac.exe',
  'fortnitelauncher.exe',
  'fortnitebootstrapper.exe'
];

const BASE_ARGS = [
  '-epicapp=Fortnite',
  '-epicenv=Prod',
  '-epiclocale=en-us',
  '-epicsandboxid=fn',
  '-EpicPortal'
];

function cfgPath() {
  return path.join(app.getPath('userData'), 'launch.json');
}

function readCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    return {
      target: c.target || null,
      bootstrapper: c.bootstrapper || null,
      args: c.args || '',
      mode: c.mode === 'eac' ? 'eac' : 'noeac',
      obfuscationId: c.obfuscationId || '',
      launchViaLauncher: c.launchViaLauncher !== false,
      disableAc: c.disableAc !== false
    };
  } catch {
    return {
      target: null, bootstrapper: null, args: '', mode: 'noeac', obfuscationId: '',
      launchViaLauncher: true, disableAc: true
    };
  }
}

function writeCfg(c) {
  const cur = readCfg();
  const next = {
    target: c.target ?? cur.target,
    bootstrapper: c.bootstrapper ?? cur.bootstrapper,
    args: c.args ?? cur.args,
    mode: c.mode ?? cur.mode,
    obfuscationId: c.obfuscationId ?? cur.obfuscationId,
    launchViaLauncher: c.launchViaLauncher ?? cur.launchViaLauncher,
    disableAc: c.disableAc ?? cur.disableAc
  };
  try { fs.writeFileSync(cfgPath(), JSON.stringify(next)); } catch {}
}

function stripEac(target) {
  const base = path.basename(target).toLowerCase();
  if (!EAC_WRAPPERS.includes(base)) return { target, swapped: false };
  const clean = path.join(path.dirname(target), FORTNITE_EXE);
  if (fs.existsSync(clean)) return { target: clean, swapped: true };
  return { target, swapped: false };
}

function toBootstrapper(target) {
  const candidate = path.join(path.dirname(target), BOOTSTRAPPER_EXE);
  if (fs.existsSync(candidate)) return candidate;
  return target;
}

function splitArgs(s) {
  return (String(s || '').match(/"[^"]*"|\S+/g) || []).map(a => a.replace(/^"|"$/g, ''));
}

/* ---------------- install discovery ---------------- */

function manifestDirs() {
  return [
    'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
    'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\Data\\Manifests'
  ];
}

function readManifestInfo(appName) {
  let install = null;
  let obfuscationId = '';
  for (const dir of manifestDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.item')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (String(j.AppName || '').toLowerCase() !== appName) continue;
        if (j.InstallLocation) install = j.InstallLocation;
        const m = String(j.LaunchCommand || '').match(/-obfuscationid=([A-Za-z0-9]+)/);
        if (m) obfuscationId = m[1];
      } catch {}
    }
  }
  return { install, obfuscationId };
}

function launcherInstalledDirs() {
  const out = [];
  const p = 'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat';
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const e of j.InstallationList || []) {
      if (e?.InstallLocation) out.push(e.InstallLocation);
    }
  } catch {}
  return out;
}

function regInstallDirs() {
  const out = [];
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fortnite',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fortnite',
    'HKCU\\Software\\Epic Games\\Fortnite'
  ]) {
    for (const value of ['InstallLocation', 'InstallPath']) {
      try {
        const s = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true });
        const m = s.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
        if (m) out.push(m[1].trim().replace(/^"|"$/g, ''));
      } catch {}
    }
  }
  return out;
}

function commonRoots() {
  const roots = [];
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (base) roots.push(path.join(base, 'Epic Games', 'Fortnite'));
  }
  for (const l of 'CDEFGH') {
    roots.push(`${l}:\\Epic Games\\Fortnite`, `${l}:\\Fortnite`, `${l}:\\Games\\Fortnite`);
  }
  return roots;
}

function resolveBin(dir) {
  if (!dir) return null;
  for (const b of [dir, path.join(dir, 'FortniteGame', 'Binaries', 'Win64')]) {
    const exe = path.join(b, FORTNITE_EXE);
    try { if (fs.existsSync(exe)) return b; } catch {}
  }
  return null;
}

function findFortnite() {
  const { install, obfuscationId } = readManifestInfo('fortnite');
  const roots = [
    install,
    ...launcherInstalledDirs(),
    ...regInstallDirs(),
    ...commonRoots()
  ].filter(Boolean);

  for (const root of roots) {
    const bin = resolveBin(root);
    if (!bin) continue;
    const boot = path.join(bin, BOOTSTRAPPER_EXE);
    return {
      shipping: path.join(bin, FORTNITE_EXE),
      bootstrapper: fs.existsSync(boot) ? boot : null,
      obfuscationId
    };
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

function taskkill(names) {
  if (process.platform !== 'win32') return Promise.resolve();
  return Promise.all(names.map((n) => new Promise((r) => {
    execFile('taskkill', ['/im', n, '/f'], () => r());
  })));
}

/* ---------------- anti-cheat ---------------- */

function eacDir(target) {
  if (!target) return null;
  return path.join(path.dirname(target), 'EasyAntiCheat');
}

async function killEac() {
  if (process.platform !== 'win32') return;
  await taskkill([...EAC_EXES, 'EasyAntiCheat_EOS_Setup.exe']);
  await new Promise((r) => execFile('sc', ['stop', 'EasyAntiCheat_EOS'], () => r()));
}

async function disableEac(target) {
  await killEac();
  const dir = eacDir(target);
  const renamed = [];
  if (!dir) return renamed;
  for (const name of EAC_EXES) {
    const src = path.join(dir, name);
    const bak = src + '.nexel-bak';
    try {
      if (fs.existsSync(src) && !fs.existsSync(bak)) {
        fs.renameSync(src, bak);
        renamed.push(name);
      }
    } catch {}
  }
  return renamed;
}

async function restoreEac(target) {
  const dir = eacDir(target);
  const restored = [];
  if (dir) {
    for (const name of EAC_EXES) {
      const bak = path.join(dir, name) + '.nexel-bak';
      try {
        if (fs.existsSync(bak)) {
          fs.renameSync(bak, path.join(dir, name));
          restored.push(name);
        }
      } catch {}
    }
  }
  if (process.platform === 'win32') {
    await new Promise((r) => execFile('sc', ['start', 'EasyAntiCheat_EOS'], () => r()));
  }
  return restored;
}

/* ---------------- epic: creds ---------------- */

function credsPath() {
  return path.join(app.getPath('userData'), 'epic-creds.json');
}

function epicCreds() {
  try {
    const c = JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
    if (c.clientId && c.clientSecret) return c;
  } catch {}
  return { clientId: EPIC_DEFAULT_ID, clientSecret: EPIC_DEFAULT_SECRET };
}

function epicBasic() {
  const c = epicCreds();
  return Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
}

/* ---------------- epic: dpop ---------------- */

function dpopKeyPath() {
  return path.join(app.getPath('userData'), 'dpop.json');
}

let dpopCache = null;

function dpopKeys() {
  if (dpopCache) return dpopCache;
  try {
    const stored = JSON.parse(fs.readFileSync(dpopKeyPath(), 'utf8'));
    dpopCache = {
      privateKey: crypto.createPrivateKey({ key: stored, format: 'jwk' }),
      jwk: { kty: stored.kty, crv: stored.crv, x: stored.x, y: stored.y }
    };
    return dpopCache;
  } catch {}
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  fs.writeFileSync(dpopKeyPath(), JSON.stringify(privateKey.export({ format: 'jwk' })));
  dpopCache = { privateKey, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  return dpopCache;
}

function dpopProof(method, url, nonce) {
  const { privateKey, jwk } = dpopKeys();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    htu: url.split('?')[0],
    htm: method.toUpperCase(),
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000)
  };
  if (nonce) claims.nonce = nonce;
  const input = `${b64({ typ: 'dpop+jwt', alg: 'ES256', jwk })}.${b64(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

/* ---------------- epic: account ---------------- */

function epicPath() {
  return path.join(app.getPath('userData'), 'epic.bin');
}

function saveEpic(data) {
  const raw = JSON.stringify(data);
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(epicPath(), safeStorage.encryptString(raw));
  } else {
    fs.writeFileSync(epicPath(), raw, 'utf8');
  }
}

function readEpic() {
  try {
    const buf = fs.readFileSync(epicPath());
    const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function clearEpic() {
  try { fs.unlinkSync(epicPath()); } catch {}
}

let pendingState = null;

async function epicTokenRequest(body) {
  const url = `${EPIC}/account/api/oauth/token`;
  const payload = new URLSearchParams(body).toString();

  const attempt = async (nonce) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${epicBasic()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: dpopProof('POST', url, nonce)
      },
      body: payload
    });
    const data = await r.json().catch(() => ({}));
    return { r, data };
  };

  let { r, data } = await attempt(null);
  const freshNonce = r.headers.get('dpop-nonce');
  if (!r.ok && freshNonce && data.errorCode === 'errors.com.epicgames.common.dpop.nonce_invalid') {
    ({ r, data } = await attempt(freshNonce));
  }
  if (!r.ok) {
    const err = new Error(data.errorCode || data.error || 'TOKEN_FAILED');
    err.detail = data.errorMessage || data.message || '';
    throw err;
  }
  return data;
}

async function epicAuthFetch(pathname, opts = {}) {
  const ep = readEpic();
  if (!ep?.accessToken) throw new Error('EPIC_NOT_LINKED');
  const url = `${EPIC}${pathname}`;
  const scheme = ep.tokenType === 'dpop' ? 'DPoP' : 'Bearer';
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `${scheme} ${ep.accessToken}`,
      DPoP: dpopProof(opts.method || 'GET', url)
    }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.errorCode || 'EPIC_REQUEST_FAILED');
  return data;
}

async function ensureAccessToken() {
  const ep = readEpic();
  if (!ep?.refreshToken) throw new Error('EPIC_NOT_LINKED');
  const data = await epicTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: ep.refreshToken,
    token_type: 'eg1'
  });
  saveEpic({
    ...ep,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: String(data.token_type || '').toLowerCase() === 'dpop' ? 'dpop' : 'bearer'
  });
  return data.access_token;
}

async function mintExchangeCode() {
  await ensureAccessToken();
  const data = await epicAuthFetch('/account/api/oauth/exchange?token_type=eg1');
  if (!data.code) throw new Error('EXCHANGE_FAILED');
  return data.code;
}

async function epicProfile() {
  const ep = readEpic();
  if (!ep?.accountId) return null;
  try {
    await ensureAccessToken();
    const data = await epicAuthFetch(`/account/api/public/account/${ep.accountId}`);
    return { accountId: ep.accountId, displayName: data.displayName || ep.displayName || '' };
  } catch {
    return { accountId: ep.accountId, displayName: ep.displayName || '' };
  }
}

/* ---------------- epic: launcher ---------------- */

const LAUNCHER_EXE = 'EpicGamesLauncher.exe';

function findLauncher() {
  const candidates = [
    'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
    'C:\\Program Files\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe'
  ];
  if (process.env['ProgramFiles(x86)']) {
    candidates.unshift(path.join(process.env['ProgramFiles(x86)'], 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', LAUNCHER_EXE));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', LAUNCHER_EXE));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'EpicGamesLauncher', 'Portal', 'Binaries', 'Win64', LAUNCHER_EXE));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  for (const key of [
    'HKCU\\Software\\Epic Games\\EpicGamesLauncher',
    'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher'
  ]) {
    for (const value of ['LauncherPath', 'AppDataPath']) {
      try {
        const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true });
        const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/);
        if (!m) continue;
        let p = m[1].trim().replace(/^"|"$/g, '');
        if (!/\.exe$/i.test(p)) p = path.join(p, 'Portal', 'Binaries', 'Win64', LAUNCHER_EXE);
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

// Installed if the exe, its data dirs, or the launcher protocol are present.
// The protocol check alone is enough for shell.openExternal to work.
function launcherInstalled() {
  if (process.platform !== 'win32') return false;
  if (findLauncher()) return true;

  for (const p of [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'EpicGamesLauncher') : null,
    'C:\\ProgramData\\Epic\\EpicGamesLauncher',
    'C:\\ProgramData\\Epic\\UnrealEngineLauncher'
  ]) {
    try { if (p && fs.existsSync(p)) return true; } catch {}
  }

  for (const key of [
    'HKCU\\Software\\Classes\\com.epicgames.launcher',
    'HKCR\\com.epicgames.launcher',
    'HKCU\\Software\\Epic Games\\EpicGamesLauncher',
    'HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher'
  ]) {
    try {
      execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
      return true;
    } catch {}
  }
  return false;
}

async function openLauncher() {
  try {
    await shell.openExternal(DEEP_LINK);
    return true;
  } catch {}
  const exe = findLauncher();
  if (!exe) return false;
  spawn(exe, [DEEP_LINK], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

function launcherLogPath() {
  return path.join(process.env.LOCALAPPDATA || '', 'EpicGamesLauncher', 'Saved', 'Logs', 'EpicGamesLauncher.log');
}

function readGameCommandLines() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const filter = GAME_PROCS.map((n) => `Name='${n}'`).join(' OR ');
    const ps = `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object -ExpandProperty CommandLine`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

async function captureExchangeCode(timeoutMs = 180_000) {
  if (process.platform !== 'win32') return null;
  const logPath = launcherLogPath();
  let offset = 0;
  try { offset = fs.statSync(logPath).size; } catch {}

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readGameCommandLines();
    for (const line of lines) {
      const m = line.match(/-AUTH_PASSWORD=([A-Za-z0-9]{16,})/);
      if (m) return { code: m[1], line };
    }

    try {
      const size = fs.statSync(logPath).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const len = Math.min(size - offset, 1 << 20);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(logPath, 'r');
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        offset += len;
        const m = buf.toString('utf8').replace(/\u0000/g, '').match(/-AUTH_PASSWORD=([A-Za-z0-9]{16,})/);
        if (m) return { code: m[1], line: '' };
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 900));
  }
  return null;
}

let launcherBusy = false;

async function mintCodeViaLauncher() {
  if (process.platform !== 'win32') return { ok: false, reason: 'NOT_WINDOWS' };
  if (launcherBusy) return { ok: false, reason: 'BUSY' };
  if (!launcherInstalled()) return { ok: false, reason: 'LAUNCHER_NOT_FOUND' };

  launcherBusy = true;
  try {
    if (!(await openLauncher())) return { ok: false, reason: 'LAUNCHER_NOT_FOUND' };
    const cap = await captureExchangeCode(150_000);
    if (!cap) return { ok: false, reason: 'CODE_TIMEOUT' };
    return { ok: true, code: cap.code };
  } finally {
    launcherBusy = false;
  }
}

async function killLauncherCopy() {
  await taskkill(GAME_PROCS);
  await killEac();
}

function watchGameExit() {
  if (gameWatch) clearInterval(gameWatch);
  let ticks = 0;
  gameWatch = setInterval(async () => {
    const lines = await readGameCommandLines();
    ticks += 1;
    if (!lines.length && ticks > 3) {
      clearInterval(gameWatch);
      gameWatch = null;
      win?.webContents.send('launch:exit', 0);
    }
  }, 4000);
}

/* ---------------- window ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1000,
    minHeight: 640,
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

/* ---------------- ipc: basics ---------------- */

ipcMain.handle('app:api', () => API);
ipcMain.handle('app:hwid', () => getHwid());
ipcMain.handle('app:open', (_e, url) => shell.openExternal(url));

ipcMain.on('window:minimize-now', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && !target.isDestroyed()) target.minimize();
});
ipcMain.on('window:close-now', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (target && !target.isDestroyed()) target.close();
});

/* ---------------- ipc: launch config ---------------- */

ipcMain.handle('app:cfg:get', () => readCfg());

ipcMain.handle('app:cfg:set', (_e, c) => {
  writeCfg(c || {});
  return true;
});

ipcMain.handle('app:launcher:status', () => ({ installed: launcherInstalled() }));

ipcMain.handle('app:detect', () => {
  const found = findFortnite();
  if (!found) return { ok: false, reason: 'NOT_FOUND', launcher: launcherInstalled() };
  writeCfg({
    target: found.shipping,
    bootstrapper: found.bootstrapper,
    obfuscationId: found.obfuscationId
  });
  return { ok: true, target: found.shipping, hasBootstrapper: !!found.bootstrapper };
});

ipcMain.handle('app:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Executable or shortcut', extensions: ['exe', 'lnk', 'bat', 'cmd'] }]
  });
  if (r.canceled) return null;
  const picked = r.filePaths[0];
  const boot = path.join(path.dirname(picked), BOOTSTRAPPER_EXE);
  writeCfg({ target: picked, bootstrapper: fs.existsSync(boot) ? boot : null });
  return picked;
});

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
    writeCfg({ args });
    resolve({ ok: true, args });
  });
}));

ipcMain.handle('app:eac:disable', async () => {
  const renamed = await disableEac(readCfg().target);
  return { ok: true, renamed };
});

ipcMain.handle('app:eac:restore', async () => {
  const restored = await restoreEac(readCfg().target);
  return { ok: true, restored };
});

/* ---------------- ipc: epic ---------------- */

ipcMain.handle('epic:creds:get', () => epicCreds());

ipcMain.handle('epic:creds:set', (_e, c) => {
  try {
    fs.writeFileSync(credsPath(), JSON.stringify({
      clientId: String(c?.clientId || '').trim(),
      clientSecret: String(c?.clientSecret || '').trim()
    }));
  } catch {}
  return true;
});

ipcMain.handle('epic:status', async () => {
  const ep = readEpic();
  if (!ep?.refreshToken) return { linked: false };
  const prof = await epicProfile();
  return { linked: true, accountId: prof?.accountId || ep.accountId, displayName: prof?.displayName || '' };
});

ipcMain.handle('epic:launcher:detect', () => ({ installed: launcherInstalled() }));

ipcMain.handle('epic:launcher', async () => {
  const r = await mintCodeViaLauncher();
  if (!r.ok) return r;
  await killLauncherCopy();
  return r;
});

ipcMain.handle('epic:start', async () => {
  const c = epicCreds();
  if (!c.clientId || !c.clientSecret) return { ok: false, reason: 'NO_CLIENT_CREDS' };
  pendingState = crypto.randomBytes(8).toString('hex');
  const url = `https://www.epicgames.com/id/api/redirect?clientId=${encodeURIComponent(c.clientId)}&responseType=code`;
  await shell.openExternal(url);
  return { ok: true, url, state: pendingState };
});

ipcMain.handle('epic:finish', async (_e, raw) => {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'NO_CODE' };
  let code = text;
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      code = j.code || j.authorizationCode || j.exchangeCode || '';
    } catch {}
  }
  code = code.replace(/^"|"$/g, '').trim();
  if (!code) return { ok: false, reason: 'NO_CODE' };

  try {
    const data = await epicTokenRequest({
      grant_type: 'authorization_code',
      code,
      token_type: 'eg1'
    });
    if (!data.account_id) return { ok: false, reason: 'NO_ACCOUNT' };
    saveEpic({
      accountId: data.account_id,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: String(data.token_type || '').toLowerCase() === 'dpop' ? 'dpop' : 'bearer',
      displayName: data.displayName || ''
    });
    const prof = await epicProfile();
    if (prof?.displayName) saveEpic({ ...readEpic(), displayName: prof.displayName });
    pendingState = null;
    return { ok: true, accountId: data.account_id, displayName: prof?.displayName || '' };
  } catch (e) {
    return { ok: false, reason: e.message || 'AUTH_FAILED', detail: e.detail || '' };
  }
});

ipcMain.handle('epic:logout', () => {
  clearEpic();
  return true;
});

/* ---------------- ipc: launch ---------------- */

function buildArgs(cfg, extra, code) {
  const args = [...BASE_ARGS];
  if (cfg.obfuscationId) args.push(`-obfuscationid=${cfg.obfuscationId}`);
  if (code) {
    args.push('-AUTH_LOGIN=unused', `-AUTH_PASSWORD=${code}`, '-AUTH_TYPE=exchangecode');
    const ep = readEpic();
    if (ep?.displayName) args.push(`-epicusername="${ep.displayName}"`);
    if (ep?.accountId) args.push(`-epicuserid=${ep.accountId}`);
  }
  args.push(...splitArgs(extra));
  if (cfg.mode === 'noeac') {
    args.push('-noeac');
    if (!args.some(a => a.startsWith('-fromfl'))) args.push('-fromfl=be');
  }
  return args;
}

ipcMain.handle('app:launch', async (_event, payload) => {
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
  if (payload && typeof payload === 'object') {
    if (payload.mode) cfg.mode = payload.mode === 'eac' ? 'eac' : 'noeac';
    if (typeof payload.disableAc === 'boolean') cfg.disableAc = payload.disableAc;
    if (typeof payload.viaLauncher === 'boolean') cfg.launchViaLauncher = payload.viaLauncher;
    writeCfg({ mode: cfg.mode, disableAc: cfg.disableAc, launchViaLauncher: cfg.launchViaLauncher });
  }

  const requested = (typeof payload === 'string' ? payload : payload?.target) || cfg.target;
  const haveTarget = !!requested && fs.existsSync(requested);

  /* ---- launcher route: the launcher resolves the install itself ---- */
  if (cfg.launchViaLauncher) {
    if (!launcherInstalled()) return { ok: false, reason: 'LAUNCHER_NOT_FOUND' };

    if (cfg.disableAc) {
      const renamed = await disableEac(haveTarget ? requested : null);
      win?.webContents.send('launch:out', renamed.length
        ? `[ac] eac disabled (${renamed.join(', ')})\n`
        : '[ac] eac process stopped\n');
    }

    win?.webContents.send('launch:out', '[launcher] opening epic games launcher\n');
    if (!(await openLauncher())) return { ok: false, reason: 'LAUNCHER_NOT_FOUND' };

    const cap = await captureExchangeCode(180_000);
    win?.webContents.send('launch:out', cap
      ? '[auth] exchange code captured from launcher\n'
      : '[auth] no exchange code observed - sign-in screen expected\n');

    if (cfg.disableAc) await killEac();
    if (haveTarget) writeCfg({ target: requested, args: typeof payload === 'object' ? payload?.args ?? cfg.args : cfg.args });
    watchGameExit();
    return { ok: true, viaLauncher: true, authed: !!cap };
  }

  /* ---- direct route ---- */
  if (!haveTarget) return { ok: false, reason: 'TARGET_MISSING' };

  const extra = typeof payload === 'object' && payload ? (payload.args ?? cfg.args) : cfg.args;

  const resolved = cfg.mode === 'noeac'
    ? stripEac(requested)
    : { target: toBootstrapper(requested), swapped: false };
  const target = resolved.target;
  if (cfg.mode === 'noeac' && resolved.swapped) {
    win?.webContents.send('launch:out', `[ac] EAC chain bypassed -> ${FORTNITE_EXE}\n`);
  }
  writeCfg({ target: requested, args: extra });

  const ext = path.extname(target).toLowerCase();
  if (ext === '.lnk' || ext === '.url') {
    const err = await shell.openPath(target);
    return err ? { ok: false, reason: 'LAUNCH_FAILED', detail: err } : { ok: true, wrapped: true };
  }

  let code = null;
  if (readEpic()?.refreshToken) {
    try {
      code = await mintExchangeCode();
    } catch (e) {
      win?.webContents.send('launch:out', `[auth] exchange code failed: ${e.message}\n`);
    }
  }
  if (!code) {
    win?.webContents.send('launch:out', '[auth] no exchange code - sign-in screen expected\n');
  }

  killTree(activeChild);
  activeChild = null;
  if (cfg.disableAc) await disableEac(requested);

  const args = buildArgs(cfg, extra, code);
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
    child.on('exit', (exitCode) => {
      activeChild = null;
      win?.webContents.send('launch:exit', exitCode);
    });

    return { ok: true, target, mode: cfg.mode, authed: !!code };
  } catch (e) {
    activeChild = null;
    return { ok: false, reason: 'LAUNCH_FAILED', detail: String(e) };
  }
});

ipcMain.handle('app:stop', async () => {
  if (gameWatch) { clearInterval(gameWatch); gameWatch = null; }
  killTree(activeChild);
  activeChild = null;
  await taskkill(GAME_PROCS);
  await killEac();
  return true;
});

/* ---------------- ipc: license auth ---------------- */

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
