'use strict';
/**
 * engine.js — orchestrates a sync run: monday + Outlook -> merge into DB.
 * Each source runs independently; if one fails we keep the other's data and
 * the last-good rows already in the DB. Never blanks the list on failure.
 */

const { syncMonday } = require('./monday');
const { syncOutlook } = require('./outlook');

const MONDAY_WATERMARK = 'monday_activity_watermark';

/**
 * @param {import('../main/db').Store} store
 * @param {object} config the app config object
 * @param {object} [opts] { deviceCodeCallback, onStatus }
 * @returns {Promise<{ok:boolean, errors:object[], counts:object}>}
 */
async function runSync(store, config, opts = {}) {
  const errors = [];
  const counts = {};
  const status = opts.onStatus || (() => {});

  // ---- monday ----
  {
    const logId = store.startSync('monday');
    try {
      status('Syncing monday…');
      // Full activity-log scan every sync. The date reconstruction needs the
      // COMPLETE current state per item; a delta-only read would leave items
      // whose dates didn't change this cycle with no date and wrongly wipe
      // them. The board is small (a few pages), so a full scan is cheap and
      // makes every sync reproduce the correct first-sync result.
      const { tasks, newestCreatedAt } = await syncMonday(config.monday, {});
      const n = store.mergeTasks(tasks, 'monday', { markAbsentUnseen: true });
      if (newestCreatedAt) store.setMeta(MONDAY_WATERMARK, newestCreatedAt);
      store.finishSync(logId, true, null, n);
      counts.monday = n;
    } catch (e) {
      store.finishSync(logId, false, e.message, null);
      errors.push({ source: 'monday', message: e.message });
    }
  }

  // ---- Outlook (only if configured) ----
  if (config.outlook.clientId) {
    const logId = store.startSync('email');
    try {
      status('Syncing Outlook…');
      const rules = config.loadEmailRules();
      const { tasks } = await syncOutlook(config.outlook, {
        rules,
        deviceCodeCallback: opts.deviceCodeCallback,
      });
      const n = store.mergeTasks(tasks, 'email', { markAbsentUnseen: true });
      store.finishSync(logId, true, null, n);
      counts.email = n;
    } catch (e) {
      store.finishSync(logId, false, e.message, null);
      errors.push({ source: 'email', message: e.message });
    }
  } else {
    counts.email = 'skipped (MS_CLIENT_ID not set)';
  }

  return { ok: errors.length === 0, errors, counts };
}

module.exports = { runSync, MONDAY_WATERMARK };
