'use strict';
/**
 * emailClassifier.js
 * -------------------------------------------------------------------------
 * Pure, config-driven scoring of an Outlook message to decide whether it is
 * a TASK directed at me. All weights/lists come from config/email-rules.json
 * so the classifier can be tuned without touching code.
 *
 * A message is normalized (by the Graph sync layer) to:
 *   {
 *     conversationId, subject, bodyText, importance ('high'|'normal'|'low'),
 *     from: { address, name },
 *     toRecipients:  [{ address, name }],
 *     ccRecipients:  [{ address, name }],
 *     flag: { flagStatus },        // 'flagged' | 'complete' | 'notFlagged'
 *     receivedDateTime, webLink
 *   }
 *
 * classifyEmail returns { isTask, score, reasons, handled, dropped }.
 * -------------------------------------------------------------------------
 */

const lower = (s) => (s || '').toString().toLowerCase();
const round1 = (n) => Math.round(n * 10) / 10;

function domainOf(addr) {
  const a = lower(addr);
  const at = a.lastIndexOf('@');
  return at === -1 ? '' : a.slice(at + 1);
}

/** Any of `words` present in `text` (case-insensitive substring). */
function anyWord(text, words) {
  if (!Array.isArray(words)) return false;
  for (const w of words) {
    if (w && text.includes(lower(w))) return true;
  }
  return false;
}

/** Hard-deny sender test. */
function isDeniedSender(fromAddr, deny) {
  if (!deny) return false;
  const a = lower(fromAddr);
  if (!a) return false;
  if (Array.isArray(deny.exact) && deny.exact.some((e) => lower(e) === a)) return true;
  if (Array.isArray(deny.endsWith) && deny.endsWith.some((e) => e && a.endsWith(lower(e)))) return true;
  if (Array.isArray(deny.contains) && deny.contains.some((e) => e && a.includes(lower(e)))) return true;
  return false;
}

/**
 * Does one of my names appear right next to a request cue?
 * Catches "@Ryan", "Ryan —", "Ryan,", "Ryan please", "Ryan, can you", and any
 * of my names appearing within `window` chars of a request verb.
 */
function nameNextToRequest(text, rules) {
  const names = (rules.myName || []).map(lower).filter(Boolean);
  const window = rules.nameNextToRequestWindow || 60;
  const verbs = (rules.requestVerbs && rules.requestVerbs.words) || [];
  for (const name of names) {
    let idx = text.indexOf(name);
    while (idx !== -1) {
      const before = text.slice(Math.max(0, idx - 1), idx);
      const after = text.slice(idx + name.length, idx + name.length + window);
      // Direct address forms right after the name.
      if (/^\s*[—\-,:]/.test(after) || /^\s+(please|can you|could you|pls)\b/.test(after)) {
        return true;
      }
      // @Name
      if (before === '@') return true;
      // Name within the window of any request verb.
      if (anyWord(after, verbs)) return true;
      idx = text.indexOf(name, idx + name.length);
    }
  }
  return false;
}

/** Is one of my names anywhere in the text at all? */
function nameInText(text, rules) {
  return anyWord(text, (rules.myName || []));
}

/**
 * Score a normalized message.
 * @param {object} msg  normalized message (see file header)
 * @param {object} opts { rules, repliedConversationIds?: Set<string> }
 * @returns {{isTask:boolean, score:number, reasons:string[], handled:boolean, dropped:boolean}}
 */
function classifyEmail(msg, opts) {
  const rules = (opts && opts.rules) || {};
  const repliedSet = (opts && opts.repliedConversationIds) || new Set();
  const reasons = [];

  const fromAddr = lower(msg.from && msg.from.address);

  // Automated / notification senders are dropped outright.
  if (isDeniedSender(fromAddr, rules.denySenders)) {
    return { isTask: false, score: 0, reasons: ['denied-sender'], handled: false, dropped: true };
  }

  let score = 0;
  const myEmail = lower(rules.myEmail);
  const to = Array.isArray(msg.toRecipients) ? msg.toRecipients : [];
  const cc = Array.isArray(msg.ccRecipients) ? msg.ccRecipients : [];
  const toAddrs = to.map((r) => lower(r.address));
  const ccAddrs = cc.map((r) => lower(r.address));
  const inTo = toAddrs.includes(myEmail);
  const inCc = ccAddrs.includes(myEmail);

  const rw = rules.recipientWeights || {};
  if (inTo) {
    if (toAddrs.length === 1) { score += rw.toOnlyRecipient || 0; reasons.push('to-only'); }
    else if (toAddrs[0] === myEmail) { score += rw.toFirstRecipient || 0; reasons.push('to-first'); }
    else { score += rw.toRecipient || 0; reasons.push('to'); }
  } else if (inCc) {
    score += rw.ccRecipient || 0; reasons.push('cc');
  }

  const text = `${lower(msg.subject)} \n ${lower(msg.bodyText || msg.bodyPreview)}`;

  const named = nameNextToRequest(text, rules);
  if (named) { score += rules.nameNextToRequestWeight || 0; reasons.push('name-next-to-request'); }

  if (rules.requestVerbs && anyWord(text, rules.requestVerbs.words)) {
    score += rules.requestVerbs.weight || 0; reasons.push('request-verb');
  }
  if (rules.deadlineTerms && anyWord(text, rules.deadlineTerms.words)) {
    score += rules.deadlineTerms.weight || 0; reasons.push('deadline');
  }
  if (lower(msg.importance) === 'high') { score += rules.importanceFlagWeight || 0; reasons.push('importance-high'); }
  if (lower(msg.flag && msg.flag.flagStatus) === 'flagged') { score += rules.followUpFlagWeight || 0; reasons.push('flagged'); }

  if (rules.allowSenders && Array.isArray(rules.allowSenders.domains)) {
    const dom = domainOf(fromAddr);
    if (rules.allowSenders.domains.some((d) => lower(d) === dom)) {
      score += rules.allowSenders.weight || 0; reasons.push('known-sender');
    }
  }

  // Large distribution list: I'm Cc'd among many and NOT named in the body.
  const dl = rules.largeDistributionList;
  if (dl && inCc && cc.length >= (dl.ccThreshold || 20) && !named && !nameInText(text, rules)) {
    score += dl.penalty || 0; reasons.push('large-dl');
  }

  // Pure FYI language, penalized (not a hard drop).
  if (rules.fyiPhrases && anyWord(text, rules.fyiPhrases.words)) {
    score += rules.fyiPhrases.penalty || 0; reasons.push('fyi');
  }

  const threshold = rules.threshold != null ? rules.threshold : 3.0;
  const isTask = score >= threshold;
  const handled = repliedSet.has(msg.conversationId);

  return { isTask, score: round1(score), reasons, handled, dropped: false };
}

module.exports = {
  classifyEmail,
  // exported for unit tests / reuse
  isDeniedSender,
  nameNextToRequest,
  domainOf,
  anyWord,
};
