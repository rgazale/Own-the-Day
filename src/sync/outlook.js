'use strict';
/**
 * outlook.js — Microsoft Graph (delegated, MSAL public client) sync.
 *
 * Auth: public client (no client secret) using the device-code flow by
 * default (config MS_AUTH_FLOW=devicecode). The MSAL token cache — including
 * the refresh token — is persisted to the OS keychain via keychain.js, never
 * to disk in plaintext.
 *
 * Pulls Inbox + Sent Items over the last N days, normalizes each message, and
 * runs the pure email classifier to keep the ones that look like tasks
 * assigned to me. Threads I've replied to (present in Sent) are marked handled.
 */

const { PublicClientApplication } = require('@azure/msal-node');
const keychain = require('../main/keychain');
const { classifyEmail } = require('../parsers/emailClassifier');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPca(cfg) {
  const cachePlugin = {
    beforeCacheAccess: async (ctx) => {
      const cached = await keychain.getSecret();
      if (cached) ctx.tokenCache.deserialize(cached);
    },
    afterCacheAccess: async (ctx) => {
      if (ctx.cacheHasChanged) {
        await keychain.setSecret(ctx.tokenCache.serialize());
      }
    },
  };
  return new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
    },
    cache: { cachePlugin },
  });
}

/**
 * Get an access token, silently if possible, else via device code.
 * @param {object} cfg config.outlook
 * @param {object} [opts] { deviceCodeCallback, pca }
 */
async function acquireToken(cfg, opts = {}) {
  if (!cfg.clientId) throw new Error('MS_CLIENT_ID is not set — see README "Outlook setup".');
  const pca = opts.pca || buildPca(cfg);

  const accounts = await pca.getTokenCache().getAllAccounts();
  if (accounts.length) {
    try {
      const res = await pca.acquireTokenSilent({ account: accounts[0], scopes: cfg.scopes });
      return { token: res.accessToken, account: res.account, pca };
    } catch (_) {
      // fall through to interactive
    }
  }

  // Device-code flow: surface the user_code + verification URL to the caller.
  const res = await pca.acquireTokenByDeviceCode({
    scopes: cfg.scopes,
    deviceCodeCallback: (info) => {
      if (opts.deviceCodeCallback) opts.deviceCodeCallback(info);
      else console.log(info.message);
    },
  });
  return { token: res.accessToken, account: res.account, pca };
}

async function graphGet(token, url, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 4) throw new Error(`Graph ${res.status} after retries`);
      const ra = parseInt(res.headers.get('retry-after'), 10);
      await sleep(Number.isFinite(ra) ? ra * 1000 : 2000 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

const SELECT =
  '$select=id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,importance,flag,receivedDateTime,webLink,sentDateTime';

/** Fetch all messages in a folder since `sinceISO` (paged). */
async function fetchFolder(token, folder, sinceISO, deps = {}) {
  let url =
    `${GRAPH}/me/mailFolders/${folder}/messages?` +
    `${SELECT}&$top=50&$orderby=receivedDateTime desc&` +
    `$filter=receivedDateTime ge ${sinceISO}`;
  const out = [];
  let guard = 0;
  while (url && guard < 40) {
    guard += 1;
    const page = await graphGet(token, url, deps);
    out.push(...(page.value || []));
    url = page['@odata.nextLink'] || null;
  }
  return out;
}

function normalizeAddr(r) {
  const e = (r && r.emailAddress) || {};
  return { address: e.address || '', name: e.name || '' };
}

function normalizeMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    subject: m.subject || '',
    bodyText: m.bodyPreview || '',
    importance: m.importance || 'normal',
    from: normalizeAddr(m.from),
    toRecipients: (m.toRecipients || []).map(normalizeAddr),
    ccRecipients: (m.ccRecipients || []).map(normalizeAddr),
    flag: { flagStatus: (m.flag && m.flag.flagStatus) || 'notFlagged' },
    receivedDateTime: m.receivedDateTime,
    webLink: m.webLink,
  };
}

/**
 * Full Outlook sync -> normalized task records.
 * @param {object} cfg config.outlook
 * @param {object} opts { rules, deviceCodeCallback, deps, token }
 * @returns {Promise<{tasks: object[], account: object|null}>}
 */
async function syncOutlook(cfg, opts = {}) {
  const rules = opts.rules;
  const deps = opts.deps || {};
  const since = new Date(Date.now() - cfg.lookbackDays * 86400000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');

  let token = opts.token;
  let account = null;
  if (!token) {
    const auth = await acquireToken(cfg, opts);
    token = auth.token;
    account = auth.account;
  }

  const [inbox, sent] = await Promise.all([
    fetchFolder(token, 'Inbox', since, deps),
    fetchFolder(token, 'SentItems', since, deps),
  ]);

  // Threads I've participated in (replied to) => handled.
  const repliedConversationIds = new Set(sent.map((m) => m.conversationId).filter(Boolean));

  // Keep the newest message per conversation so a busy thread => one task.
  const byConversation = new Map();
  for (const raw of inbox) {
    const m = normalizeMessage(raw);
    if (!m.conversationId) continue;
    const prev = byConversation.get(m.conversationId);
    if (!prev || m.receivedDateTime > prev.receivedDateTime) byConversation.set(m.conversationId, m);
  }

  const tasks = [];
  for (const m of byConversation.values()) {
    const verdict = classifyEmail(m, { rules, repliedConversationIds });
    if (verdict.dropped || !verdict.isTask) continue;
    tasks.push({
      source: 'email',
      sourceId: m.conversationId, // keyed by conversation so dismissal sticks
      conversationId: m.conversationId,
      title: m.subject || '(no subject)',
      project: null,
      scope: `${m.from.name || m.from.address} — ${m.bodyText.slice(0, 90)}`.trim(),
      dueDate: null, // email due dates aren't structured; urgency comes from bucket=none/soon
      completedDate: null,
      done: verdict.handled, // replied-to threads shown as handled
      url: m.webLink,
      isLeaf: false,
      parentId: null,
      status: null,
      priority: null,
      reasons: verdict.reasons,
      score: verdict.score,
    });
  }

  return { tasks, account };
}

module.exports = {
  syncOutlook,
  acquireToken,
  fetchFolder,
  normalizeMessage,
  GRAPH,
};
