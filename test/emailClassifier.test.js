'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { classifyEmail } = require('../src/parsers/emailClassifier');

const rules = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'email-rules.json'), 'utf8')
);
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'emails.json'), 'utf8')
);
const byId = Object.fromEntries(fixture.messages.map((m) => [m.conversationId, m]));

function classify(id, replied = new Set()) {
  return classifyEmail(byId[id], { rules, repliedConversationIds: replied });
}

test('to-only + deadline + request => task', () => {
  const r = classify('c-1');
  assert.equal(r.isTask, true);
  assert.ok(r.reasons.includes('to-only'));
  assert.ok(r.reasons.includes('deadline'));
});

test('automated notification sender is hard-dropped', () => {
  const r = classify('c-2');
  assert.equal(r.dropped, true);
  assert.equal(r.isTask, false);
});

test('large Cc distribution list, not named => not a task', () => {
  const r = classify('c-3');
  assert.equal(r.isTask, false);
  assert.ok(r.reasons.includes('large-dl'));
});

test('large Cc list BUT named next to a request => task', () => {
  const r = classify('c-4');
  assert.equal(r.isTask, true);
  assert.ok(r.reasons.includes('name-next-to-request'));
  assert.ok(!r.reasons.includes('large-dl'), 'named-in-body should cancel the DL penalty');
});

test('pure FYI, Cc only => not a task', () => {
  const r = classify('c-5');
  assert.equal(r.isTask, false);
  assert.ok(r.reasons.includes('fyi'));
});

test('a real ask I already replied to is a task but marked handled', () => {
  const r = classify('c-6', new Set(['c-6']));
  assert.equal(r.isTask, true);
  assert.equal(r.handled, true);
});

test('same ask, no reply yet => not handled', () => {
  const r = classify('c-6', new Set());
  assert.equal(r.isTask, true);
  assert.equal(r.handled, false);
});

test('score is a rounded number and reasons is an array', () => {
  const r = classify('c-1');
  assert.equal(typeof r.score, 'number');
  assert.ok(Array.isArray(r.reasons));
});
