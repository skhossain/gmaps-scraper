const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'businesses.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS businesses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_type TEXT NOT NULL,
    district      TEXT NOT NULL,
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    address       TEXT NOT NULL,
    map_url       TEXT NOT NULL UNIQUE,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_businesses_district ON businesses(district);
`);

// Migration: add the thana column to databases created before it existed
if (!db.prepare('PRAGMA table_info(businesses)').all().some((c) => c.name === 'thana')) {
  db.exec("ALTER TABLE businesses ADD COLUMN thana TEXT NOT NULL DEFAULT ''");
}
// Businesses are never deleted, only deactivated (active = 0), so history and de-duplication are kept
if (!db.prepare('PRAGMA table_info(businesses)').all().some((c) => c.name === 'active')) {
  db.exec('ALTER TABLE businesses ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_businesses_district_thana ON businesses(district, thana)');

db.exec(`
  CREATE TABLE IF NOT EXISTS message_templates (
    business_type TEXT PRIMARY KEY,
    body          TEXT NOT NULL,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Named message templates, shared by WhatsApp and SMS. Placeholders like {name} are filled from the business row.
db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: carry over the old per-business-type templates once
if (!db.prepare('SELECT 1 FROM templates LIMIT 1').get()) {
  db.exec(`
    INSERT INTO templates (title, body)
    SELECT CASE WHEN business_type = '*' THEN 'Default' ELSE business_type END, body
    FROM message_templates ORDER BY business_type
  `);
}

/* ---------- CRM: message log + contact notes ---------- */
// A message is saved as a 'draft' when WhatsApp/SMS is opened and marked 'sent' manually once it really went out.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
    user_id     INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at     DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_messages_business ON messages(business_id);
  CREATE TABLE IF NOT EXISTS contact_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'note',
    note        TEXT NOT NULL,
    user_id     INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_notes_business ON contact_notes(business_id);
`);

const NOTE_KINDS = ['note', 'call', 'meeting', 'whatsapp', 'sms', 'email'];
const stmtBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?');
const stmtMessageInsert = db.prepare('INSERT INTO messages (business_id, channel, body, user_id) VALUES (?, ?, ?, ?)');
const stmtMessageStatus = db.prepare("UPDATE messages SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP END WHERE id = ?");
const stmtMessageDelete = db.prepare('DELETE FROM messages WHERE id = ?');
const stmtMessages = db.prepare(`
  SELECT m.*, u.username FROM messages m LEFT JOIN users u ON u.id = m.user_id
  WHERE m.business_id = ? ORDER BY m.id DESC
`);
const stmtNoteInsert = db.prepare('INSERT INTO contact_notes (business_id, kind, note, user_id) VALUES (?, ?, ?, ?)');
const stmtNoteDelete = db.prepare('DELETE FROM contact_notes WHERE id = ?');
const stmtNotes = db.prepare(`
  SELECT n.*, u.username FROM contact_notes n LEFT JOIN users u ON u.id = n.user_id
  WHERE n.business_id = ? ORDER BY n.id DESC
`);

const stmtBusinessActive = db.prepare('UPDATE businesses SET active = ? WHERE id = ?');
const getBusiness = (id) => stmtBusiness.get(id);
const setBusinessActive = (id, active) => stmtBusinessActive.run(active ? 1 : 0, id).changes > 0;
const createMessage = (businessId, channel, body, userId) => stmtMessageInsert.run(businessId, channel, body, userId).lastInsertRowid;
const setMessageStatus = (id, status) => stmtMessageStatus.run(status, status, id).changes > 0;
const deleteMessage = (id) => stmtMessageDelete.run(id).changes > 0;
const listMessages = (businessId) => stmtMessages.all(businessId);
const createNote = (businessId, kind, note, userId) => stmtNoteInsert.run(businessId, kind, note, userId).lastInsertRowid;
const deleteNote = (id) => stmtNoteDelete.run(id).changes > 0;
const listNotes = (businessId) => stmtNotes.all(businessId);

// Per-business activity counters, appended to business queries.
const ACTIVITY_COLUMNS = `
  (SELECT COUNT(*) FROM messages m WHERE m.business_id = businesses.id AND m.status = 'sent') AS sent_count,
  (SELECT COUNT(*) FROM messages m WHERE m.business_id = businesses.id AND m.status = 'draft') AS draft_count,
  (SELECT COUNT(*) FROM contact_notes n WHERE n.business_id = businesses.id) AS note_count,
  MAX(
    COALESCE((SELECT MAX(COALESCE(m.sent_at, m.created_at)) FROM messages m WHERE m.business_id = businesses.id), ''),
    COALESCE((SELECT MAX(n.created_at) FROM contact_notes n WHERE n.business_id = businesses.id), '')
  ) AS last_activity`;

/** CRM list: businesses matching `search` (name/phone); with no search, only those that have any activity. */
function listCrmBusinesses(search = '', limit = 100) {
  const where = search ? '(name LIKE @s OR phone LIKE @s)' : '1=1';
  const rows = db
    .prepare(`SELECT businesses.*, ${ACTIVITY_COLUMNS} FROM businesses WHERE ${where} ORDER BY id DESC`)
    .all(search ? { s: `%${search}%` } : {});
  return rows
    .filter((r) => search || r.sent_count + r.draft_count + r.note_count > 0)
    .sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''))
    .slice(0, limit);
}

const stmtTemplates = db.prepare('SELECT id, title, body FROM templates ORDER BY title COLLATE NOCASE');
const stmtTemplateInsert = db.prepare('INSERT INTO templates (title, body) VALUES (?, ?)');
const stmtTemplateUpdate = db.prepare('UPDATE templates SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const stmtTemplateDelete = db.prepare('DELETE FROM templates WHERE id = ?');
const stmtTypes = db.prepare('SELECT DISTINCT business_type FROM businesses ORDER BY business_type COLLATE NOCASE');
const stmtSettings = db.prepare('SELECT key, value FROM settings');
const stmtSettingSet = db.prepare(
  'INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

const listTemplates = () => stmtTemplates.all();
const createTemplate = (title, body) => stmtTemplateInsert.run(title, body).lastInsertRowid;
const updateTemplate = (id, title, body) => stmtTemplateUpdate.run(title, body, id).changes > 0;
const deleteTemplate = (id) => stmtTemplateDelete.run(id).changes > 0;
const getSettings = () => Object.fromEntries(stmtSettings.all().map((r) => [r.key, r.value]));
const saveSetting = (key, value) => stmtSettingSet.run({ key, value });

// Compare phones ignoring spaces, dashes, parentheses and "+"
const PHONE_NORMALIZED_SQL =
  "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+','')";

const stmtDuplicate = db.prepare(`
  SELECT 1 FROM businesses
  WHERE map_url = @map_url OR ${PHONE_NORMALIZED_SQL} = @phone_norm
  LIMIT 1
`);

const stmtInsert = db.prepare(`
  INSERT INTO businesses (business_type, district, thana, name, phone, address, map_url)
  VALUES (@business_type, @district, @thana, @name, @phone, @address, @map_url)
`);

function normalizePhone(phone) {
  return String(phone).replace(/[\s\-()+]/g, '');
}

function isDuplicate({ phone, map_url }) {
  return !!stmtDuplicate.get({ map_url, phone_norm: normalizePhone(phone) });
}

/** Returns true if inserted, false if it was a duplicate. */
function insertBusiness(record) {
  if (isDuplicate(record)) return false;
  try {
    stmtInsert.run(record);
    return true;
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw err;
  }
}

function buildWhere({ search = '', district = '', thana = '', type = '', status = 'active' } = {}) {
  const where = [];
  const params = {};
  if (status === 'active') where.push('active = 1');
  else if (status === 'inactive') where.push('active = 0');
  if (search) {
    where.push('(name LIKE @s OR phone LIKE @s OR address LIKE @s OR business_type LIKE @s)');
    params.s = `%${search}%`;
  }
  if (district) {
    where.push('district = @d');
    params.d = district;
  }
  if (thana) {
    where.push('thana = @t');
    params.t = thana;
  }
  if (type) {
    where.push('business_type = @bt');
    params.bt = type;
  }
  return { clause: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

/** All matching rows, newest first (used for the CSV export). */
function list(filters = {}) {
  const { clause, params } = buildWhere(filters);
  return db.prepare('SELECT * FROM businesses' + clause + ' ORDER BY id DESC').all(params);
}

/** One page of matching rows plus the total match count. */
function listPage(filters, limit, offset) {
  const { clause, params } = buildWhere(filters);
  const total = db.prepare('SELECT COUNT(*) AS n FROM businesses' + clause).get(params).n;
  const rows = db
    .prepare(`SELECT businesses.*, ${ACTIVITY_COLUMNS} FROM businesses` + clause + ' ORDER BY id DESC LIMIT @limit OFFSET @offset')
    .all({ ...params, limit, offset });
  return { total, rows };
}

const listBusinessTypes = () => stmtTypes.all().map((r) => r.business_type);

module.exports = {
  db, insertBusiness, isDuplicate, list, listPage, listBusinessTypes,
  NOTE_KINDS, getBusiness, setBusinessActive, createMessage, setMessageStatus, deleteMessage, listMessages,
  createNote, deleteNote, listNotes, listCrmBusinesses,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, getSettings, saveSetting,
};
