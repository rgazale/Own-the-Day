'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  bucketFor, countdownLabel, groupAndSort, urgentCount, diffDays, isVisible,
} = require('../src/parsers/buckets');

const TODAY = '2026-08-13';

test('bucketFor classifies relative to today', () => {
  assert.equal(bucketFor('2026-08-10', TODAY), 'overdue');
  assert.equal(bucketFor('2026-08-13', TODAY), 'today');
  assert.equal(bucketFor('2026-08-18', TODAY), 'week');
  assert.equal(bucketFor('2026-08-20', TODAY), 'week'); // +7 inclusive
  assert.equal(bucketFor('2026-08-21', TODAY), 'scheduled'); // +8
  assert.equal(bucketFor(null, TODAY), 'none');
});

test('countdownLabel formats over/today/in', () => {
  assert.equal(countdownLabel('2026-08-10', TODAY), '3d over');
  assert.equal(countdownLabel('2026-08-13', TODAY), 'due today');
  assert.equal(countdownLabel('2026-08-18', TODAY), 'in 5d');
});

test('diffDays is whole-day signed difference', () => {
  assert.equal(diffDays('2026-08-13', '2026-08-14'), 1);
  assert.equal(diffDays('2026-08-14', '2026-08-13'), -1);
});

test('groupAndSort orders buckets and sorts soonest-first', () => {
  const tasks = [
    { title: 'C scheduled', due_date: '2026-09-01' },
    { title: 'A overdue', due_date: '2026-08-01' },
    { title: 'B overdue', due_date: '2026-08-10' },
    { title: 'D no date', due_date: null },
    { title: 'E today', due_date: '2026-08-13' },
  ];
  const groups = groupAndSort(tasks, TODAY);
  assert.deepEqual(groups.map((g) => g.key), ['overdue', 'today', 'week', 'scheduled', 'none']);
  const overdue = groups.find((g) => g.key === 'overdue');
  assert.equal(overdue.count, 2);
  assert.deepEqual(overdue.tasks.map((t) => t.title), ['A overdue', 'B overdue']);
});

test('checked / dismissed / snoozed tasks are hidden', () => {
  assert.equal(isVisible({ checked: 1, due_date: '2026-08-01' }, TODAY), false);
  assert.equal(isVisible({ dismissed: 1, due_date: '2026-08-01' }, TODAY), false);
  assert.equal(isVisible({ snoozed_until: '2026-08-20', due_date: '2026-08-01' }, TODAY), false);
  assert.equal(isVisible({ snoozed_until: '2026-08-10', due_date: '2026-08-01' }, TODAY), true);
  assert.equal(isVisible({ due_date: '2026-08-01' }, TODAY), true);
});

test('urgentCount counts overdue + due today only, respecting visibility', () => {
  const tasks = [
    { title: 'x', due_date: '2026-08-01' },
    { title: 'y', due_date: '2026-08-13' },
    { title: 'z', due_date: '2026-08-20' },
    { title: 'snoozed', due_date: '2026-08-01', snoozed_until: '2026-08-20' },
  ];
  assert.equal(urgentCount(tasks, TODAY), 2);
});
