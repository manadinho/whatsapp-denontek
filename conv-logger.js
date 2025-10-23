// conv-logger.js
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, 'conversations');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function normalizeJid(jidOrNumber) {
  // keep full JID if provided; else convert to JID
  const jid = jidOrNumber.includes('@') ? jidOrNumber : `${jidOrNumber}@s.whatsapp.net`;
  // file-safe key (strip domain for filename)
  const number = jid.replace('@s.whatsapp.net', '');
  return { jid, number };
}

function line(record) {
  // safe stringify without newlines
  return JSON.stringify(record) + '\n';
}

/**
 * Append a message to agent/number file
 * @param {string} sid       - agent/session id (e.g., 'amber')
 * @param {'in'|'out'} dir   - direction
 * @param {string} jidOrNum  - JID or number (e.g., '92300...@s.whatsapp.net' or '92300...')
 * @param {string} text      - message text (no media)
 * @param {number} [tsMs]    - timestamp ms (default: Date.now())
 */
function logMessage(sid, dir, jidOrNum, text, tsMs = Date.now()) {
  try {
    const { jid, number } = normalizeJid(jidOrNum);
    const agentDir = path.join(ROOT_DIR, sid);
    ensureDir(agentDir);

    const file = path.join(agentDir, `${number}.jsonl`);
    const rec = {
      ts: tsMs,
      iso: new Date(tsMs).toISOString(),
      dir,                // 'in' or 'out'
      jid,                // full JID
      text: String(text ?? '')
    };
    fs.appendFileSync(file, line(rec), 'utf8');
  } catch (e) {
    console.error(`[conv-logger] logMessage error:`, e.message);
  }
}

/** Read full conversation for an agent+number (returns newest-last) */
function readConversation(sid, jidOrNum) {
  try {
    const { number } = normalizeJid(jidOrNum);
    const file = path.join(ROOT_DIR, sid, `${number}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    console.error(`[conv-logger] readConversation error:`, e.message);
    return [];
  }
}

/** List all numbers that have logs for an agent */
function listNumbers(sid) {
  try {
    const dir = path.join(ROOT_DIR, sid);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  } catch { return []; }
}

/** Atomically move an agent folder out, read it, then delete it (flush). */
function drainAgent(sid) {
  ensureDir(ROOT_DIR);
  const agentDir = path.join(ROOT_DIR, sid);
  if (!fs.existsSync(agentDir)) return { data: {}, conversations: 0, messages: 0 };

  const tmpDir = path.join(ROOT_DIR, `.drain_${sid}_${Date.now()}`);
  // Atomic swap: move the active dir away so writers immediately use a fresh dir
  fs.renameSync(agentDir, tmpDir);
  ensureDir(agentDir); // recreate empty live dir

  const result = {};
  let convCount = 0, msgCount = 0;

  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jsonl'));
  for (const f of files) {
    const number = f.replace(/\.jsonl$/, '');
    const full = path.join(tmpDir, f);
    const raw = fs.readFileSync(full, 'utf8').trim();
    if (!raw) { result[number] = []; continue; }
    const arr = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    result[number] = arr;
    convCount += 1;
    msgCount += arr.length;
  }

//   fs.rmSync(tmpDir, { recursive: true, force: true });
  return { data: result, conversations: convCount, messages: msgCount };
}

/** Drain all agents provided, return aggregated payload. */
function drainAll(agents = []) {
  const payload = {};
  let totalConvs = 0, totalMsgs = 0;

  for (const sid of agents) {
    const { data, conversations, messages } = drainAgent(sid);
    payload[sid] = data;
    totalConvs += conversations;
    totalMsgs += messages;
  }

  return { payload, totals: { conversations: totalConvs, messages: totalMsgs } };
}

/**
 * Atomically flush (delete) all logs for a single agent/session (sid).
 * Safe under concurrency: swaps the live dir out, recreates empty dir, then deletes the old one.
 * @returns {{sid:string, ok:boolean, removedFiles:number}} stats
 */
function flushLogsFor(sid) {
  try {
    ensureDir(ROOT_DIR);
    const agentDir = path.join(ROOT_DIR, sid);
    if (!fs.existsSync(agentDir)) {
      return { sid, ok: true, removedFiles: 0 };
    }

    const tmpDir = path.join(ROOT_DIR, `.flush_${sid}_${Date.now()}`);
    // Move current dir away so writers immediately start using a fresh dir
    fs.renameSync(agentDir, tmpDir);
    // Recreate an empty live dir
    ensureDir(agentDir);

    // Count files for reporting (optional)
    let removedFiles = 0;
    try {
      removedFiles = fs.readdirSync(tmpDir).length;
    } catch {}

    // Remove old data
    fs.rmSync(tmpDir, { recursive: true, force: true });

    return { sid, ok: true, removedFiles };
  } catch (e) {
    console.error(`[conv-logger] flushLogsFor error (${sid}):`, e.message);
    return { sid, ok: false, removedFiles: 0 };
  }
}

/**
 * Remove all temporary drain/flush folders under conversations/
 * Matches names starting with ".drain_" or ".flush_".
 * @returns {{removed:string[], errors:Array<{name:string,error:string}>}}
 */
function cleanTempDrainDirs() {
  ensureDir(ROOT_DIR);
  const removed = [];
  const errors = [];

  const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (!name.startsWith('.drain_')) continue;

    const full = path.join(ROOT_DIR, name);
    try {
      // safety: ensure path is inside ROOT_DIR
      if (!full.startsWith(ROOT_DIR)) throw new Error('unsafe path');
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      errors.push({ name, error: e.message });
    }
  }
  return { removed, errors };
}

module.exports = { logMessage, readConversation, listNumbers, drainAgent, drainAll, flushLogsFor, cleanTempDrainDirs };
