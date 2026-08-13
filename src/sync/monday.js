'use strict';
/**
 * monday.js — high-level monday.com sync.
 *
 * Produces a flat list of normalized task records for every parent item and
 * subitem on board 18417698484 where the `person` column includes me.
 *
 * Due dates and Completed dates come from the activity-log reconstruction
 * (see parsers/mondayDates.js) because the API omits those rollup columns.
 */

const { mondayQuery } = require('./mondayApi');
const { reconstructColumnValues } = require('../parsers/mondayDates');

const ITEMS_QUERY = `
  query ($board: [ID!], $cursor: String) {
    boards(ids: $board) {
      items_page(limit: 25, cursor: $cursor) {
        cursor
        items {
          id
          name
          url
          group { id title }
          column_values(ids: ["person","lookup_mm5ncqb8","lookup_mm5ne0sk","text_mm4az62g","color_mm5wrj2g","color_mm4b8bx0"]) {
            id type text
            ... on PeopleValue { persons_and_teams { id kind } }
            ... on MirrorValue { display_value }
          }
          subitems {
            id
            name
            url
            column_values(ids: ["person"]) {
              id type text
              ... on PeopleValue { persons_and_teams { id kind } }
            }
          }
        }
      }
    }
  }`;

const ACTIVITY_QUERY = `
  query ($board: [ID!], $col: [String], $page: Int!) {
    boards(ids: $board) {
      activity_logs(limit: 100, page: $page, column_ids: $col) {
        data
        created_at
      }
    }
  }`;

function personIncludes(columnValues, userId) {
  for (const cv of columnValues || []) {
    if (cv && Array.isArray(cv.persons_and_teams)) {
      if (cv.persons_and_teams.some((p) => String(p.id) === String(userId))) return true;
    }
  }
  return false;
}

function colText(columnValues, id) {
  const cv = (columnValues || []).find((c) => c.id === id);
  if (!cv) return null;
  if (cv.display_value !== undefined && cv.display_value !== null && cv.display_value !== '') {
    return cv.display_value;
  }
  return cv.text || null;
}

/** Fetch every item + subitem on the board (cursor paginated). */
async function fetchAllItems(cfg, deps = {}) {
  const q = deps.mondayQuery || mondayQuery;
  const all = [];
  let cursor = null;
  do {
    const data = await q({
      token: cfg.token,
      apiVersion: cfg.apiVersion,
      query: ITEMS_QUERY,
      variables: { board: [String(cfg.boardId)], cursor },
    });
    const page = data.boards?.[0]?.items_page;
    if (!page) break;
    all.push(...(page.items || []));
    cursor = page.cursor || null;
  } while (cursor);
  return all;
}

/**
 * Page the activity log newest-first for one date column and reconstruct the
 * current value per pulse. Stops when a page returns < 100 entries, or once we
 * reach activity older than `sinceCreatedAt` (incremental sync).
 */
async function fetchColumnDates(cfg, columnId, sinceCreatedAt, deps = {}) {
  const q = deps.mondayQuery || mondayQuery;
  const collected = [];
  let page = 1;
  const MAX_PAGES = 200; // safety valve
  for (; page <= MAX_PAGES; page += 1) {
    const data = await q({
      token: cfg.token,
      apiVersion: cfg.apiVersion,
      query: ACTIVITY_QUERY,
      variables: { board: [String(cfg.boardId)], col: [columnId], page },
    });
    const logs = data.boards?.[0]?.activity_logs || [];
    collected.push(...logs);
    if (logs.length < 100) break; // last page
    if (sinceCreatedAt) {
      // If this page already dipped below our watermark, we've covered all new
      // activity; one more page of overlap is fine, then stop.
      const oldest = Number(logs[logs.length - 1].created_at);
      if (Number.isFinite(oldest) && oldest <= Number(sinceCreatedAt)) break;
    }
  }
  return reconstructColumnValues(collected);
}

/**
 * Run a full monday sync and return normalized task records.
 * @param {object} cfg config.monday
 * @param {object} [opts] { sinceCreatedAt, deps }
 * @returns {Promise<{tasks: object[], newestCreatedAt: (string|null)}>}
 */
async function syncMonday(cfg, opts = {}) {
  const deps = opts.deps || {};
  const [items, dueMap, doneMap] = await Promise.all([
    fetchAllItems(cfg, deps),
    fetchColumnDates(cfg, cfg.dueDateColumn, opts.sinceCreatedAt, deps),
    fetchColumnDates(cfg, cfg.completedDateColumn, opts.sinceCreatedAt, deps),
  ]);

  const tasks = [];
  let newestCreatedAt = opts.sinceCreatedAt || null;
  const trackNewest = (map) => {
    for (const rec of map.values()) {
      if (rec.createdAt && (!newestCreatedAt || Number(rec.createdAt) > Number(newestCreatedAt))) {
        newestCreatedAt = rec.createdAt;
      }
    }
  };
  trackNewest(dueMap);
  trackNewest(doneMap);

  const mkTask = (node, { isLeaf, project }) => {
    const id = String(node.id);
    const due = dueMap.get(Number(id)) || dueMap.get(node.id);
    const done = doneMap.get(Number(id)) || doneMap.get(node.id);
    const scope = colText(node.column_values, 'lookup_mm5ncqb8');
    const statusText = colText(node.column_values, 'lookup_mm5ne0sk')
      || colText(node.column_values, 'color_mm4b8bx0');
    const notes = colText(node.column_values, 'text_mm4az62g');
    return {
      source: 'monday',
      sourceId: id,
      conversationId: null,
      title: node.name,
      project: project || node.name,
      scope: [scope, notes].filter(Boolean).join(' — ') || statusText || null,
      dueDate: due ? due.date : null,
      completedDate: done ? done.date : null,
      done: !!(done && done.date),
      url: node.url,
      isLeaf,
      parentId: project && isLeaf ? undefined : null,
      status: statusText || null,
      priority: colText(node.column_values, 'color_mm5wrj2g'),
    };
  };

  for (const item of items) {
    const parentMine = personIncludes(item.column_values, cfg.userId);
    if (parentMine) {
      tasks.push(mkTask(item, { isLeaf: false, project: item.name }));
    }
    for (const sub of item.subitems || []) {
      if (personIncludes(sub.column_values, cfg.userId)) {
        const t = mkTask(sub, { isLeaf: true, project: item.name });
        t.parentId = String(item.id);
        // Prefer the parent's board URL anchor for a clean open target.
        t.url = sub.url || item.url;
        tasks.push(t);
      }
    }
  }

  return { tasks, newestCreatedAt };
}

module.exports = {
  syncMonday,
  fetchAllItems,
  fetchColumnDates,
  personIncludes,
  colText,
  ITEMS_QUERY,
  ACTIVITY_QUERY,
};
