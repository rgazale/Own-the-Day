#!/usr/bin/env node
'use strict';
/**
 * prove-monday.js — proves the monday integration end-to-end BEFORE any UI.
 * Run:  npm run prove:monday   (needs MONDAY_API_TOKEN in .env)
 *
 * Prints every task assigned to you, grouped by bucket, with the due dates
 * reconstructed from the activity log. Then spot-checks the known-good values
 * from the build brief so you can see at a glance that dates are correct.
 */

const config = require('../src/main/config');
const { syncMonday } = require('../src/sync/monday');
const { groupAndSort, countdownLabel, todayISO } = require('../src/parsers/buckets');

// Known-good values from the brief (as of 2026-08-11). Matched loosely by
// project + milestone text so we can flag mismatches.
const KNOWN_GOOD = [
  { project: 'Anthropic 300 Howard', milestone: 'Phase 1 100% CD', date: '2026-08-07' },
  { project: 'Anthropic 300 Howard', milestone: 'Phase 2 100% CD', date: '2026-08-14' },
  { project: 'SQRC', milestone: 'As-Built', date: '2026-08-14' },
  { project: 'Foothill Dental', milestone: '100% CD', date: '2026-08-24' },
  { project: 'Anthropic London', milestone: 'Monthly Report', date: '2026-08-04' },
  { project: 'Anthropic London', milestone: 'Stage 4 Working Floors', date: '2026-10-09' },
  { project: 'BART', milestone: 'Telecom Shop Drawings', date: '2026-08-05' },
  { project: 'CCC', milestone: 'Fire Security Shop Drawings', date: '2026-08-06' },
  { project: 'Wu Yee', milestone: '', date: null },
];

function pad(s, n) { return String(s ?? '').padEnd(n).slice(0, n); }

async function main() {
  if (!config.monday.token) {
    console.error('\n  ✗ MONDAY_API_TOKEN is not set. Copy .env.example to .env and paste your token.\n');
    process.exit(1);
  }
  const today = todayISO();
  console.log(`\n  MDC Daily — monday sync proof   (data as of ${today})`);
  console.log('  ' + '─'.repeat(72));

  const t0 = Date.now();
  const { tasks } = await syncMonday(config.monday);
  const ms = Date.now() - t0;

  const groups = groupAndSort(tasks, today);
  for (const g of groups) {
    if (!g.tasks.length) continue;
    console.log(`\n  ${g.label.toUpperCase()}  (${g.count})`);
    for (const t of g.tasks) {
      const cd = countdownLabel(t.due_date ?? t.dueDate, today);
      const kind = t.isLeaf ? 'sub ' : 'PROJ';
      console.log(
        `   ${pad(t.dueDate || '—', 11)} ${pad(cd, 9)} [${kind}] ${pad(t.project, 26)} ${t.title}`
      );
    }
  }

  const projects = new Set(tasks.map((t) => t.project));
  console.log('\n  ' + '─'.repeat(72));
  console.log(`  ${tasks.length} tasks across ${projects.size} projects in ${ms} ms.\n`);

  // Spot-check known-good values.
  console.log('  KNOWN-GOOD SPOT CHECK');
  for (const k of KNOWN_GOOD) {
    const hit = tasks.find(
      (t) =>
        (t.project || '').toLowerCase().includes(k.project.toLowerCase()) &&
        (k.milestone === '' || (t.title || '').toLowerCase().includes(k.milestone.toLowerCase()))
    );
    const got = hit ? hit.dueDate : '(not found)';
    const ok = hit && got === k.date;
    const mark = ok ? '✓' : '?';
    console.log(
      `   ${mark} ${pad(k.project + ' / ' + (k.milestone || 'no due date'), 44)} expected ${pad(k.date || 'none', 11)} got ${got || 'none'}`
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  ✗ monday sync failed:', e.message, '\n');
  process.exit(1);
});
