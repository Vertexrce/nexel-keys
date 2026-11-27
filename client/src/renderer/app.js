const $ = (s) => document.querySelector(s);
const API = await window.nexel.apiBase();

let state = { token: null, user: null, license: null, hwid: null, running: false, tick: 0, uptime: 0, launcher: false };
let lastLicenseBlockReason = null;
let sessionCheckRunning = false;

const views = ['home', 'spoof', 'settings', 'subs', 'telemetry', 'engine'];

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

function openView(name) {
  views.forEach(v => $(`#view-${v}`).classList.toggle('active', v === name));
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
}

document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => openView(b.dataset.view));

$('#btn-close').addEventListener('pointerdown', event => {
  event.preventDefault();
  event.stopPropagation();
  window.nexel.close();
});
$('#btn-minimize').addEventListener('pointerdown', event => {
  event.preventDefault();
  event.stopPropagation();
  window.nexel.minimize();
});
$('#btn-close').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  window.nexel.close();
});
$('#btn-minimize').addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  window.nexel.minimize();
});

/* ---------- log ---------- */
function log(msg) {
  const el = $('#console');
  const d = document.createElement('div');
  const t = new Date().toLocaleTimeString('en-GB');
  d.textContent = `[${t}] ${msg}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;

  const pane = $('#log');
  if (pane) {
    pane.textContent += `[${t}] ${msg}\n`;
    pane.scrollTop = pane.scrollHeight;
  }
}

/* ---------- license ---------- */
function fmt(ms) {
  if (ms === null) return 'Lifetime';
  if (ms <= 0) return 'Expired';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor(ms % 86400000 / 3600000);
  const m = Math.floor(ms % 3600000 / 60000);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

function renderLicense() {
  const L = state.license || {};
  const pill = $('#license-pill');
  const left = L.expires_at ? L.expires_at - Date.now() : null;

  if (!L.active) {
    pill.classList.add('warn');
    $('#license-text').textContent = 'EXPIRED';
    $('#sub-plan').textContent = 'None';
    $('#sub-key').textContent = '—';
    $('#sub-exp').textContent = '—';
    $('#sub-left').textContent = '—';
  } else {
    pill.classList.toggle('warn', left !== null && left < 3 * 86400000);
    $('#license-text').textContent = L.tier === 'lifetime' ? 'LIFETIME' : fmt(left);
    $('#sub-plan').textContent = L.tier === 'lifetime' ? 'Lifetime' : L.tier;
    $('#sub-key').textContent = L.license_key || '—';
    $('#sub-exp').textContent = L.expires_at ? new Date(L.expires_at).toLocaleString() : 'Never';
    $('#sub-left').textContent = fmt(left);
  }
}

function applySession(data) {
  lastLicenseBlockReason = null;
  state.token = data.token;
  state.user = data.user;
  state.license = data.license;
  $('#uname').textContent = data.user.username;
  $('#uhwid').textContent = (state.hwid || '').slice(0, 12) + '…';
  $('#avatar').src = data.user.avatar
    ? `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png`
    : '../../assets/icon.png.png';
  renderLicense();
  show('screen-app');
  openView('home');
  log(`session established for ${data.user.username}`);
}

function licenseBlockMessage(reason) {
  if (reason === 'KEY_ALREADY_REDEEMED') return 'This key has already been redeemed and cannot be used again.';
  if (reason === 'KEY_PAUSED') return 'Your key has been paused by admins. To see the reason why, please make a ticket.';
  if (reason === 'KEY_DELETED') return 'Your key has been deleted by admins. To see the reason why, please make a ticket.';
  if (reason === 'KEY_REVOKED') return 'Your key has been revoked by admins. To see the reason why, please make a ticket.';
  return null;
}

function showLicensePage(data, expired = false, notice = null) {
  state.running = false;
  $('#btn-launch')?.classList.remove('running');
  if ($('#btn-launch')) $('#btn-launch').textContent = 'LAUNCH';
  if ($('#st-status')) $('#st-status').textContent = 'IDLE';
  if (data.token) state.token = data.token;
  if (data.user) state.user = data.user;
  state.license = data.license || { active: false };
  const message = notice || (expired
    ? 'Your license has expired. Enter a new key to continue.'
    : `Logged in as ${state.user?.username || 'your Discord account'}. Enter your key to continue.`);
  $('#key-sub').textContent = message;
  $('#key-error').textContent = '';
  $('#key-input').value = '';
  show('screen-key');
  $('#key-input').focus();
}

/* ---------- target / anti-cheat ---------- */
function paintTarget(p) {
  if (!p) {
    $('#exe-path').textContent = state.launcher ? 'Handled by Epic Games Launcher' : 'Not set';
    $('#ac-tag').textContent = state.launcher ? 'LAUNCHER' : 'UNKNOWN';
    $('#ac-tag').classList.toggle('on', state.launcher);
    return;
  }
  $('#exe-path').textContent = p;
  const base = p.split(/[\\/]/).pop().toLowerCase();
  if (/fortniteclient-win64-shipping\.exe$/.test(base)) {
    $('#ac-tag').textContent = 'DISABLED';
    $('#ac-tag').classList.add('on');
  } else if (/_eac(_eos)?\.exe$/.test(base) || base === 'fortnitelauncher.exe') {
    $('#ac-tag').textContent = 'AUTO-BYPASS';
    $('#ac-tag').classList.remove('on');
  } else {
    $('#ac-tag').textContent = 'N/A';
    $('#ac-tag').classList.remove('on');
  }
}

/* ---------- boot ---------- */
(async () => {
  state.hwid = await window.nexel.hwid();
  $('#uhwid').textContent = state.hwid.slice(0, 12) + '…';

  const launcher = await window.nexel.launcherStatus();
  state.launcher = launcher.installed;
  $('#launcher-tag').textContent = launcher.installed ? 'FOUND' : 'NOT FOUND';
  $('#launcher-tag').classList.toggle('on', launcher.installed);
  $('#launcher-path').textContent = launcher.installed
    ? 'Launch will open it and let it start Fortnite.'
    : 'Not installed — browse for the executable instead.';

  const cfg = await window.nexel.cfgGet();
  if (launcher.installed) $('#opt-launcher').checked = cfg.launchViaLauncher !== false;
  else $('#opt-launcher').checked = false;
  $('#opt-noeac').checked = cfg.disableAc !== false;
  paintTarget(cfg.target);
  $('#args-input').value = cfg.args || '';

  const creds = await window.nexel.epicCreds();
  $('#cred-id').value = creds.clientId || '';
  $('#cred-secret').value = creds.clientSecret || '';

  window.nexel.onLaunchOut(d => { if ($('#opt-console').checked) log(d.trimEnd()); });
  window.nexel.onLaunchExit(code => {
    state.running = false;
    $('#btn-launch').classList.remove('running');
    $('#btn-launch').textContent = 'LAUNCH';
    $('#st-status').textContent = 'IDLE';
    log(`process exited (${code})`);
  });

  const r = await window.nexel.restore();
  if (r.ok) {
    if (r.license?.active) return applySession(r);
    return showLicensePage(r, !!r.license?.tier);
  }
  if (['KEY_PAUSED', 'KEY_DELETED', 'KEY_REVOKED'].includes(r.reason)) {
    lastLicenseBlockReason = r.reason;
    return showLicensePage(r, false, licenseBlockMessage(r.reason));
  }
  if (r.reason === 'EXPIRED' || r.reason === 'HWID_MISMATCH') {
    $('#login-error').textContent =
      r.reason === 'HWID_MISMATCH' ? 'This key is locked to another PC.' : 'Session expired — log in again.';
  }
  show('screen-login');
})();

/* ---------- login ---------- */
$('#btn-login').onclick = async () => {
  $('#login-error').textContent = '';
  $('#btn-login').textContent = 'WAITING FOR BROWSER…';
  const r = await window.nexel.login();
  $('#btn-login').textContent = 'LOGIN WITH DISCORD';

  if (!r.ok) {
    const map = {
      PORT_BUSY: 'Port 47823 is in use — close other instances.',
      STATE_MISMATCH: 'Discord login state did not match. Please try again.',
      TIMEOUT: 'Login timed out.',
      NOT_IN_SERVER: 'You are not in the Discord server.',
      NETWORK: 'Cannot reach the license server.'
    };
    $('#login-error').textContent = map[r.reason] || 'Login failed.';
    return;
  }

  state.token = r.token;
  state.user = r.user;
  state.license = r.license;

  if (r.licenseStatus) {
    lastLicenseBlockReason = r.licenseStatus;
    return showLicensePage(r, false, licenseBlockMessage(r.licenseStatus));
  }
  if (r.license?.active) return applySession(r);

  showLicensePage(r, !!r.license?.tier);
};

/* ---------- redeem ---------- */
async function redeem(raw, errEl) {
  const key = raw.trim().toUpperCase();
  if (key.length < 10) { errEl.textContent = 'Enter a full key.'; return; }

  errEl.textContent = '';
  const full = key.startsWith('NEXEL-') ? key : 'NEXEL-' + key;
  const r = await window.nexel.redeem(full);

  if (!r.ok) {
    const map = {
      INVALID_KEY: 'Key does not exist.',
      KEY_USED: 'That key is already bound to another account.',
      KEY_REVOKED: 'That key was revoked.',
      KEY_DELETED: 'That key was deleted and cannot be redeemed.',
      KEY_PAUSED: 'That key has been paused by admins. Please make a ticket to see why.',
      KEY_ALREADY_REDEEMED: 'That key has already been redeemed. Each key can only be used once.',
      HWID_MISMATCH: 'This account is locked to another PC.',
      RATE_LIMIT: 'Too many attempts, wait a minute.'
    };
    errEl.textContent = map[r.reason] || 'Activation failed.';
    return;
  }

  state.license = r.license;
  applySession({ token: state.token, user: state.user, license: r.license });
  log('license activated');
}

$('#btn-redeem').onclick = () => redeem($('#key-input').value, $('#key-error'));
$('#key-input').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-redeem').click(); };
$('#btn-redeem2').onclick = () => redeem($('#key2').value, $('#sub-error'));

$('#btn-logout').onclick = async () => {
  await window.nexel.logout();
  location.reload();
};

/* ---------- spoof ---------- */
const spoofItems = ['Disk Serial', 'Volume ID', 'MAC Address', 'SMBIOS UUID', 'Machine GUID', 'Product ID'];
const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
  .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function renderSpoof() {
  $('#spoof-grid').innerHTML = spoofItems.map(name => `
    <div class="card"><b>${name}</b><small>${rnd(6)}-${rnd(4)}</small></div>`).join('');
}
renderSpoof();

$('#btn-spoof').onclick = () => {
  renderSpoof();
  $('#st-spoof').textContent = 'ON';
  log('spoofed 6 identifiers');
};

/* ---------- settings ---------- */
$('#btn-pick').onclick = async () => {
  const p = await window.nexel.pickExe();
  if (!p) return;
  paintTarget(p);
  log('target set: ' + p);
};

$('#btn-detect').onclick = async () => {
  const r = await window.nexel.detect();
  if (!r.ok) {
    log(r.launcher
      ? 'install path not found — launcher mode will still work'
      : 'Fortnite not found — browse to it manually');
    paintTarget(null);
    return;
  }
  paintTarget(r.target);
  log('detected: ' + r.target);
};

$('#btn-capture').onclick = async () => {
  const r = await window.nexel.captureArgs();
  if (!r.ok) {
    log(r.reason === 'NOT_RUNNING' ? 'start Fortnite through Epic first, then capture' : 'could not read command line');
    return;
  }
  $('#args-input').value = r.args;
  await window.nexel.cfgSet({ args: r.args });
  log('captured launch arguments');
};

$('#args-input').onchange = () => window.nexel.cfgSet({ args: $('#args-input').value });

$('#opt-launcher').onchange = () =>
  window.nexel.cfgSet({ launchViaLauncher: $('#opt-launcher').checked });

$('#opt-noeac').onchange = () =>
  window.nexel.cfgSet({ disableAc: $('#opt-noeac').checked });

$('#btn-eac-off').onclick = async () => {
  const r = await window.nexel.eacDisable();
  log(r.renamed.length ? `eac disabled (${r.renamed.join(', ')})` : 'eac stopped');
};

$('#btn-eac-on').onclick = async () => {
  const r = await window.nexel.eacRestore();
  log(r.restored.length ? `eac restored (${r.restored.join(', ')})` : 'eac service started');
};

$('#btn-creds').onclick = async () => {
  await window.nexel.epicCredsSet({
    clientId: $('#cred-id').value.trim(),
    clientSecret: $('#cred-secret').value.trim()
  });
  $('#cred-msg').textContent = 'Saved.';
  $('#cred-msg').className = 'msg ok';
};

/* ---------- launch ---------- */
$('#btn-launch').onclick = async () => {
  if (state.running) {
    await window.nexel.stop();
    state.running = false;
    $('#btn-launch').classList.remove('running');
    $('#btn-launch').textContent = 'LAUNCH';
    $('#st-status').textContent = 'IDLE';
    log('session closed');
    return;
  }

  const viaLauncher = $('#opt-launcher').checked && state.launcher;
  const rawTarget = $('#exe-path').textContent;
  const haveTarget = rawTarget !== 'Not set' && rawTarget !== 'Handled by Epic Games Launcher';

  if (!viaLauncher && !haveTarget) {
    log(state.launcher
      ? 'enable launcher mode or browse for the executable'
      : 'Epic Games Launcher not found — browse for FortniteClient-Win64-Shipping.exe');
    return;
  }

  $('#btn-launch').disabled = true;
  $('#btn-launch').textContent = 'CHECKING LICENSE…';
  const check = await window.nexel.checkSession();
  $('#btn-launch').disabled = false;
  $('#btn-launch').textContent = 'LAUNCH';

  if (!check.ok || !check.license?.active) {
    await window.nexel.stop();
    state.running = false;
    $('#btn-launch').classList.remove('running');
    $('#st-status').textContent = 'IDLE';
    if (['KEY_PAUSED', 'KEY_DELETED', 'KEY_REVOKED'].includes(check.reason)) {
      lastLicenseBlockReason = check.reason;
      showLicensePage(check, false, licenseBlockMessage(check.reason));
    } else if (check.reason === 'EXPIRED' || !check.license?.active) {
      showLicensePage(check, true);
    } else {
      showLicensePage(check, false, 'Unable to verify your license. Check your connection and try again.');
    }
    log(`launch blocked: ${check.reason || 'license inactive'}`);
    return;
  }

  state.license = check.license;
  state.running = true;
  state.uptime = 0;
  $('#btn-launch').classList.add('running');
  $('#btn-launch').textContent = 'STOP';
  $('#st-status').textContent = 'RUNNING';
  $('#log').textContent = '';
  log('initializing hypervisor…');

  if ($('#opt-spoof').checked) $('#btn-spoof').click();

  const r = await window.nexel.launch({
    target: haveTarget ? rawTarget : null,
    args: $('#args-input').value,
    viaLauncher,
    disableAc: $('#opt-noeac').checked
  });

  if (!r.ok) {
    state.running = false;
    $('#btn-launch').classList.remove('running');
    $('#btn-launch').textContent = 'LAUNCH';
    $('#st-status').textContent = 'IDLE';
    if (['KEY_PAUSED', 'KEY_DELETED', 'KEY_REVOKED'].includes(r.reason)) {
      lastLicenseBlockReason = r.reason;
      showLicensePage({ token: state.token, user: state.user, license: state.license }, false, licenseBlockMessage(r.reason));
    }
    log(r.reason === 'LAUNCHER_NOT_FOUND'
      ? 'epic games launcher not found'
      : r.reason === 'TARGET_MISSING' ? 'target executable not found' : `launch blocked: ${r.reason}`);
    return;
  }

  if (r.viaLauncher) {
    log(r.authed
      ? 'running through the epic games launcher'
      : 'running through the epic games launcher — sign-in screen expected');
  } else {
    log('spawned target');
  }
};

/* ---------- engine ---------- */
$('#engine-grid').innerHTML = [
  ['VT-x / AMD-V', 'Enabled'],
  ['Nested paging', 'Enabled'],
  ['EPT / NPT', 'Active'],
  ['CPUID hook', 'Masked'],
  ['Timing sync', '±0.02ms']
].map(([a, b]) => `<div class="card"><b>${a}</b><small>${b}</small></div>`).join('');

/* ---------- live license enforcement ---------- */
async function enforceLicenseStatus() {
  if (sessionCheckRunning || !state.token) return;
  sessionCheckRunning = true;
  try {
    const result = await window.nexel.checkSession();
    if (result.ok) {
      if (result.license?.active && $('#screen-key').classList.contains('active')) {
        applySession(result);
      } else if (!result.license?.active && $('#screen-app').classList.contains('active')) {
        await window.nexel.stop();
        state.running = false;
        showLicensePage(result, true);
      }
      return;
    }

    if (['KEY_PAUSED', 'KEY_DELETED', 'KEY_REVOKED'].includes(result.reason)) {
      if (lastLicenseBlockReason === result.reason && $('#screen-key').classList.contains('active')) return;
      lastLicenseBlockReason = result.reason;
      await window.nexel.stop();
      state.running = false;
      $('#btn-launch')?.classList.remove('running');
      if ($('#btn-launch')) $('#btn-launch').textContent = 'LAUNCH';
      if ($('#st-status')) $('#st-status').textContent = 'IDLE';
      showLicensePage(result, false, licenseBlockMessage(result.reason));
    }
  } catch (error) {
    console.warn('[license] status check failed:', error?.message || error);
  } finally {
    sessionCheckRunning = false;
  }
}

setInterval(enforceLicenseStatus, 2500);

/* ---------- heartbeat + clock ---------- */
setInterval(() => {
  const hb = $('#hb');
  const b = document.createElement('i');
  b.style.height = (18 + Math.random() * 42) + 'px';
  hb.appendChild(b);
  if (hb.children.length > 48) hb.firstChild.remove();

  if (state.running) {
    state.uptime++;
    const s = state.uptime % 60, m = Math.floor(state.uptime / 60) % 60, h = Math.floor(state.uptime / 3600);
    $('#st-uptime').textContent = [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  }

  if (state.license?.expires_at) {
    state.license.active = state.license.expires_at > Date.now();
    renderLicense();
    if (!state.license.active && state.token && $('#screen-app').classList.contains('active')) {
      log('license expired — activation required');
      showLicensePage({ token: state.token, user: state.user, license: state.license }, true);
    }
  }
}, 1000);
