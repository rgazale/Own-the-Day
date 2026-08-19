'use strict';
/**
 * buckets.js — pure grouping + urgency sort for the merged task list.
 * Buckets, in order: Overdue -> Due today -> This week (next 7d) ->
 * Scheduled -> No due date. All date math is date-only (no timezones).
 */

const BUCKET_ORDER = ['overdue', 'today', 'week', 'scheduled', 'none'];
const BUCKET_LABELS = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'This week',
  scheduled: 'Scheduled',
  none: 'No due date',
};

/**
 * The due date actually used for display/bucketing: a local override wins over
 * the synced date. Override of '' means "deliberately no date".
 */
function effectiveDue(t) {
  if (!t) return null;
  const ov = t.due_override;
  if (ov !== undefined && ov !== null) return ov === '' ? null : ov;
  return t.due_date ?? t.dueDate ?? null;
}

/** Displayed title: a local rename wins over the source title. */
function effectiveTitle(t) {
  return (t && t.title_override) || (t && t.title) || '';
}

/** 'YYYY-MM-DD' for a Date (local). */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayISO(now = new Date()) {
  return toISODate(now);
}

/** Whole-day difference b - a for 'YYYY-MM-DD' strings (b later => positive). */
function diffDays(aISO, bISO) {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/**
 * Which bucket does a due date fall into relative to `today`?
 * @param {string|null} dueDate 'YYYY-MM-DD' or null
 * @param {string} today 'YYYY-MM-DD'
 */
function bucketFor(dueDate, today) {
  if (!dueDate) return 'none';
  const delta = diffDays(today, dueDate); // days from today to due
  if (delta < 0) return 'overdue';
  if (delta === 0) return 'today';
  if (delta <= 7) return 'week';
  return 'scheduled';
}

/** Human countdown: "3d over", "due today", "in 5d". */
function countdownLabel(dueDate, today) {
  if (!dueDate) return '';
  const delta = diffDays(today, dueDate);
  if (delta < 0) return `${Math.abs(delta)}d over`;
  if (delta === 0) return 'due today';
  return `in ${delta}d`;
}

/**
 * Is this task currently visible? Hides checked, dismissed, and snoozed items.
 * @param {object} t task row (checked, dismissed, snoozed_until)
 * @param {string} today
 */
function isVisible(t, today) {
  if (t.checked) return false;
  if (t.dismissed) return false;
  if (t.absent) return false;        // no longer returned by its source
  if (t.source_done) return false;   // marked done in monday/Outlook
  if (t.snoozed_until && diffDays(today, t.snoozed_until) > 0) return false;
  return true;
}

/**
 * Group + sort visible tasks into ordered buckets.
 * Within a bucket: soonest due first; no-due sorted by title.
 * @returns {Array<{key:string,label:string,count:number,tasks:object[]}>}
 */
function groupAndSort(tasks, today = todayISO()) {
  const groups = Object.fromEntries(BUCKET_ORDER.map((k) => [k, []]));
  for (const t of tasks) {
    if (!isVisible(t, today)) continue;
    const key = bucketFor(effectiveDue(t), today);
    groups[key].push(t);
  }
  const cmp = (a, b) => {
    const da = effectiveDue(a);
    const db = effectiveDue(b);
    if (da && db && da !== db) return da < db ? -1 : 1;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return effectiveTitle(a).localeCompare(effectiveTitle(b));
  };
  return BUCKET_ORDER.map((key) => {
    const list = groups[key].sort(cmp);
    return { key, label: BUCKET_LABELS[key], count: list.length, tasks: list };
  });
}

/** Overdue + due-today count, for the tray badge. */
function urgentCount(tasks, today = todayISO()) {
  let n = 0;
  for (const t of tasks) {
    if (!isVisible(t, today)) continue;
    const b = bucketFor(effectiveDue(t), today);
    if (b === 'overdue' || b === 'today') n += 1;
  }
  return n;
}

module.exports = {
  BUCKET_ORDER,
  BUCKET_LABELS,
  toISODate,
  todayISO,
  diffDays,
  bucketFor,
  countdownLabel,
  isVisible,
  groupAndSort,
  urgentCount,
  effectiveDue,
  effectiveTitle,
};
