'use strict';
/**
 * db.js — local-first SQLite store, backed by sql.js (SQLite compiled to
 * WebAssembly). No native compilation is required, so `npm install` never
 * needs Python or a C++ toolchain.
 *
 * Golden rule: LOCAL STATE IS NEVER LOST ON SYNC. Incoming source items are
 * matched to existing rows by (source, source_id) and MERGED — we update only
 * the source-derived columns and never touch checked / snoozed_until /
 * dismissed / manual. We never wipe-and-rebuild the table.
 *
 * sql.js keeps the database in memory; we persist by exporting the bytes to
 * the .sqlite file after every mutation.
 */

const path = require('node:path');
const fs = require('node:fs');
const initSqlJs = require('sql.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  conversation_id TEXT,
  title         TEXT NOT NULL,
  project       TEXT,
  scope         TEXT,
  due_date      TEXT,
  completed_date TEXT,
  url           TEXT,
  is_leaf       INTEGER DEFAULT 0,
  parent_id     TEXT,
  status        TEXT,
  priority      TEXT,
  source_done   INTEGER DEFAULT 0,
  reasons       TEXT,
  checked       INTEGER DEFAULT 0,
  checked_at    TEXT,
  snoozed_until TEXT,
  dismissed     INTEGER DEFAULT 0,
  manual        INTEGER DEFAULT 0,
  absent        INTEGER DEFAULT 0,
  due_override  TEXT,
  title_override TEXT,
  first_seen    TEXT DEFAULT (datetime('now')),
  last_synced   TEXT,
  UNIQUE(source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks(conversation_id);

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  message     TEXT,
  item_count  INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

function locateWasm(file) {
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app', 'node_modules', 'sql.js', 'dist', file)
      : null,
    process.resourcesPath
      ? path.join(process.resourcesPath, 'node_modules', 'sql.js', 'dist', file)
      : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

let SQLPromise = null;
function getSQL() {
  if (!SQLPromise) SQLPromise = initSqlJs({ locateFile: locateWasm });
  return SQLPromise;
}

class Store {
  /**
   * @param {string} dbPath
   * @returns {Promise<Store>}
   */
  static async open(dbPath) {
    const SQL = await getSQL();
    const store = new Store();
    store.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const existing = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    store.db = new SQL.Database(existing);
    store.db.run(SCHEMA);
    store._migrate();
    store._save();
    return store;
  }

  /** Additive migrations for databases created by an earlier version. */
  _migrate() {
    const cols = this.all('PRAGMA table_info(tasks)').map((r) => r.name);
    // Local due-date override: takes precedence over the synced due_date for
    // display and bucketing, and is preserved across syncs (it's local state).
    // A date string = that date; '' = deliberately no date; NULL = no override.
    if (!cols.includes('due_override')) {
      this.db.run('ALTER TABLE tasks ADD COLUMN due_override TEXT');
    }
    if (!cols.includes('title_override')) {
      this.db.run('ALTER TABLE tasks ADD COLUMN title_override TEXT');
    }
  }

  _save() {
    const data = this.db.export();
    fs.writeFileSync(this.path, Buffer.from(data));
  }

  /** Run a mutation with positional (?) params. */
  run(sql, params = []) {
    this.db.run(sql, params);
  }

  /** Return all rows (array of plain objects) for a query. */
  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      if (params && params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows.length ? rows[0] : null;
  }

  _lastInsertId() {
    const r = this.get('SELECT last_insert_rowid() AS id');
    return r ? r.id : null;
  }

  /**
   * Merge a batch of normalized source tasks. Preserves all local state.
   * @param {object[]} tasks
   * @param {string} source 'monday' | 'email'
   * @param {object} [opts] { markAbsentUnseen: boolean }
   */
  mergeTasks(tasks, source, opts = {}) {
    this.db.run('BEGIN');
    try {
      if (opts.markAbsentUnseen) {
        // Anything not re-seen below stays absent (but keeps its local state).
        this.run('UPDATE tasks SET absent=1 WHERE source=? AND manual=0', [source]);
      }
      for (const t of tasks) {
        const row = {
          source,
          source_id: String(t.sourceId),
          conversation_id: t.conversationId ?? null,
          title: t.title ?? '(untitled)',
          project: t.project ?? null,
          scope: t.scope ?? null,
          due_date: t.dueDate ?? null,
          completed_date: t.completedDate ?? null,
          url: t.url ?? null,
          is_leaf: t.isLeaf ? 1 : 0,
          parent_id: t.parentId ?? null,
          status: t.status ?? null,
          priority: t.priority ?? null,
          source_done: t.done ? 1 : 0,
          reasons: t.reasons ? JSON.stringify(t.reasons) : null,
        };
        const existing = this.get('SELECT id FROM tasks WHERE source=? AND source_id=?', [
          row.source,
          row.source_id,
        ]);
        if (existing) {
          this.run(
            `UPDATE tasks SET conversation_id=?, title=?, project=?, scope=?, due_date=?,
               completed_date=?, url=?, is_leaf=?, parent_id=?, status=?, priority=?,
               source_done=?, reasons=?, absent=0, last_synced=datetime('now')
             WHERE source=? AND source_id=?`,
            [
              row.conversation_id, row.title, row.project, row.scope, row.due_date,
              row.completed_date, row.url, row.is_leaf, row.parent_id, row.status,
              row.priority, row.source_done, row.reasons, row.source, row.source_id,
            ]
          );
        } else {
          this.run(
            `INSERT INTO tasks (source, source_id, conversation_id, title, project, scope,
               due_date, completed_date, url, is_leaf, parent_id, status, priority,
               source_done, reasons, manual, absent, last_synced)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,datetime('now'))`,
            [
              row.source, row.source_id, row.conversation_id, row.title, row.project,
              row.scope, row.due_date, row.completed_date, row.url, row.is_leaf,
              row.parent_id, row.status, row.priority, row.source_done, row.reasons,
            ]
          );
        }
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this._save();
    return tasks.length;
  }

  allTasks() {
    return this.all('SELECT * FROM tasks');
  }

  setChecked(id, checked) {
    this.run(
      "UPDATE tasks SET checked=?, checked_at=CASE WHEN ?=1 THEN datetime('now') ELSE NULL END WHERE id=?",
      [checked ? 1 : 0, checked ? 1 : 0, id]
    );
    this._save();
  }

  snooze(id, dateISO) {
    this.run('UPDATE tasks SET snoozed_until=? WHERE id=?', [dateISO, id]);
    this._save();
  }

  /**
   * Set the local due-date override.
   * @param {number} id
   * @param {string|null} value 'YYYY-MM-DD' to set a date, '' to force "no
   *   date", or null to remove the override (fall back to the synced date).
   */
  setDue(id, value) {
    if (value === null) {
      this.run('UPDATE tasks SET due_override=NULL WHERE id=?', [id]);
    } else {
      this.run('UPDATE tasks SET due_override=? WHERE id=?', [value, id]);
    }
    this._save();
  }

  /** Rename a task locally (override the displayed title). */
  setTitle(id, title) {
    this.run('UPDATE tasks SET title_override=? WHERE id=?', [title || null, id]);
    this._save();
  }

  /** Hard-delete a task row. Used for manual tasks the user removes. */
  deleteTask(id) {
    this.run('DELETE FROM tasks WHERE id=?', [id]);
    this._save();
  }

  dismiss(id) {
    this.run('UPDATE tasks SET dismissed=1 WHERE id=?', [id]);
    this._save();
  }

  getTask(id) {
    return this.get('SELECT * FROM tasks WHERE id=?', [id]);
  }

  addManual({ title, project, dueDate }) {
    const sourceId = `manual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.run(
      `INSERT INTO tasks (source, source_id, title, project, due_date, manual, last_synced)
       VALUES ('manual', ?, ?, ?, ?, 1, datetime('now'))`,
      [sourceId, title, project || null, dueDate || null]
    );
    const id = this._lastInsertId();
    this._save();
    return this.getTask(id);
  }

  startSync(source) {
    this.run("INSERT INTO sync_log (source, started_at) VALUES (?, datetime('now'))", [source]);
    const id = this._lastInsertId();
    this._save();
    return id;
  }

  finishSync(id, ok, message, count) {
    this.run(
      "UPDATE sync_log SET finished_at=datetime('now'), ok=?, message=?, item_count=? WHERE id=?",
      [ok ? 1 : 0, message || null, count ?? null, id]
    );
    this._save();
  }

  lastSuccessfulSync() {
    return this.get('SELECT * FROM sync_log WHERE ok=1 ORDER BY id DESC LIMIT 1');
  }

  getMeta(key) {
    const row = this.get('SELECT value FROM meta WHERE key=?', [key]);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.run(
      'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value == null ? null : String(value)]
    );
    this._save();
  }

  close() {
    try { this._save(); } catch (_) { /* ignore */ }
    this.db.close();
  }
}

module.exports = { Store, SCHEMA };
