const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 12000;
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:' + path.join(__dirname, 'waymark.db'),
  authToken: process.env.TURSO_AUTH_TOKEN,
});
async function initDb() {
  await db.batch([
    'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE,passhash TEXT,salt TEXT,code TEXT UNIQUE,created INTEGER)',
    'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT,created INTEGER)',
    'CREATE TABLE IF NOT EXISTS friends(user_id TEXT,friend_id TEXT,status TEXT,created INTEGER,PRIMARY KEY(user_id,friend_id))',
    'CREATE TABLE IF NOT EXISTS maps(id TEXT PRIMARY KEY,owner_id TEXT,name TEXT,personal INTEGER DEFAULT 0,created INTEGER)',
    'CREATE TABLE IF NOT EXISTS map_members(map_id TEXT,user_id TEXT,PRIMARY KEY(map_id,user_id))',
    'CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY,map_id TEXT,name TEXT,cat TEXT,lat REAL,lng REAL,note TEXT,photos TEXT,created_by TEXT,created INTEGER)',
    'CREATE TABLE IF NOT EXISTS reviews(place_id TEXT,user_id TEXT,rating INTEGER,kind TEXT,text TEXT,updated INTEGER,PRIMARY KEY(place_id,user_id))',
  ], 'write');
}

const uid = () => crypto.randomUUID();
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const friendCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function body(req) {
  return new Promise((ok, no) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 15e6) { no(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } });
    req.on('error', no);
  });
}
async function q(sql, args = []) { return (await db.execute({ sql, args })).rows; }
async function q1(sql, args = []) { return (await q(sql, args))[0]; }
async function run(sql, args = []) { await db.execute({ sql, args }); }

async function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!t) return null;
  return await q1('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?', [t]) || null;
}
const pub = u => ({ id: u.id, username: u.username, code: u.code });
async function mapAccess(mapId, userId) {
  const m = await q1('SELECT * FROM maps WHERE id=?', [mapId]);
  if (!m) return null;
  const member = m.owner_id === userId || await q1('SELECT 1 FROM map_members WHERE map_id=? AND user_id=?', [mapId, userId]);
  return member ? m : null;
}
async function placeWithReviews(p) {
  const reviews = await q('SELECT r.user_id AS userId,u.username,r.rating,r.kind,r.text,r.updated FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.place_id=? ORDER BY r.updated DESC', [p.id]);
  const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : null;
  const votes = { go: 0, save: 0, avoid: 0 };
  reviews.forEach(r => { if (votes[r.kind] !== undefined) votes[r.kind]++; });
  const kind = reviews.length ? Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] : 'none';
  return { ...p, photos: JSON.parse(p.photos || '[]'), reviews, avg, kind };
}

const R = [];
function on(method, pattern, needsAuth, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  R.push({ method, rx, keys, needsAuth, handler });
}

on('POST', '/api/register', false, async (req, res) => {
  const { username, password } = await body(req);
  if (!username || !/^[\w .-]{2,24}$/.test(username)) return send(res, 400, { error: 'Username must be 2–24 letters, numbers, spaces, or .-_' });
  if (!password || password.length < 4) return send(res, 400, { error: 'Password must be at least 4 characters' });
  if (await q1('SELECT 1 FROM users WHERE username=?', [username])) return send(res, 409, { error: 'That username is taken' });
  const u = { id: uid(), username, salt: crypto.randomBytes(16).toString('hex'), code: friendCode(), created: Date.now() };
  u.passhash = hash(password, u.salt);
  await run('INSERT INTO users(id,username,passhash,salt,code,created) VALUES(?,?,?,?,?,?)', [u.id, u.username, u.passhash, u.salt, u.code, u.created]);
  await run('INSERT INTO maps(id,owner_id,name,personal,created) VALUES(?,?,?,1,?)', [uid(), u.id, 'My places', Date.now()]);
  const token = uid();
  await run('INSERT INTO sessions VALUES(?,?,?)', [token, u.id, Date.now()]);
  send(res, 200, { token, user: pub(u) });
});

on('POST', '/api/login', false, async (req, res) => {
  const { username, password } = await body(req);
  const u = await q1('SELECT * FROM users WHERE username=?', [username || '']);
  if (!u || hash(password || '', u.salt) !== u.passhash) return send(res, 401, { error: 'Wrong username or password' });
  const token = uid();
  await run('INSERT INTO sessions VALUES(?,?,?)', [token, u.id, Date.now()]);
  send(res, 200, { token, user: pub(u) });
});

on('POST', '/api/logout', true, async (req, res) => {
  await run('DELETE FROM sessions WHERE token=?', [(req.headers.authorization || '').replace(/^Bearer /, '')]);
  send(res, 200, { ok: true });
});

on('GET', '/api/friends', true, async (req, res, u) => {
  const friends = await q(`SELECT u.id,u.username,u.code FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=? AND f.status='accepted'`, [u.id]);
  const incoming = await q(`SELECT u.id,u.username FROM friends f JOIN users u ON u.id=f.user_id WHERE f.friend_id=? AND f.status='pending'`, [u.id]);
  const outgoing = await q(`SELECT u.id,u.username FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=? AND f.status='pending'`, [u.id]);
  send(res, 200, { friends, incoming, outgoing });
});

on('POST', '/api/friends/add', true, async (req, res, u) => {
  const { code } = await body(req);
  const t = await q1('SELECT * FROM users WHERE code=?', [(code || '').trim().toUpperCase()]);
  if (!t) return send(res, 404, { error: 'No user found with that friend code' });
  if (t.id === u.id) return send(res, 400, { error: 'That is your own code' });
  const existing = await q1('SELECT * FROM friends WHERE user_id=? AND friend_id=?', [u.id, t.id]);
  if (existing?.status === 'accepted') return send(res, 400, { error: 'Already friends' });
  const reverse = await q1('SELECT * FROM friends WHERE user_id=? AND friend_id=?', [t.id, u.id]);
  if (reverse) {
    await run(`UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?`, [t.id, u.id]);
    await run(`INSERT OR REPLACE INTO friends VALUES(?,?,'accepted',?)`, [u.id, t.id, Date.now()]);
    return send(res, 200, { ok: true, accepted: true, friend: pub(t) });
  }
  await run(`INSERT OR REPLACE INTO friends VALUES(?,?,'pending',?)`, [u.id, t.id, Date.now()]);
  send(res, 200, { ok: true, accepted: false, friend: pub(t) });
});

on('POST', '/api/friends/accept', true, async (req, res, u) => {
  const { id } = await body(req);
  await run(`UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?`, [id, u.id]);
  await run(`INSERT OR REPLACE INTO friends VALUES(?,?,'accepted',?)`, [u.id, id, Date.now()]);
  send(res, 200, { ok: true });
});

on('DELETE', '/api/friends/:id', true, async (req, res, u, p) => {
  await run('DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)', [u.id, p.id, p.id, u.id]);
  send(res, 200, { ok: true });
});

on('GET', '/api/maps', true, async (req, res, u) => {
  const mine = await q('SELECT * FROM maps WHERE owner_id=?', [u.id]);
  const shared = await q('SELECT m.*,u.username AS ownerName FROM map_members mm JOIN maps m ON m.id=mm.map_id JOIN users u ON u.id=m.owner_id WHERE mm.user_id=? AND m.owner_id!=?', [u.id, u.id]);
  const maps = await Promise.all([...mine, ...shared].map(async m => ({ id: m.id, name: m.name, personal: !!m.personal, mine: m.owner_id === u.id, ownerName: m.ownerName || null, members: m.personal ? 0 : 1 + (await q1('SELECT COUNT(*) c FROM map_members WHERE map_id=?', [m.id])).c })));
  send(res, 200, { maps });
});

on('POST', '/api/maps', true, async (req, res, u) => {
  const { name } = await body(req);
  if (!name || !name.trim()) return send(res, 400, { error: 'Map needs a name' });
  const m = { id: uid(), name: name.trim().slice(0, 60) };
  await run('INSERT INTO maps(id,owner_id,name,personal,created) VALUES(?,?,?,0,?)', [m.id, u.id, m.name, Date.now()]);
  send(res, 200, { id: m.id, name: m.name, personal: false, mine: true });
});

on('GET', '/api/maps/:id', true, async (req, res, u, p) => {
  const m = await mapAccess(p.id, u.id);
  if (!m) return send(res, 404, { error: 'Map not found' });
  const members = await q('SELECT id,username FROM users WHERE id=? UNION SELECT u.id,u.username FROM map_members mm JOIN users u ON u.id=mm.user_id WHERE mm.map_id=?', [m.owner_id, m.id]);
  const placesRaw = await q('SELECT * FROM places WHERE map_id=? ORDER BY created DESC', [m.id]);
  const places = await Promise.all(placesRaw.map(placeWithReviews));
  send(res, 200, { map: { id: m.id, name: m.name, personal: !!m.personal, mine: m.owner_id === u.id, ownerId: m.owner_id }, members, places });
});

on('GET', '/api/maps/:id/leaderboard', true, async (req, res, u, p) => {
  const m = await mapAccess(p.id, u.id);
  if (!m) return send(res, 404, { error: 'Map not found' });
  const rows = await q(`
    SELECT u.id,u.username,
      (SELECT COUNT(*) FROM places WHERE map_id=? AND created_by=u.id) AS placesAdded,
      (SELECT COUNT(*) FROM reviews r JOIN places pl ON pl.id=r.place_id WHERE pl.map_id=? AND r.user_id=u.id) AS reviewsWritten
    FROM users u
    WHERE u.id=? OR u.id IN (SELECT user_id FROM map_members WHERE map_id=?)
  `, [m.id, m.id, m.owner_id, m.id]);
  const board = rows
    .map(r => ({ ...r, score: r.placesAdded + r.reviewsWritten }))
    .sort((a, b) => b.score - a.score || b.placesAdded - a.placesAdded || a.username.localeCompare(b.username));
  send(res, 200, { board });
});

on('DELETE', '/api/maps/:id', true, async (req, res, u, p) => {
  const m = await q1('SELECT * FROM maps WHERE id=?', [p.id]);
  if (!m || m.owner_id !== u.id || m.personal) return send(res, 403, { error: 'Only the owner can delete this map' });
  await run('DELETE FROM reviews WHERE place_id IN (SELECT id FROM places WHERE map_id=?)', [m.id]);
  await run('DELETE FROM places WHERE map_id=?', [m.id]);
  await run('DELETE FROM map_members WHERE map_id=?', [m.id]);
  await run('DELETE FROM maps WHERE id=?', [m.id]);
  send(res, 200, { ok: true });
});

on('POST', '/api/maps/:id/members', true, async (req, res, u, p) => {
  const m = await q1('SELECT * FROM maps WHERE id=?', [p.id]);
  if (!m || m.owner_id !== u.id) return send(res, 403, { error: 'Only the map owner can add members' });
  if (m.personal) return send(res, 400, { error: 'Your personal map is private — create a custom map to share' });
  const { friendId } = await body(req);
  const isFriend = await q1(`SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status='accepted'`, [u.id, friendId]);
  if (!isFriend) return send(res, 400, { error: 'You can only add accepted friends' });
  await run('INSERT OR IGNORE INTO map_members VALUES(?,?)', [p.id, friendId]);
  send(res, 200, { ok: true });
});

on('DELETE', '/api/maps/:id/members/:uid', true, async (req, res, u, p) => {
  const m = await q1('SELECT * FROM maps WHERE id=?', [p.id]);
  if (!m || m.owner_id !== u.id) return send(res, 403, { error: 'Only the map owner can remove members' });
  await run('DELETE FROM map_members WHERE map_id=? AND user_id=?', [p.id, p.uid]);
  send(res, 200, { ok: true });
});

on('POST', '/api/maps/:id/places', true, async (req, res, u, p) => {
  const m = await mapAccess(p.id, u.id);
  if (!m) return send(res, 404, { error: 'Map not found' });
  const b = await body(req);
  if (!b.name?.trim()) return send(res, 400, { error: 'Place needs a name' });
  if (!isFinite(+b.lat) || !isFinite(+b.lng)) return send(res, 400, { error: 'Place needs a location' });
  const pl = { id: uid(), name: b.name.trim().slice(0, 80) };
  await run('INSERT INTO places VALUES(?,?,?,?,?,?,?,?,?,?)', [pl.id, m.id, pl.name, b.cat || 'other', +b.lat, +b.lng, (b.note || '').slice(0, 500), JSON.stringify((b.photos || []).slice(0, 6)), u.id, Date.now()]);
  if (b.review?.rating) await run('INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?,?)', [pl.id, u.id, Math.min(5, Math.max(1, Math.round(+b.review.rating))), ['go', 'save', 'avoid'].includes(b.review.kind) ? b.review.kind : 'go', (b.review.text || '').slice(0, 500), Date.now()]);
  send(res, 200, { id: pl.id });
});

on('PUT', '/api/places/:id', true, async (req, res, u, p) => {
  const pl = await q1('SELECT * FROM places WHERE id=?', [p.id]);
  if (!pl) return send(res, 404, { error: 'Place not found' });
  const m = await q1('SELECT * FROM maps WHERE id=?', [pl.map_id]);
  if (pl.created_by !== u.id && m.owner_id !== u.id) return send(res, 403, { error: 'Only the creator or map owner can edit this place' });
  const b = await body(req);
  await run('UPDATE places SET name=?,cat=?,lat=?,lng=?,note=?,photos=? WHERE id=?', [(b.name ?? pl.name).slice(0, 80), b.cat ?? pl.cat, +(b.lat ?? pl.lat), +(b.lng ?? pl.lng), (b.note ?? pl.note).slice(0, 500), JSON.stringify((b.photos ?? JSON.parse(pl.photos)).slice(0, 6)), pl.id]);
  send(res, 200, { ok: true });
});

on('DELETE', '/api/places/:id', true, async (req, res, u, p) => {
  const pl = await q1('SELECT * FROM places WHERE id=?', [p.id]);
  if (!pl) return send(res, 404, { error: 'Place not found' });
  const m = await q1('SELECT * FROM maps WHERE id=?', [pl.map_id]);
  if (pl.created_by !== u.id && m.owner_id !== u.id) return send(res, 403, { error: 'Only the creator or map owner can delete this place' });
  await run('DELETE FROM reviews WHERE place_id=?', [pl.id]);
  await run('DELETE FROM places WHERE id=?', [pl.id]);
  send(res, 200, { ok: true });
});

on('PUT', '/api/places/:id/review', true, async (req, res, u, p) => {
  const pl = await q1('SELECT * FROM places WHERE id=?', [p.id]);
  if (!pl || !await mapAccess(pl.map_id, u.id)) return send(res, 404, { error: 'Place not found' });
  const { rating, kind, text } = await body(req);
  if (!rating || rating < 1 || rating > 5) return send(res, 400, { error: 'Rating must be 1–5' });
  await run('INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?,?)', [p.id, u.id, Math.round(rating), ['go', 'save', 'avoid'].includes(kind) ? kind : 'go', (text || '').slice(0, 500), Date.now()]);
  send(res, 200, { ok: true });
});

on('DELETE', '/api/places/:id/review', true, async (req, res, u, p) => {
  await run('DELETE FROM reviews WHERE place_id=? AND user_id=?', [p.id, u.id]);
  send(res, 200, { ok: true });
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      const route = R.find(r => r.method === req.method && r.rx.test(url.pathname));
      if (!route) return send(res, 404, { error: 'Unknown endpoint' });
      const params = {};
      const match = url.pathname.match(route.rx);
      route.keys.forEach((k, i) => params[k] = decodeURIComponent(match[i + 1]));
      const u = await auth(req);
      if (route.needsAuth && !u) return send(res, 401, { error: 'Not logged in' });
      return await route.handler(req, res, u, params);
    }
    const file = path.join(__dirname, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});
initDb()
  .then(() => server.listen(PORT, () => console.log(`waymark server on :${PORT}`)))
  .catch(e => { console.error('Failed to initialize database:', e); process.exit(1); });
