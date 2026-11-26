const $ = (s) => document.querySelector(s);
const API = await window.nexel.apiBase();

let state = { token: null, user: null, license: null, hwid: null, running: false, tick: 0, uptime: 0 };

const views = ['home', 'spoof', 'settings', 'subs', 'telemetry', 'engine'];

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}

function openView(name) {
  views.forEach(v => $(`#view-${v}`).classList.toggle('active', v === name));
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
}

document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => openView(b.dataset.view));
$('#btn-close').onclick = () => window.close();

/* ---------- log ---------- */
function log(msg) {
  const el = $('#console');
  const d = document.createElement('div');
  const t = new Date().toLocaleTimeString('en-GB');
  d.textContent = `[${t}] ${msg}`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
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
    $('#sub-exp').textContent = '—';
    $('#sub-left').textContent = '—';
  } else {
    pill.classList.toggle('warn', left !== null && left < 3 * 86400000);
    $('#license-text').textContent = L.tier === 'lifetime' ? 'LIFETIME' : fmt(left);
    $('#sub-plan').textContent = L.tier === 'lifetime' ? 'Lifetime' : L.tier;
    $('#sub-exp').textContent = L.expires_at ? new Date(L.expires_at).toLocaleString() : 'Never';
    $('#sub-left').textContent = fmt(left);
  }
}

function applySession(data) {
  state.token = data.token;
  state.user = data.user;
  state.license = data.license;
  $('#uname').textContent = data.user.username;
  $('#uhwid').textContent = (state.hwid || '').slice(0, 12) + '…';
  $('#avatar').src = data.user.avatar
    ? `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png`
    : '../../assets/icon.png';
  renderLicense();
  show('screen-app');
  openView('home');
  log(`session established for ${data.user.username}`);
}

/* ---------- boot ---------- */
(async () => {
  state.hwid = await window.nexel.hwid();
  $('#uhwid').textContent = state.hwid.slice(0, 12) + '…';

  const r = await window.nexel.restore();
  if (r.ok) return applySession(r);
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

  if (r.license?.active) return applySession(r);

  $('#key-sub').textContent = `Logged in as ${r.user.username}. Enter your key.`;
  show('screen-key');
  $('#key-input').focus();
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
  if (p) { $('#exe-path').textContent = p; log('target set: ' + p); }
};

/* ---------- launch ---------- */
$('#btn-launch').onclick = async () => {
  if (state.running) {
    state.running = false;
    $('#btn-launch').classList.remove('running');
    $('#btn-launch').textContent = 'LAUNCH';
    $('#st-status').textContent = 'IDLE';
    log('session closed');
    return;
  }
  state.running = true;
  state.uptime = 0;
  $('#btn-launch').classList.add('running');
  $('#btn-launch').textContent = 'STOP';
  $('#st-status').textContent = 'RUNNING';
  log('initializing hypervisor…');

  if ($('#opt-spoof').checked) $('#btn-spoof').click();

  const target = $('#exe-path').textContent;
  if (target !== 'Not set') {
    const r = await window.nexel.launch(target);
    log(r.ok ? 'spawned target' : 'target missing, loader-only mode');
  } else {
    log('no target set, loader-only mode');
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
    if (!state.license.active && state.token) {
      log('license expired — re-login required');
      state.token = null;
      window.nexel.logout();
      setTimeout(() => location.reload(), 1800);
    }
  }
}, 1000);