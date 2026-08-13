'use strict';
/**
 * keychain.js — store the Outlook MSAL token cache in the OS keychain
 * (Windows Credential Manager), never in a plaintext file or the repo.
 * Falls back to an in-memory store if keytar is unavailable (e.g. tests).
 */

const SERVICE = 'MDC Daily';
const ACCOUNT = 'msal-token-cache';

let keytar = null;
try {
  keytar = require('keytar');
} catch (_) {
  keytar = null;
}

const memory = new Map();

async function getSecret(account = ACCOUNT) {
  if (keytar) return keytar.getPassword(SERVICE, account);
  return memory.has(account) ? memory.get(account) : null;
}

async function setSecret(value, account = ACCOUNT) {
  if (keytar) return keytar.setPassword(SERVICE, account, value);
  memory.set(account, value);
  return undefined;
}

async function deleteSecret(account = ACCOUNT) {
  if (keytar) return keytar.deletePassword(SERVICE, account);
  return memory.delete(account);
}

module.exports = { getSecret, setSecret, deleteSecret, SERVICE, ACCOUNT };
