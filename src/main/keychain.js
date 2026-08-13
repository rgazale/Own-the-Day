'use strict';
/**
 * keychain.js — store the Outlook MSAL token cache encrypted at rest, using
 * Electron's built-in safeStorage (Windows DPAPI under the hood). No native
 * npm module (keytar) is required. Falls back to an in-memory store when
 * running outside Electron (e.g. unit tests).
 *
 * The encrypted blob lives in the app's userData folder, never in the repo
 * and never in plaintext.
 */

const path = require('node:path');
const fs = require('node:fs');

let safeStorage = null;
let app = null;
try {
  ({ safeStorage, app } = require('electron'));
} catch (_) {
  safeStorage = null;
  app = null;
}

const memory = new Map();

function tokenFile(account) {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${account}.bin`);
}

function canEncrypt() {
  return !!(safeStorage && app && safeStorage.isEncryptionAvailable());
}

async function getSecret(account = 'msal-token-cache') {
  if (canEncrypt()) {
    const f = tokenFile(account);
    if (!fs.existsSync(f)) return null;
    try {
      return safeStorage.decryptString(fs.readFileSync(f));
    } catch (_) {
      return null;
    }
  }
  return memory.has(account) ? memory.get(account) : null;
}

async function setSecret(value, account = 'msal-token-cache') {
  if (canEncrypt()) {
    const enc = safeStorage.encryptString(value);
    fs.writeFileSync(tokenFile(account), enc);
    return;
  }
  memory.set(account, value);
}

async function deleteSecret(account = 'msal-token-cache') {
  if (canEncrypt()) {
    const f = tokenFile(account);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return;
  }
  memory.delete(account);
}

module.exports = { getSecret, setSecret, deleteSecret };
