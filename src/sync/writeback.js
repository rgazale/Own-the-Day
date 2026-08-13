'use strict';
/**
 * writeback.js — OPTIONAL source mutations, OFF by default.
 *
 * Every mutation is (a) guarded behind a config flag that defaults to false,
 * and (b) appended to mutation-audit.log so it can be audited. When the flag
 * is off, these functions record the intent to the audit log and return
 * { written:false } without touching the source.
 *
 * monday writes go to the LEAF subitem (the parent value is a rollup and would
 * be recomputed). Outlook writes clear the follow-up flag.
 */

const fs = require('node:fs');
const path = require('node:path');
const { mondayQuery } = require('./mondayApi');

function auditPath(dataDir) {
  return path.join(dataDir || process.cwd(), 'mutation-audit.log');
}

function audit(dataDir, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.appendFileSync(auditPath(dataDir), line);
  } catch (_) { /* audit best-effort */ }
}

/**
 * Mark a monday leaf subitem complete by setting its Completed Date.
 * @param {object} cfg config.monday
 * @param {object} args { itemId, isLeaf, dateISO, dataDir }
 */
async function completeMondayItem(cfg, args) {
  const { itemId, isLeaf, dateISO, dataDir } = args;
  if (!isLeaf) {
    audit(dataDir, { source: 'monday', action: 'complete', itemId, skipped: 'parent-rollup' });
    return { written: false, reason: 'parent-rollup (write to leaf subitem instead)' };
  }
  if (!cfg.writeback) {
    audit(dataDir, { source: 'monday', action: 'complete', itemId, dateISO, written: false, reason: 'writeback-disabled' });
    return { written: false, reason: 'writeback-disabled' };
  }
  const mutation = `
    mutation ($item: ID!, $board: ID!, $col: String!, $val: JSON!) {
      change_column_value(item_id: $item, board_id: $board, column_id: $col, value: $val) { id }
    }`;
  await mondayQuery({
    token: cfg.token,
    apiVersion: cfg.apiVersion,
    query: mutation,
    variables: {
      item: String(itemId),
      board: String(cfg.boardId),
      col: cfg.completedDateColumn,
      val: JSON.stringify({ date: dateISO }),
    },
  });
  audit(dataDir, { source: 'monday', action: 'complete', itemId, dateISO, written: true });
  return { written: true };
}

/**
 * Clear an Outlook follow-up flag on the message(s) of a conversation.
 * @param {object} cfg config.outlook
 * @param {object} args { token, messageId, dataDir, fetchImpl }
 */
async function clearOutlookFlag(cfg, args) {
  const { token, messageId, dataDir, fetchImpl = fetch } = args;
  if (!cfg.writeback) {
    audit(dataDir, { source: 'outlook', action: 'clear-flag', messageId, written: false, reason: 'writeback-disabled' });
    return { written: false, reason: 'writeback-disabled' };
  }
  const res = await fetchImpl(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag: { flagStatus: 'complete' } }),
  });
  const ok = res.ok;
  audit(dataDir, { source: 'outlook', action: 'clear-flag', messageId, written: ok });
  if (!ok) return { written: false, reason: `Graph ${res.status}` };
  return { written: true };
}

module.exports = { completeMondayItem, clearOutlookFlag, auditPath };
