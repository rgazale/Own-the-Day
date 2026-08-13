'use strict';
/**
 * config.js — load .env + config/email-rules.json into one typed config object.
 * No secrets are hard-coded; everything comes from the environment or, for the
 * Outlook refresh token, from the OS keychain (see keychain.js).
 */
const fs = require('node:fs');
const path = require('node:path');

// Load .env if present (dev). In a packaged app the values can also come from
// real environment variables. dotenv is a no-op if the file is missing.
try {
  const dotenv = require('dotenv');
  // When packaged, resources live next to the executable; in dev it's cwd.
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '..', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { dotenv.config({ path: p }); break; }
  }
} catch (_) { /* dotenv optional at runtime */ }

const bool = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  return String(v).toLowerCase() === 'true' || v === '1';
};
const int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

function resourcePath(...parts) {
  // Packaged: extraResources -> process.resourcesPath/config/...
  // Dev: repo/config/...
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, ...parts)
    : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', ...parts);
}

function loadEmailRules() {
  const p = resourcePath('config', 'email-rules.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const config = {
  monday: {
    token: process.env.MONDAY_API_TOKEN || '',
    boardId: int(process.env.MONDAY_BOARD_ID, 18417698484),
    userId: String(process.env.MONDAY_USER_ID || '100030091'),
    apiVersion: process.env.MONDAY_API_VERSION || '2024-10',
    writeback: bool(process.env.MONDAY_WRITEBACK, false),
    // The four rollup date columns (see mondayDates.js).
    dueDateColumn: 'date_mm4ad31d',
    completedDateColumn: 'date_mm5nwz0k',
    // Non-date columns we read for scope / status.
    scopeMirror: 'lookup_mm5ncqb8',
    statusMirror: 'lookup_mm5ne0sk',
    notesColumn: 'text_mm4az62g',
    priorityColumn: 'color_mm5wrj2g',
    statusFunction: 'color_mm4b8bx0',
    personColumn: 'person',
  },
  outlook: {
    clientId: process.env.MS_CLIENT_ID || '',
    tenantId: process.env.MS_TENANT_ID || 'mcmillanlv.com',
    authFlow: (process.env.MS_AUTH_FLOW || 'devicecode').toLowerCase(),
    writeback: bool(process.env.OUTLOOK_WRITEBACK, false),
    lookbackDays: int(process.env.EMAIL_LOOKBACK_DAYS, 7),
    scopes: (() => {
      const base = ['Mail.Read', 'offline_access', 'User.Read'];
      if (bool(process.env.OUTLOOK_WRITEBACK, false)) base.push('Mail.ReadWrite');
      return base;
    })(),
  },
  sync: {
    intervalMinutes: int(process.env.SYNC_INTERVAL_MINUTES, 60),
  },
  notify: {
    onOverdue: bool(process.env.NOTIFY_ON_OVERDUE, true),
  },
  autostart: bool(process.env.START_WITH_WINDOWS, true),
  loadEmailRules,
  resourcePath,
};

module.exports = config;
