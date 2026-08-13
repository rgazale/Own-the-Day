'use strict';
/**
 * db.js — local-first SQLite store.
 *
 * Golden rule: LOCAL STATE IS NEVER LOST ON SYNC. Incoming source items are
 * matched to existing rows by (source, source_id) and MERGED — we update only
 * the source-derived columns and never touch checked / snoozed_until /
 * dismissed / manual. We never wipe-and-rebuild the table.
 */

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,            -- 'monday' | 'email' | 'manual'
  source_id     TEXT NOT NULL,            -- monday item/subitem id, or conversationId, or uuid
  conversation_id TEXT,                   -- email threads (dismissal key)
  title         TEXT NOT NULL,
  project       TEXT,
  scope         TEXT,
  due_date      TEXT,                     -- 'YYYY-MM-DD' or NULL
  completed_date TEXT,
  url           TEXT,
  is_leaf       INTEGER DEFAULT 0,
  parent_id     TEXT,
  status        TEXT,
  priority      TEXT,
  source_done   INTEGER DEFAULT 0,        -- done at the source (monday completed / handled)
  reasons       TEXT,                     -- classifier reasons (email), JSON
  -- local state (never overwritten by sync) --
  checked       INTEGER DEFAULT 0,
  checked_at    TEXT,
  snoozed_until TEXT,
  dismissed     INTEGER DEFAULT 0,
  manual        INTEGER DEFAULT 0,
  absent        INTEGER DEFAULT 0,        -- not seen in the latest sync of its source
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

class Store {
  /** @param {string} dbPath */
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this._prepare();
  }

  _prepare() {
    this.stmts = {
      findBySource: this.db.prepare('SELECT * FROM tasks WHERE source=? AND source_id=?'),
      insert: this.db.prepare(`
        INSERT INTO tasks (source, source_id, conversation_id, title, project, scope,
          due_date, completed_date, url, is_leaf, parent_id, status, priority,
          source_done, reasons, manual, absent, last_synced)
        VALUES (@source, @source_id, @conversation_id, @title, @project, @scope,
          @due_date, @completed_date, @url, @is_leaf, @parent_id, @status, @priority,
          @source_done, @reasons, @manual, 0, datetime('now'))`),
      // Update ONLY source-derived columns. Local state columns are untouched.
      updateSource: this.db.prepare(`
        UPDATE tasks SET
          conversation_id=@conversation_id, title=@title, project=@project, scope=@scope,
          due_date=@due_date, completed_date=@completed_date, url=@url, is_leaf=@is_leaf,
          parent_id=@parent_id, status=@status, priority=@priority,
          source_done=@source_done, reasons=@reasons, absent=0, last_synced=datetime('now')
        WHERE source=@source AND source_id=@source_id`),
      markAbsent: this.db.prepare(
        `UPDATE tasks SET absent=1 WHERE source=? AND manual=0 AND source_id NOT IN (SELECT value FROM json_each(?))`
      ),
      allActive: this.db.prepare('SELECT * FROM tasks'),
      setChecked: this.db.prepare(
        "UPDATE tasks SET checked=@checked, checked_at=CASE WHEN @checked=1 THEN datetime('now') ELSE NULL END WHERE id=@id"
      ),
      setSnooze: this.db.prepare('UPDATE tasks SET snoozed_until=@date WHERE id=@id'),
      setDismissed: this.db.prepare('UPDATE tasks SET dismissed=1 WHERE id=@id'),
      getById: this.db.prepare('SELECT * FROM tasks WHERE id=?'),
      insertManual: this.db.prepare(`
        INSERT INTO tasks (source, source_id, title, project, due_date, manual, last_synced)
        VALUES ('manual', @source_id, @title, @project, @due_date, 1, datetime('now'))`),
      logStart: this.db.prepare(
        "INSERT INTO sync_log (source, started_at) VALUES (?, datetime('now'))"
      ),
      logFinish: this.db.prepare(
        'UPDATE sync_log SET finished_at=datetime(\'now\'), ok=?, message=?, item_count=? WHERE id=?'
      ),
      lastSync: this.db.prepare(
        'SELECT * FROM sync_log WHERE ok=1 ORDER BY id DESC LIMIT 1'
      ),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key=?'),
      setMeta: this.db.prepare(
        'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      ),
    };
  }

  /**
   * Merge a batch of normalized source tasks. Preserves all local state.
   * @param {object[]} tasks normalized records (see sync/*.js)
   * @param {string} source 'monday' | 'email'
   * @param {object} [opts] { markAbsentUnseen: boolean }
   */
  mergeTasks(tasks, source, opts = {}) {
    const rows = tasks.map((t) => ({
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
      manual: 0,
    }));

    const tx = this.db.transaction((batch) => {
      for (const r of batch) {
        const existing = this.stmts.findBySource.get(r.source, r.source_id);
        if (existing) this.stmts.updateSource.run(r);
        else this.stmts.insert.run(r);
      }
      if (opts.markAbsentUnseen) {
        const ids = JSON.stringify(batch.map((r) => r.source_id));
        this.stmts.markAbsent.run(source, ids);
      }
    });
    tx(rows);
    return rows.length;
  }

  allTasks() {
    return this.stmts.allActive.all();
  }

  setChecked(id, checked) {
    return this.stmts.setChecked.run({ id, checked: checked ? 1 : 0 });
  }

  snooze(id, dateISO) {
    return this.stmts.setSnooze.run({ id, date: dateISO });
  }

  dismiss(id) {
    return this.stmts.setDismissed.run({ id });
  }

  getTask(id) {
    return this.stmts.getById.get(id);
  }

  addManual({ title, project, dueDate }) {
    const sourceId = `manual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const info = this.stmts.insertManual.run({
      source_id: sourceId,
      title,
      project: project || null,
      due_date: dueDate || null,
    });
    return this.getTask(info.lastInsertRowid);
  }

  startSync(source) {
    return this.stmts.logStart.run(source).lastInsertRowid;
  }

  finishSync(id, ok, message, count) {
    return this.stmts.logFinish.run(ok ? 1 : 0, message || null, count ?? null, id);
  }

  lastSuccessfulSync() {
    return this.stmts.lastSync.get();
  }

  getMeta(key) {
    const row = this.stmts.getMeta.get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    return this.stmts.setMeta.run(key, value == null ? null : String(value));
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, SCHEMA };
