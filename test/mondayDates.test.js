'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  extractDate,
  parseEntry,
  reconstructColumnValues,
  pageIsAllNew,
} = require('../src/parsers/mondayDates');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'activity-logs.json'), 'utf8')
);
const entries = fixture.entries;

test('extractDate handles object, string, null, {date:null}, empty', () => {
  assert.equal(extractDate({ date: '2026-08-14', icon: null }), '2026-08-14');
  assert.equal(extractDate('{"date":"2026-08-14"}'), '2026-08-14');
  assert.equal(extractDate(null), null);
  assert.equal(extractDate({ date: null }), null);
  assert.equal(extractDate({ date: '' }), null);
  assert.equal(extractDate('null'), null);
  assert.equal(extractDate('not json'), null);
});

test('parseEntry parses a JSON-string data payload', () => {
  const rec = parseEntry(entries[0]);
  assert.equal(rec.pulseName, 'Foothill Dental');
  assert.equal(rec.date, '2026-08-24');
  assert.equal(rec.isLeaf, false);
  assert.equal(rec.rollup, true);
  assert.equal(rec.columnId, 'date_mm4ad31d');
});

test('parseEntry returns null for junk / missing pulse_id', () => {
  assert.equal(parseEntry({ data: 'garbage{' }), null);
  assert.equal(parseEntry({ data: '{"no_pulse":1}' }), null);
  assert.equal(parseEntry(null), null);
});

test('newest-first: first occurrence wins over an older value', () => {
  const map = reconstructColumnValues(entries);
  // AV Shop Drawings appears twice: newest 2026-09-05 must beat older 2026-08-01
  assert.equal(map.get(12505903412).date, '2026-09-05');
});

test('a CLEARED (null) value beats an older date — Wu Yee has NO due date', () => {
  const map = reconstructColumnValues(entries);
  assert.ok(map.has(12600000001));
  assert.equal(map.get(12600000001).date, null, 'Wu Yee due date should be cleared');
});

test('known-good leaf deadlines are reconstructed', () => {
  const map = reconstructColumnValues(entries);
  assert.equal(map.get(12700000005).date, '2026-08-05'); // BART Telecom Shop Drawings
  assert.equal(map.get(12700000006).date, '2026-08-06'); // CCC Fire Security Shop Drawings
  assert.equal(map.get(12505842000).date, '2026-08-24'); // Foothill Dental (parent rollup)
});

test('parent rollup vs leaf flags are preserved', () => {
  const map = reconstructColumnValues(entries);
  assert.equal(map.get(12505842000).isLeaf, false); // parent
  assert.equal(map.get(12505842000).rollup, true);
  assert.equal(map.get(12505903412).isLeaf, true); // subitem
  assert.equal(map.get(12505903412).parentItemId, 12505842000);
});

test('reconstructColumnValues tolerates non-array input', () => {
  assert.equal(reconstructColumnValues(null).size, 0);
  assert.equal(reconstructColumnValues(undefined).size, 0);
});

test('pageIsAllNew bounds incremental paging', () => {
  // No prior watermark -> always keep paging.
  assert.equal(pageIsAllNew(entries, null), true);
  // Watermark above every created_at -> page is not all new (stop).
  assert.equal(pageIsAllNew(entries, '99999999999999999'), false);
  // Watermark below every created_at -> all new.
  assert.equal(pageIsAllNew(entries, '1'), true);
});
