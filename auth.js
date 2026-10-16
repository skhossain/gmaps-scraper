const crypto = require('crypto');
const { db } = require('./database');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ROLES = ['admin', 'user'];

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);
db.pragma('foreign_keys = ON');

/* ---------- passwords (scrypt, no extra dependency) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// A throwaway hash so unknown usernames take as long to reject as wrong passwords.
const DUMMY_HASH = hashPassword('dummy-password');

function validateCredentials(username, password) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    return 'Username must be 3-32 characters (letters, numbers, _ . -).';
  }
  if (String(password).length < 8) return 'Password must be at least 8 characters.';
  return null;
}

/* ---------- users ---------- */
const stmtUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtUserById = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?');
const stmtUsers = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id');
const stmtInsertUser = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
const stmtSetPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const stmtDeleteUser = db.prepare('DELETE FROM users WHERE id = ?');
const stmtAdminCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");

function createUser(username, password, role = 'user') {
  const err = validateCredentials(username, password);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  if (!ROLES.includes(role)) throw Object.assign(new Error('Invalid role.'), { status: 400 });
  try {
    const info = stmtInsertUser.run(username, hashPassword(password), role);
    return info.lastInsertRowid;
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
      throw Object.assign(new Error('That username already exists.'), { status: 409 });
    }
    throw e;
  }
}

function setPassword(userId, password) {
  if (String(password).length < 8) throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
  stmtSetPassword.run(hashPassword(password), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // force re-login everywhere
}

function deleteUser(userId) {
  const user = stmtUserById.get(userId);
  if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
  if (user.role === 'admin' && stmtAdminCount.get().n <= 1) {
    throw Object.assign(new Error('Cannot delete the last admin.'), { status: 400 });
  }
  stmtDeleteUser.run(userId);
}

const listUsers = () => stmtUsers.all();
const countAdmins = () => stmtAdminCount.get().n;

/* ---------- sessions ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, s.expires_at FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 60 * 60 * 1000).unref();

/* ---------- login with brute-force throttling ---------- */
const attempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function isThrottled(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) return false;
  return a.count >= MAX_ATTEMPTS;
}
function recordFailure(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else a.count++;
}

/** Returns the user on success, null on bad credentials; throws 429 when throttled. */
function login(username, password, ip) {
  if (isThrottled(ip)) throw Object.assign(new Error('Too many failed attempts. Try again in 15 minutes.'), { status: 429 });
  const user = stmtUserByName.get(String(username));
  const ok = verifyPassword(String(password), user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(ip);
    return null;
  }
  attempts.delete(ip);
  return user;
}

/* ---------- express glue ---------- */
function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k)
  );
}

// `secure` is req.secure: true behind an HTTPS proxy (with trust proxy), false on plain-HTTP localhost.
function setSessionCookie(res, token, secure) {
  const flag = secure ? '; Secure' : '';
  res.append('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${flag}`);
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

const tokenFrom = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE];

// Public routes: the login page and login API only.
const PUBLIC_PATHS = new Set(['/login.html', '/api/login']);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const user = getSessionUser(tokenFrom(req));
  if (user) {
    req.user = user;
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in.' });
  res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  next();
}

module.exports = {
  createUser, setPassword, deleteUser, listUsers, countAdmins,
  createSession, destroySession, login, tokenFrom,
  setSessionCookie, clearSessionCookie, requireAuth, requireAdmin, ROLES,
};
