require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const { TIERS } = require('./tiers');

const {
  PORT = 3000,
  PUBLIC_URL = 'http://localhost:3000',
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI = 'http://127.0.0.1:47823/callback',
  JWT_SECRET,
  HWID_SALT = 'nexel',
  ALLOWED_GUILD_ID
} = process.env;

if (!JWT_SECRET) { console.error('Missing JWT_SECRET'); process.exit(1); }

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateKey() {
  const b = crypto.randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += ALPHABET[b[i] % 32];
  return 'NEXEL-' + s.match(/.{5}/g).join('-');
}

const hashHwid = (h) => crypto.createHash('sha256').update(h + HWID_SALT).digest('hex');

/* ---------------- simple rate limit ---------------- */
const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(key) || { n: 0, t: now };
  if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(key, rec);
  return rec.n <= max;
}

/* ---------------- auth helpers ---------------- */
function issueToken(user) {
  return jwt.sign({ sub: user.discord_id, hwid: user.hwid }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'NO_TOKEN' });
  try {
    req.claims = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'BAD_TOKEN' });
  }
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(id);
}

function licenseState(user) {
  if (!user || !user.tier) return { active: false, tier: null, expires_at: null };
  if (user.tier === 'lifetime') return { active: true, tier: 'lifetime', expires_at: null };
  return { active: !!user.expires_at && user.expires_at > Date.now(), tier: user.tier, expires_at: user.expires_at };
}

/* ---------------- OAuth ---------------- */
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).send('Discord not configured');
  const state = req.query.state || crypto.randomBytes(16).toString('hex');
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'consent');
  res.redirect(url.toString());
});

app.post('/auth/exchange', async (req, res) => {
  const { code, hwid } = req.body || {};
  if (!code || !hwid) return res.status(400).json({ error: 'MISSING_PARAMS' });
  if (!limit('ex:' + req.ip, 20, 60_000)) return res.status(429).json({ error: 'RATE_LIMIT' });

  try {
    const body = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tr = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!tr.ok) return res.status(401).json({ error: 'DISCORD_TOKEN_FAIL' });
    const tok = await tr.json();

    const ur = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    if (!ur.ok) return res.status(401).json({ error: 'DISCORD_USER_FAIL' });
    const du = await ur.json();

    if (ALLOWED_GUILD_ID) {
      const gr = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tok.access_token}` }
      });
      const guilds = await gr.json();
      if (!Array.isArray(guilds) || !guilds.some(g => g.id === ALLOWED_GUILD_ID)) {
        return res.status(403).json({ error: 'NOT_IN_SERVER' });
      }
    }

    const hashed = hashHwid(hwid);
    let user = getUser(du.id);

    if (!user) {
      db.prepare(`INSERT INTO users (discord_id, username, avatar, hwid, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(du.id, du.username, du.avatar, hashed, Date.now());
      user = getUser(du.id);
    } else {
      db.prepare('UPDATE users SET username = ?, avatar = ? WHERE discord_id = ?')
        .run(du.username, du.avatar, du.id);
    }

    res.json({
      token: issueToken(user),
      user: {
        id: user.discord_id,
        username: user.username,
        avatar: user.avatar,
        hwidBound: !!user.hwid
      },
      license: licenseState(user)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'EXCHANGE_FAILED' });
  }
});

/* ---------------- session ---------------- */
app.get('/session/me', requireAuth, (req, res) => {
  const user = getUser(req.claims.sub);
  if (!user) return res.status(404).json({ error: 'NO_USER' });
  if (user.hwid && req.claims.hwid && user.hwid !== req.claims.hwid) {
    return res.status(403).json({ error: 'HWID_MISMATCH' });
  }
  res.json({
    user: { id: user.discord_id, username: user.username, avatar: user.avatar },
    license: licenseState(user)
  });
});

/* ---------------- redeem ---------------- */
app.post('/license/redeem', requireAuth, (req, res) => {
  const raw = (req.body?.key || '').trim().toUpperCase();
  if (!raw) return res.status(400).json({ error: 'NO_KEY' });
  if (!limit('rd:' + req.claims.sub, 10, 60_000)) return res.status(429).json({ error: 'RATE_LIMIT' });

  const user = getUser(req.claims.sub);
  if (!user) return res.status(404).json({ error: 'NO_USER' });

  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(raw);
  if (!row) return res.status(404).json({ error: 'INVALID_KEY' });
  if (row.revoked) return res.status(403).json({ error: 'KEY_REVOKED' });
  if (row.redeemed_by && row.redeemed_by !== user.discord_id) {
    return res.status(403).json({ error: 'KEY_USED' });
  }

  // HWID lock: first device wins
  const hwid = req.claims.hwid;
  if (!user.hwid) {
    db.prepare('UPDATE users SET hwid = ? WHERE discord_id = ?').run(hwid, user.discord_id);
  } else if (user.hwid !== hwid) {
    return res.status(403).json({ error: 'HWID_MISMATCH' });
  }

  const now = Date.now();
  let newExpiry = null;
  if (TIERS[row.tier].ms === null) {
    newExpiry = null;
  } else {
    const base = user.expires_at && user.expires_at > now && user.tier !== 'lifetime' ? user.expires_at : now;
    newExpiry = base + TIERS[row.tier].ms;
  }
  const newTier = user.tier === 'lifetime' ? 'lifetime' : row.tier;

  db.prepare('UPDATE users SET tier = ?, expires_at = ?, license_key = ? WHERE discord_id = ?')
    .run(newTier, newTier === 'lifetime' ? null : newExpiry, raw, user.discord_id);

  if (!row.redeemed_by) {
    db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?')
      .run(user.discord_id, now, newTier === 'lifetime' ? null : newExpiry, raw);
  }

  const updated = getUser(user.discord_id);
  res.json({ ok: true, license: licenseState(updated), token: issueToken(updated) });
});

/* ---------------- health ---------------- */
app.get('/health', (_req, res) => res.json({ ok: true, keys: db.prepare('SELECT COUNT(*) c FROM keys').get().c }));

app.listen(PORT, () => console.log(`[nexel] server on ${PUBLIC_URL}`));