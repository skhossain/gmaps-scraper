const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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

/* ---------- Indexes for large datasets (hundreds of thousands of rows) ---------- */
db.exec(`
  -- filters + COUNT(*) + ORDER BY id DESC on the collector table (active is always part of the filter)
  CREATE INDEX IF NOT EXISTS idx_businesses_active_id ON businesses(active, id);
  CREATE INDEX IF NOT EXISTS idx_businesses_active_district_thana ON businesses(active, district, thana, id);
  CREATE INDEX IF NOT EXISTS idx_businesses_active_type ON businesses(active, business_type, id);
  -- type dropdown (distinct list) reads this index instead of scanning the table
  CREATE INDEX IF NOT EXISTS idx_businesses_type ON businesses(business_type);
`);

// Substring search (name, phone, address, type) via an FTS5 trigram index: LIKE '%x%' cannot use a normal index
// and scans every row. External-content table, kept in sync by triggers.
const ftsIsNew = !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'businesses_fts'").get();
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS businesses_fts USING fts5(
    name, phone, address, business_type,
    content = 'businesses', content_rowid = 'id', tokenize = 'trigram'
  );
  CREATE TRIGGER IF NOT EXISTS businesses_fts_ai AFTER INSERT ON businesses BEGIN
    INSERT INTO businesses_fts(rowid, name, phone, address, business_type)
    VALUES (new.id, new.name, new.phone, new.address, new.business_type);
  END;
  CREATE TRIGGER IF NOT EXISTS businesses_fts_ad AFTER DELETE ON businesses BEGIN
    INSERT INTO businesses_fts(businesses_fts, rowid, name, phone, address, business_type)
    VALUES ('delete', old.id, old.name, old.phone, old.address, old.business_type);
  END;
  CREATE TRIGGER IF NOT EXISTS businesses_fts_au AFTER UPDATE OF name, phone, address, business_type ON businesses BEGIN
    INSERT INTO businesses_fts(businesses_fts, rowid, name, phone, address, business_type)
    VALUES ('delete', old.id, old.name, old.phone, old.address, old.business_type);
    INSERT INTO businesses_fts(rowid, name, phone, address, business_type)
    VALUES (new.id, new.name, new.phone, new.address, new.business_type);
  END;
`);
if (ftsIsNew) db.exec("INSERT INTO businesses_fts(businesses_fts) VALUES ('rebuild')"); // index rows that already exist

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
  CREATE INDEX IF NOT EXISTS idx_messages_business ON messages(business_id, status);
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

// businesses.last_activity = newest message/note time. Triggers keep it current, so the CRM can list
// "contacted" businesses straight from an index instead of aggregating every message and note.
if (!db.prepare('PRAGMA table_info(businesses)').all().some((c) => c.name === 'last_activity')) {
  db.exec('ALTER TABLE businesses ADD COLUMN last_activity TEXT');
  db.exec(`
    UPDATE businesses SET last_activity = (
      SELECT MAX(ts) FROM (
        SELECT MAX(COALESCE(sent_at, created_at)) AS ts FROM messages WHERE business_id = businesses.id
        UNION ALL SELECT MAX(created_at) FROM contact_notes WHERE business_id = businesses.id
      )
    ) WHERE id IN (SELECT business_id FROM messages UNION SELECT business_id FROM contact_notes)
  `);
}
db.exec('DROP INDEX IF EXISTS idx_businesses_last_activity');
db.exec('CREATE INDEX IF NOT EXISTS idx_businesses_recent ON businesses(last_activity DESC, id DESC) WHERE last_activity IS NOT NULL');
const REFRESH_ACTIVITY = (id) => `
  UPDATE businesses SET last_activity = (
    SELECT MAX(ts) FROM (
      SELECT MAX(COALESCE(sent_at, created_at)) AS ts FROM messages WHERE business_id = ${id}
      UNION ALL SELECT MAX(created_at) FROM contact_notes WHERE business_id = ${id}
    )
  ) WHERE id = ${id};`;
for (const [table, ts] of [['messages', 'COALESCE(sent_at, created_at)'], ['contact_notes', 'created_at']]) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_activity_ai AFTER INSERT ON ${table} BEGIN ${REFRESH_ACTIVITY('new.business_id')} END;
    CREATE TRIGGER IF NOT EXISTS ${table}_activity_au AFTER UPDATE ON ${table} BEGIN ${REFRESH_ACTIVITY('new.business_id')} END;
    CREATE TRIGGER IF NOT EXISTS ${table}_activity_ad AFTER DELETE ON ${table} BEGIN ${REFRESH_ACTIVITY('old.business_id')} END;
  `);
}

const NOTE_KINDS = ['note', 'call', 'meeting', 'whatsapp', 'sms', 'email'];
const stmtBusiness = db.prepare('SELECT * FROM businesses WHERE id = ?');
const stmtMessageInsert = db.prepare('INSERT INTO messages (business_id, channel, body, user_id) VALUES (?, ?, ?, ?)');
const stmtMessageStatus = db.prepare("UPDATE messages SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP END WHERE id = ?");
const stmtMessageDelete = db.prepare('DELETE FROM messages WHERE id = ?');
// The users table is created by auth.js (loaded after this file), so these two are prepared on first use.
const lazy = (sql) => {
  let stmt;
  return () => (stmt ||= db.prepare(sql));
};
const stmtMessages = lazy(`
  SELECT m.*, u.username FROM messages m LEFT JOIN users u ON u.id = m.user_id
  WHERE m.business_id = ? ORDER BY m.id DESC
`);
const stmtNoteInsert = db.prepare('INSERT INTO contact_notes (business_id, kind, note, user_id) VALUES (?, ?, ?, ?)');
const stmtNoteDelete = db.prepare('DELETE FROM contact_notes WHERE id = ?');
const stmtNotes = lazy(`
  SELECT n.*, u.username FROM contact_notes n LEFT JOIN users u ON u.id = n.user_id
  WHERE n.business_id = ? ORDER BY n.id DESC
`);

const stmtBusinessActive = db.prepare('UPDATE businesses SET active = ? WHERE id = ?');
const stmtMessageById = db.prepare('SELECT * FROM messages WHERE id = ?');
const getMessage = (id) => stmtMessageById.get(id);
const getBusiness = (id) => stmtBusiness.get(id);
const setBusinessActive = (id, active) => stmtBusinessActive.run(active ? 1 : 0, id).changes > 0;
const createMessage = (businessId, channel, body, userId) => stmtMessageInsert.run(businessId, channel, body, userId).lastInsertRowid;
const setMessageStatus = (id, status) => stmtMessageStatus.run(status, status, id).changes > 0;
const deleteMessage = (id) => stmtMessageDelete.run(id).changes > 0;
const listMessages = (businessId) => stmtMessages().all(businessId);
const createNote = (businessId, kind, note, userId) => stmtNoteInsert.run(businessId, kind, note, userId).lastInsertRowid;
const deleteNote = (id) => stmtNoteDelete.run(id).changes > 0;
const listNotes = (businessId) => stmtNotes().all(businessId);

// Per-business counters. Evaluated only for the rows being returned, so every caller must LIMIT in an inner query first.
const ACTIVITY_COLUMNS = `
  (SELECT COUNT(*) FROM messages m WHERE m.business_id = b.id AND m.status = 'sent') AS sent_count,
  (SELECT COUNT(*) FROM messages m WHERE m.business_id = b.id AND m.status = 'draft') AS draft_count,
  (SELECT COUNT(*) FROM contact_notes n WHERE n.business_id = b.id) AS note_count`;

/** Search clause: FTS trigram index for 3+ characters (needs the index), plain LIKE for shorter text. */
function searchClause(search, params, columns) {
  if (search.length >= 3) {
    params.fts = (columns ? `{${columns.join(' ')}} : ` : '') + '"' + search.replace(/"/g, '""') + '"';
    return 'id IN (SELECT rowid FROM businesses_fts WHERE businesses_fts MATCH @fts)';
  }
  params.s = `%${search}%`;
  return columns
    ? '(' + columns.map((c) => `${c} LIKE @s`).join(' OR ') + ')'
    : '(name LIKE @s OR phone LIKE @s OR address LIKE @s OR business_type LIKE @s)';
}

/**
 * CRM list. With a search text or any filter it searches all businesses (name/phone), recently active first;
 * with neither, it lists only businesses that have messages or notes.
 */
function listCrmBusinesses({ search = '', district = '', thana = '', type = '' } = {}, limit = 200) {
  const { clause, params } = buildWhere({ search: '', district, thana, type, status: 'all' });
  const where = clause ? [clause.replace(' WHERE ', '')] : [];
  if (search) where.push(searchClause(search, params, ['name', 'phone']));
  const searching = where.length > 0;
  if (!searching) where.push('last_activity IS NOT NULL');
  // Without filters every row has activity, so a plain ORDER BY lets SQLite read the last_activity index in order.
  const order = searching ? 'last_activity IS NULL, last_activity DESC, id DESC' : 'last_activity DESC, id DESC';
  return db
    .prepare(`
      SELECT b.*, ${ACTIVITY_COLUMNS} FROM (
        SELECT * FROM businesses WHERE ${where.join(' AND ')}
        ORDER BY ${order} LIMIT @limit
      ) b
      ORDER BY ${order.replace(/\b(last_activity|id)\b/g, 'b.$1')}`)
    .all({ ...params, limit });
}

const stmtTemplates = db.prepare('SELECT id, title, body FROM templates ORDER BY title COLLATE NOCASE');
const stmtTemplateInsert = db.prepare('INSERT INTO templates (title, body) VALUES (?, ?)');
const stmtTemplateUpdate = db.prepare('UPDATE templates SET title = ?, body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
const stmtTemplateDelete = db.prepare('DELETE FROM templates WHERE id = ?');
// Loose index scan: jumps from one distinct type to the next instead of reading every row.
const stmtTypes = db.prepare(`
  WITH RECURSIVE t(v) AS (
    SELECT MIN(business_type) FROM businesses
    UNION ALL SELECT (SELECT MIN(business_type) FROM businesses WHERE business_type > t.v) FROM t WHERE t.v IS NOT NULL
  ) SELECT v AS business_type FROM t WHERE v IS NOT NULL AND v <> '' ORDER BY v COLLATE NOCASE`);
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

// Lets the duplicate check use an index instead of normalising every row's phone on each insert
db.exec(`CREATE INDEX IF NOT EXISTS idx_businesses_phone_norm ON businesses(${PHONE_NORMALIZED_SQL})`);

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

const stmtPhoneTail = db.prepare(`SELECT 1 FROM businesses WHERE ${PHONE_NORMALIZED_SQL} LIKE '%' || ? LIMIT 1`);

/** True if any saved phone ends with the same last 10 digits, so 01711111111 matches +880 1711-111111. */
function phoneExists(phone) {
  const tail = String(phone).replace(/\D/g, '').slice(-10);
  return tail.length >= 8 && !!stmtPhoneTail.get(tail);
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
    where.push(searchClause(search, params));
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

/** Matching rows one at a time, newest first (used for the CSV export, so nothing is held in memory). */
function iterate(filters = {}) {
  const { clause, params } = buildWhere(filters);
  return db.prepare('SELECT * FROM businesses' + clause + ' ORDER BY id DESC').iterate(params);
}

/** All matching rows as an array (small result sets only). */
const list = (filters = {}) => [...iterate(filters)];

/** One page of matching rows plus the total match count. */
function listPage(filters, limit, offset) {
  const { clause, params } = buildWhere(filters);
  const total = db.prepare('SELECT COUNT(*) AS n FROM businesses' + clause).get(params).n;
  const rows = db
    .prepare(`
      SELECT b.*, ${ACTIVITY_COLUMNS} FROM (
        SELECT * FROM businesses${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset
      ) b ORDER BY b.id DESC`)
    .all({ ...params, limit, offset });
  return { total, rows };
}

const listBusinessTypes = () => stmtTypes.all().map((r) => r.business_type);

module.exports = {
  db, insertBusiness, isDuplicate, phoneExists, list, iterate, listPage, listBusinessTypes,
  NOTE_KINDS, getMessage, getBusiness, setBusinessActive, createMessage, setMessageStatus, deleteMessage, listMessages,
  createNote, deleteNote, listNotes, listCrmBusinesses,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, getSettings, saveSetting,
};
