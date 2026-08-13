'use strict';
/**
 * mondayApi.js — thin GraphQL client for monday.com API v2 with rate-limit
 * aware retry/backoff. No app logic here; just "send a query, get JSON".
 */

const ENDPOINT = 'https://api.monday.com/v2';

class MondayError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'MondayError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a GraphQL query against monday.
 * @param {object} args
 * @param {string} args.token   personal API token
 * @param {string} args.query   GraphQL query string
 * @param {object} [args.variables]
 * @param {string} [args.apiVersion]
 * @param {number} [args.maxRetries]
 * @param {function} [args.fetchImpl] injectable fetch (for tests)
 * @returns {Promise<object>} the `data` object
 */
async function mondayQuery({
  token,
  query,
  variables = {},
  apiVersion = '2024-10',
  maxRetries = 4,
  fetchImpl = fetch,
}) {
  if (!token) throw new MondayError('Missing monday API token');

  let attempt = 0;
  // Exponential backoff for 429 / 5xx / transient network errors.
  // Monday's complexity limits also surface as 429; back off and retry.
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token,
          'API-Version': apiVersion,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (netErr) {
      if (attempt > maxRetries) throw new MondayError(`Network error: ${netErr.message}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt > maxRetries) {
        throw new MondayError(`monday API ${res.status} after ${maxRetries} retries`, {
          status: res.status,
        });
      }
      // Respect Retry-After if provided, else exponential backoff.
      const ra = parseInt(res.headers.get('retry-after'), 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : 2000 * 2 ** (attempt - 1);
      await sleep(wait);
      continue;
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new MondayError(`Bad JSON from monday (status ${res.status})`, { status: res.status });
    }

    if (json.errors && json.errors.length) {
      // Complexity-budget errors are worth a backoff+retry.
      const msg = json.errors.map((e) => e.message).join('; ');
      const isComplexity = /complexity|rate limit|budget/i.test(msg);
      if (isComplexity && attempt <= maxRetries) {
        await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      throw new MondayError(`monday GraphQL error: ${msg}`, { status: res.status, body: json });
    }

    return json.data;
  }
}

module.exports = { mondayQuery, MondayError, ENDPOINT };
