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

function buildWhere({ search = '', district = '', thana = '', type = '' } = {}) {
  const where = [];
  const params = {};
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
    .prepare('SELECT * FROM businesses' + clause + ' ORDER BY id DESC LIMIT @limit OFFSET @offset')
    .all({ ...params, limit, offset });
  return { total, rows };
}

const listBusinessTypes = () => stmtTypes.all().map((r) => r.business_type);

module.exports = {
  db, insertBusiness, isDuplicate, list, listPage, listBusinessTypes,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, getSettings, saveSetting,
};
