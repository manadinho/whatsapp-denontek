// conv-logger-sqlite.js
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// === DB setup ===
const DATA_DIR = path.join(__dirname, 'conversations');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'conversations.sqlite');
const db = new Database(DB_FILE, { fileMustExist: false, timeout: 5000 });

// Pragmas for reliability + speed under typical single-process usage
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sid      TEXT    NOT NULL,                 -- session/agent id (e.g., 'amber')
  jid      TEXT    NOT NULL,                 -- full JID  e.g. '92300...@s.whatsapp.net'
  number   TEXT    NOT NULL,                 -- number only e.g. '92300...'
  dir      TEXT    NOT NULL CHECK (dir IN ('in','out')),
  text     TEXT    NOT NULL,
  ts       INTEGER NOT NULL,                 -- timestamp (ms)
  iso      TEXT    NOT NULL,                  -- ISO string (UTC)
  isSynced  INTEGER NOT NULL DEFAULT 0        -- boolean (0 = false, 1 = true)
);

-- helpful indexes
CREATE INDEX IF NOT EXISTS idx_messages_sid_number_ts ON messages(sid, number, ts);
CREATE INDEX IF NOT EXISTS idx_messages_sid_ts         ON messages(sid, ts);
CREATE INDEX IF NOT EXISTS idx_messages_sid_dir_ts     ON messages(sid, dir, ts);
`);

// === helpers ===
function normalizeJid(jidOrNumber) {
  const jid = jidOrNumber.includes('@') ? jidOrNumber : `${jidOrNumber}@s.whatsapp.net`;
  const number = jid.replace('@s.whatsapp.net', '');
  return { jid, number };
}

const insertStmt = db.prepare(`
  INSERT INTO messages (sid, jid, number, dir, text, ts, iso)
  VALUES (@sid, @jid, @number, @dir, @text, @ts, @iso)
`);

const selectConvStmt = db.prepare(`
  SELECT sid, jid, number, dir, text, ts, iso
  FROM messages
  WHERE sid = ? AND number = ?
  ORDER BY ts ASC
`);

const listNumbersStmt = db.prepare(`
  SELECT DISTINCT number
  FROM messages
  WHERE sid = ?
  ORDER BY number ASC
`);

const selectAllBySidStmt = db.prepare(`
  SELECT number, sid, jid, dir, text, ts, iso
  FROM messages
  WHERE sid = ?
  ORDER BY number ASC, ts ASC
`);

const deleteAllBySidStmt = db.prepare(`
  DELETE FROM messages WHERE sid = ?
`);

const selectBySidNumberAsc  = db.prepare(`
  SELECT sid, jid, number, dir, text, ts, iso
  FROM messages
  WHERE sid = ? AND number = ?
  ORDER BY ts ASC
`);
const selectBySidNumberDesc = db.prepare(`
  SELECT sid, jid, number, dir, text, ts, iso
  FROM messages
  WHERE sid = ? AND number = ?
  ORDER BY ts DESC
`);

const countBySidNumberStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM messages WHERE sid = ? AND number = ?
`);
const deleteBySidNumberStmt = db.prepare(`
  DELETE FROM messages WHERE sid = ? AND number = ?
`);

// === public API (kept compatible with your old module) ===

/**
 * Append a message (same signature you already use).
 */
function logMessage(sid, dir, jidOrNum, text, tsMs = Date.now()) {
    console.log('====[conv-logger-sqlite] logMessage called:', { sid, dir, jidOrNum, text, tsMs });
  try {
    const { jid, number } = normalizeJid(jidOrNum);
    const result = insertStmt.run({
      sid,
      jid,
      number,
      dir,
      text: String(text ?? ''),
      ts: tsMs,
      iso: new Date(tsMs).toISOString(),
    });
    console.log('====[conv-logger-sqlite] logMessage result:', result);
  } catch (e) {
    console.error('====[conv-logger-sqlite] logMessage error:', e.message);
  }
}

/**
 * Return full conversation for an agent+number (newest last).
 */
function readConversation(sid, jidOrNum) {
  try {
    const { number } = normalizeJid(jidOrNum);
    return selectConvStmt.all(sid, number);
  } catch (e) {
    console.error('[conv-logger-sqlite] readConversation error:', e.message);
    return [];
  }
}

/**
 * List all numbers that have logs for an agent.
 */
function listNumbers(sid) {
  try {
    return listNumbersStmt.all(sid).map(r => r.number);
  } catch (e) {
    console.error('[conv-logger-sqlite] listNumbers error:', e.message);
    return [];
  }
}

/**
 * Atomically drain one agent’s logs and return { data, conversations, messages }.
 * Shape matches your previous return to keep /export-conversations working.
 * data = { [number]: Array<messageRecord> }
 */
function drainAgent(sid) {
  try {
    const rows = selectAllBySidStmt.all(sid);
    if (rows.length === 0) return { data: {}, conversations: 0, messages: 0 };

    // Group by number
    const data = {};
    let conversations = 0;
    let messages = 0;

    for (const r of rows) {
      if (!data[r.number]) { data[r.number] = []; conversations += 1; }
      data[r.number].push({
        ts: r.ts,
        iso: r.iso,
        dir: r.dir,
        jid: r.jid,
        text: r.text,
      });
      messages += 1;
    }

    const tx = db.transaction(() => {
      deleteAllBySidStmt.run(sid);
    });
    tx();

    return { data, conversations, messages };
  } catch (e) {
    console.error('[conv-logger-sqlite] drainAgent error:', e.message);
    return { data: {}, conversations: 0, messages: 0 };
  }
}

/**
 * Drain all agents and return { payload, totals }.
 */
function drainAll(agents = []) {
  const payload = {};
  let totalConvs = 0;
  let totalMsgs = 0;

  for (const sid of agents) {
    const { data, conversations, messages } = drainAgent(sid);
    payload[sid] = data;
    totalConvs += conversations;
    totalMsgs += messages;
  }
  return { payload, totals: { conversations: totalConvs, messages: totalMsgs } };
}

/**
 * Flush all logs for a single agent/session (sid).
 * Returns { sid, ok, removedFiles } — we keep the same shape; removedFiles = rows deleted.
 */
function flushLogsFor(sid) {
  try {
    const info = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE sid = ?').get(sid);
    const tx = db.transaction(() => deleteAllBySidStmt.run(sid));
    tx();
    return { sid, ok: true, removedFiles: info.c };
  } catch (e) {
    console.error('[conv-logger-sqlite] flushLogsFor error:', e.message);
    return { sid, ok: false, removedFiles: 0 };
  }
}

/**
 * No-op for SQLite; retained for API compatibility with your caller.
 */
function cleanTempDrainDirs() {
  return; // nothing to clean with SQLite
}

/**
 * Get every record for a specific sid + number.
 * @param {string} sid
 * @param {string} number   e.g. '923001234567' (no @s.whatsapp.net)
 * @param {{order?: 'ASC'|'DESC', limit?: number, offset?: number}} [opts]
 * @returns {Array<{sid:string,jid:string,number:string,dir:'in'|'out',text:string,ts:number,iso:string}>}
 */
function getRecordsBySidAndNumber(sid, number, opts = {}) {
  const order  = (opts.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const limit  = Number.isFinite(opts.limit)  ? Math.max(0, opts.limit)  : null;
  const offset = Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : 0;

  // Fast path without LIMIT/OFFSET uses precompiled statements
  if (limit === null && offset === 0) {
    return order === 'ASC'
      ? selectBySidNumberAsc.all(sid, number)
      : selectBySidNumberDesc.all(sid, number);
  }

  // Dynamic path for paging
  const sql = `
    SELECT sid, jid, number, dir, text, ts, iso
    FROM messages
    WHERE sid = ? AND number = ?
    ORDER BY ts ${order}
    LIMIT ${limit ?? -1} OFFSET ${offset}
  `;
  return db.prepare(sql).all(sid, number);
}

function markRecordsAsSynced(sid, number) {
  const sql = `
    UPDATE messages
    SET isSynced = 1
    WHERE sid = ? AND number = ? AND isSynced = 0
  `;
  const result = db.prepare(sql).run(sid, number);
  return result.changes; // number of rows updated
}

/**
 * Delete all records for a specific sid + number.
 * @returns {{sid:string, number:string, removed:number}}
 */
function deleteRecordsBySidAndNumber(sid, number) {
  try {
    const toRemove = countBySidNumberStmt.get(sid, number).c;
    const tx = db.transaction(() => deleteBySidNumberStmt.run(sid, number));
    tx();
    return { sid, number, removed: toRemove };
  } catch (e) {
    console.error('[conv-logger-sqlite] deleteRecordsBySidAndNumber error:', e.message);
    return { sid, number, removed: 0 };
  }
}

module.exports = {
  logMessage,
  readConversation,
  listNumbers,
  drainAgent,
  drainAll,
  flushLogsFor,
  cleanTempDrainDirs,
  getRecordsBySidAndNumber,
  deleteRecordsBySidAndNumber,
  markRecordsAsSynced,
};
