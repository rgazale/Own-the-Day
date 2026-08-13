'use strict';
/* renderer.js — draws the merged list and wires the row actions. */

const el = (id) => document.getElementById(id);
const SOURCE_BADGE = { monday: 'MONDAY', email: 'EMAIL', manual: 'MINE' };

function diffDays(aISO, bISO) {
  return Math.round((Date.parse(bISO + 'T00:00:00Z') - Date.parse(aISO + 'T00:00:00Z')) / 86400000);
}
function countdown(due, today) {
  if (!due) return { text: '', cls: 'none' };
  const d = diffDays(today, due);
  if (d < 0) return { text: `${Math.abs(d)}d over`, cls: 'overdue' };
  if (d === 0) return { text: 'due today', cls: 'today' };
  if (d <= 7) return { text: `in ${d}d`, cls: 'week' };
  return { text: `in ${d}d`, cls: 'scheduled' };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function rowNode(t, today) {
  const row = document.createElement('div');
  row.className = 'row';

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'chk';
  chk.checked = !!t.checked;
  chk.title = 'Check off (saved locally)';
  chk.addEventListener('change', async () => { await window.api.check(t.id, chk.checked); load(); });

  const main = document.createElement('div');
  main.className = 'row-main';
  const badge = SOURCE_BADGE[t.source] || t.source;
  const titleHtml = t.url
    ? `<a href="#" data-url="${esc(t.url)}">${esc(t.title)}</a>`
    : esc(t.title);
  main.innerHTML =
    `<div class="row-title">${titleHtml}</div>` +
    (t.scope ? `<div class="row-scope">${esc(t.scope)}</div>` : '') +
    `<div class="row-meta"><span class="badge badge--${badge}">${badge}</span>` +
    (t.project && t.source !== 'manual' ? `<span class="row-scope">${esc(t.project)}</span>` : '') +
    `</div>`;

  const right = document.createElement('div');
  right.className = 'row-right';
  const cd = countdown(t.due_date, today);
  right.innerHTML =
    `<span class="due">${t.due_date ? esc(t.due_date) : '—'}</span>` +
    (cd.text ? `<span class="cd cd--${cd.cls}">${cd.text}</span>` : '');

  const acts = document.createElement('div');
  acts.className = 'acts';
  const snoozeBtn = document.createElement('button');
  snoozeBtn.className = 'act'; snoozeBtn.textContent = 'snooze';
  snoozeBtn.addEventListener('click', async () => {
    const d = prompt('Snooze until (YYYY-MM-DD):', t.due_date || today);
    if (d) { await window.api.snooze(t.id, d); load(); }
  });
  acts.appendChild(snoozeBtn);
  if (t.source === 'email') {
    const dis = document.createElement('button');
    dis.className = 'act'; dis.textContent = 'dismiss';
    dis.title = 'Permanently hide this email thread';
    dis.addEventListener('click', async () => { await window.api.dismiss(t.id); load(); });
    acts.appendChild(dis);
  }
  right.appendChild(acts);

  main.querySelectorAll('a[data-url]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.api.open(a.dataset.url); })
  );

  row.append(chk, main, right);
  return row;
}

function render(state) {
  el('asof').textContent = state.lastSync ? state.lastSync.replace('T', ' ').replace('Z', '') : 'never';
  el('urgent').textContent = state.urgent;
  el('syncState').textContent = state.syncing ? 'syncing…' : '';

  const err = el('errorline');
  if (state.errors && state.errors.length) {
    err.hidden = false;
    err.textContent = '⚠ ' + state.errors.map((e) => `${e.source}: ${e.message}`).join('  ·  ') +
      '  — showing last good data';
  } else {
    err.hidden = true;
  }

  const list = el('list');
  list.innerHTML = '';
  let total = 0;
  for (const g of state.groups) {
    if (!g.count) continue;
    total += g.count;
    const h = document.createElement('div');
    h.className = `bucket-h bucket--${g.key}`;
    h.innerHTML = `<span class="bucket-name">${g.label}</span><span class="bucket-count">${g.count}</span>`;
    list.appendChild(h);
    for (const t of g.tasks) list.appendChild(rowNode(t, state.today));
  }
  if (total === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = state.syncing ? 'Syncing…' : 'Nothing open. You are caught up.';
    list.appendChild(e);
  }

  el('footcount').textContent = `${total} open`;
  const wb = [];
  if (state.writeback.monday) wb.push('monday write-back ON');
  if (state.writeback.outlook) wb.push('outlook write-back ON');
  if (!state.outlookConfigured) wb.push('outlook not configured');
  el('footwb').textContent = wb.join(' · ');
}

async function load() {
  const state = await window.api.getState();
  render(state);
}

// ---- wiring ----
el('syncBtn').addEventListener('click', async () => {
  el('syncState').textContent = 'syncing…';
  const state = await window.api.syncNow();
  render(state);
});
el('addBtn').addEventListener('click', () => { el('addForm').hidden = false; el('addTitle').focus(); });
el('addCancel').addEventListener('click', () => { el('addForm').hidden = true; el('addForm').reset(); });
el('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const task = {
    title: el('addTitle').value.trim(),
    project: el('addProject').value.trim(),
    dueDate: el('addDue').value || null,
  };
  if (!task.title) return;
  await window.api.addManual(task);
  el('addForm').hidden = true; el('addForm').reset();
  load();
});

window.api.onRefresh(() => load());
load();
