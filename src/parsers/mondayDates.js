'use strict';
/**
 * mondayDates.js
 * -------------------------------------------------------------------------
 * Pure, side-effect-free reconstruction of the current value of a monday
 * date column from the board ACTIVITY LOG.
 *
 * Why this exists: on board 18417698484 the four date columns
 * (Due / Assigned / Completed / Received) are ROLLUP columns, and the
 * monday API silently omits them from `items { column_values }`. They show
 * up in `boards { columns }` (schema looks fine) but querying their values
 * returns empty — with no error. The reliable workaround is to read the
 * activity log and reconstruct the current value.
 *
 * Activity-log facts this module relies on (verified against the live board):
 *   - Each entry's `data` is a JSON *string* that parses to an object with:
 *       pulse_id, pulse_name, parent_item_id, is_leaf, column_id,
 *       rollup_generated_value, and `value` ({ "date": "2026-08-14", ... }).
 *   - `value` is `null` (or `{ "date": null }`) when the date was CLEARED —
 *     meaning the item currently has NO due date.
 *   - Entries come back NEWEST-FIRST. Therefore, for each pulse_id, the
 *     FIRST occurrence we encounter is its current value.
 *
 * This module does no network I/O and no paging — the caller concatenates
 * pages (newest-first, page 1..N) and passes the flat list in. That keeps
 * the risky logic fully unit-testable against fixtures.
 * -------------------------------------------------------------------------
 */

/**
 * Pull a 'YYYY-MM-DD' string (or null) out of an activity-log `value`.
 * Handles: object value, JSON-string value, null value, {date:null}.
 * @param {*} value
 * @returns {string|null}
 */
function extractDate(value) {
  if (value === null || value === undefined) return null;
  let v = value;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === 'null') return null;
    try { v = JSON.parse(s); } catch { return null; }
  }
  if (v && typeof v === 'object') {
    const d = v.date;
    if (d === null || d === undefined || d === '') return null;
    return String(d);
  }
  return null;
}

/**
 * Parse one raw activity-log entry into a normalized record, or null if it
 * can't be parsed / isn't usable.
 * @param {{data: (string|object), created_at?: (string|number)}} entry
 * @returns {null | {
 *   pulseId:number, pulseName:(string|null), date:(string|null),
 *   isLeaf:boolean, parentItemId:(number|null), rollup:boolean,
 *   columnId:(string|null), createdAt:(string|number|null)
 * }}
 */
function parseEntry(entry) {
  if (!entry) return null;
  let d = entry.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return null; }
  }
  if (!d || typeof d !== 'object') return null;
  const pid = d.pulse_id;
  if (pid === null || pid === undefined) return null;
  return {
    pulseId: pid,
    pulseName: d.pulse_name ?? null,
    date: extractDate(d.value),
    isLeaf: d.is_leaf === true,
    parentItemId: d.parent_item_id ?? null,
    rollup: d.rollup_generated_value === true,
    columnId: d.column_id ?? null,
    createdAt: entry.created_at ?? null,
  };
}

/**
 * Reconstruct the CURRENT value of a date column for every pulse that appears
 * in the given (newest-first) activity-log entries.
 *
 * @param {Array<{data:(string|object), created_at?:(string|number)}>} entries
 *        Newest-first activity-log entries for a single date column, already
 *        concatenated across pages by the caller.
 * @returns {Map<number, {
 *   pulseId:number, pulseName:(string|null), date:(string|null),
 *   isLeaf:boolean, parentItemId:(number|null), rollup:boolean,
 *   columnId:(string|null), createdAt:(string|number|null)
 * }>}  pulse_id -> current record. `date` is 'YYYY-MM-DD' or null (no date).
 */
function reconstructColumnValues(entries) {
  const byPulse = new Map();
  if (!Array.isArray(entries)) return byPulse;
  for (const entry of entries) {
    const rec = parseEntry(entry);
    if (!rec) continue;
    // Newest-first: the first record we see for a pulse is the current one.
    if (byPulse.has(rec.pulseId)) continue;
    byPulse.set(rec.pulseId, rec);
  }
  return byPulse;
}

/**
 * Given the highest `created_at` we've already ingested, decide whether a page
 * of newest-first entries is fully "new" (keep paging) or overlaps history
 * (we can stop after this page). Used for incremental sync — the parser stays
 * pure; the caller uses this to bound how far back it pages.
 * @param {Array<{created_at?:(string|number)}>} entries
 * @param {(string|number|null)} lastSeenCreatedAt
 * @returns {boolean} true if every entry is newer than lastSeenCreatedAt
 */
function pageIsAllNew(entries, lastSeenCreatedAt) {
  if (lastSeenCreatedAt === null || lastSeenCreatedAt === undefined) return true;
  const cutoff = Number(lastSeenCreatedAt);
  if (!Number.isFinite(cutoff)) return true;
  return entries.every((e) => Number(e.created_at) > cutoff);
}

module.exports = {
  extractDate,
  parseEntry,
  reconstructColumnValues,
  pageIsAllNew,
};
