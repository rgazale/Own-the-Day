'use strict';
/* renderer.js — draws the merged list, inline date editing, and row actions. */

const el = (id) => document.getElementById(id);
const SOURCE_BADGE = { monday: 'MONDAY', email: 'EMAIL', manual: 'MINE' };
let filterText = '';

function diffDays(aISO, bISO) {
  return Math.round((Date.parse(bISO + 'T00:00:00Z') - Date.parse(aISO + 'T00:00:00Z')) / 86400000);
}
function countdown(due, today) {
  if (!due) return { text: '', cls: 'none' };
  const d = diffDays(today, due);
  if (d < 0) return { text: `${Math.abs(d)}d overdue`, cls: 'overdue' };
  if (d === 0) return { text: 'due today', cls: 'today' };
  if (d <= 7) return { text: `in ${d}d`, cls: 'week' };
  return { text: `in ${d}d`, cls: 'scheduled' };
}
function effectiveDue(t) {
  const ov = t.due_override;
  if (ov !== undefined && ov !== null) return ov === '' ? null : ov;
  return t.due_date || null;
}
function isOverridden(t) {
  return t.due_override !== undefined && t.due_override !== null;
}
function effTitle(t) { return t.title_override || t.title || ''; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1];
  return `${mon} ${+d}`;
}

/* ---- inline due-date editor ---- */
function openDateEditor(pill, t) {
  const today = pill.dataset.today;
  const wrap = document.createElement('span');
  wrap.className = 'date-edit';
  const input = document.createElement('input');
  input.type = 'date';
  input.value = effectiveDue(t) || '';
  const save = document.createElement('button');
  save.className = 'mini'; save.textContent = '✓'; save.title = 'Save';
  const clear = document.createElement('button');
  clear.className = 'mini'; clear.textContent = 'clear'; clear.title = 'Remove the date';
  wrap.append(input, save, clear);
  pill.replaceWith(wrap);
  input.focus();

  let done = false;
  const commit = async (value) => {
    if (done) return; done = true;
    await window.api.setDue(t.id, value);
    load();
  };
  save.addEventListener('click', () => commit(input.value || ''));
  clear.addEventListener('click', () => commit('')); // '' => deliberately no date
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(input.value || '');
    if (e.key === 'Escape') { done = true; load(); }
  });
}

function duePill(t, today) {
  const due = effectiveDue(t);
  const pill = document.createElement('button');
  pill.className = 'due-pill' + (due ? '' : ' empty');
  pill.dataset.today = today;
  pill.textContent = due ? fmtDate(due) : '+ add date';
  pill.title = due ? 'Click to change the due date' : 'Click to set a due date';
  pill.addEventListener('click', () => openDateEditor(pill, t));
  return pill;
}

function rowNode(t, today) {
  const due = effectiveDue(t);
  const cd = countdown(due, today);
  const row = document.createElement('div');
  row.className = 'row' + (cd.cls === 'overdue' ? ' is-overdue' : cd.cls === 'today' ? ' is-today' : '');

  const chk = document.createElement('input');
  chk.type = 'checkbox'; chk.className = 'chk'; chk.checked = !!t.checked;
  chk.title = 'Mark done (saved on this PC)';
  chk.addEventListener('change', async () => { await window.api.check(t.id, chk.checked); load(); });

  const main = document.createElement('div');
  main.className = 'row-main';
  const badge = SOURCE_BADGE[t.source] || t.source;
  const title = esc(effTitle(t));
  const titleHtml = t.url ? `<a href="#" data-url="${esc(t.url)}">${title}</a>` : title;
  main.innerHTML =
    `<div class="row-title">${titleHtml}</div>` +
    (t.scope ? `<div class="row-scope">${esc(t.scope)}</div>` : '') +
    `<div class="row-meta">` +
      `<span class="badge badge--${badge}">${badge}</span>` +
      (t.project && t.source !== 'manual' ? `<span class="chip-project">${esc(t.project)}</span>` : '') +
      (isOverridden(t) ? `<span class="local-flag" title="You set this date locally; monday is unchanged">local date</span>` : '') +
    `</div>`;

  const right = document.createElement('div');
  right.className = 'row-right';
  right.appendChild(duePill(t, today));
  if (cd.text) {
    const cdEl = document.createElement('span');
    cdEl.className = `cd cd--${cd.cls}`; cdEl.textContent = cd.text;
    right.appendChild(cdEl);
  }

  const acts = document.createElement('div');
  acts.className = 'acts';
  acts.appendChild(mkAct('snooze', 'Hide until a date', async () => {
    const d = prompt('Snooze until (YYYY-MM-DD):', due || today);
    if (d) { await window.api.snooze(t.id, d); load(); }
  }));
  if (t.source === 'manual') {
    acts.appendChild(mkAct('rename', 'Rename this task', async () => {
      const name = prompt('Rename task:', effTitle(t));
      if (name && name.trim()) { await window.api.setTitle(t.id, name.trim()); load(); }
    }));
    acts.appendChild(mkAct('delete', 'Delete this task', async () => {
      if (confirm('Delete this task?')) { await window.api.remove(t.id); load(); }
    }, true));
  } else if (t.source === 'email') {
    acts.appendChild(mkAct('dismiss', 'Permanently hide this email thread', async () => {
      await window.api.dismiss(t.id); load();
    }, true));
  }
  right.appendChild(acts);

  main.querySelectorAll('a[data-url]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); window.api.open(a.dataset.url); })
  );

  row.append(chk, main, right);
  return row;
}

function mkAct(label, title, handler, danger) {
  const b = document.createElement('button');
  b.className = 'act' + (danger ? ' danger' : '');
  b.textContent = label; b.title = title;
  b.addEventListener('click', handler);
  return b;
}

function matches(t) {
  if (!filterText) return true;
  const hay = `${effTitle(t)} ${t.project || ''} ${t.scope || ''}`.toLowerCase();
  return hay.includes(filterText);
}

const BUCKET_CLASS = { overdue: 'b-overdue', today: 'b-today', week: 'b-week', scheduled: 'b-scheduled', none: 'b-none' };

function render(state) {
  el('asof').textContent = state.lastSync ? state.lastSync.replace('T', ' ').replace('Z', '') : 'never';
  const urgent = el('urgent');
  urgent.textContent = state.urgent;
  urgent.classList.toggle('zero', state.urgent === 0);
  el('syncState').textContent = state.syncing ? 'syncing…' : '';

  const err = el('errorline');
  if (state.errors && state.errors.length) {
    err.hidden = false;
    err.textContent = '⚠ ' + state.errors.map((e) => `${e.source}: ${e.message}`).join('  ·  ') + '  — showing last good data';
  } else err.hidden = true;

  const list = el('list');
  list.innerHTML = '';
  let total = 0;
  for (const g of state.groups) {
    const tasks = g.tasks.filter(matches);
    if (!tasks.length) continue;
    total += tasks.length;
    const h = document.createElement('div');
    h.className = `bucket ${BUCKET_CLASS[g.key]}`;
    h.innerHTML = `<span class="bucket-dot"></span><span class="bucket-name">${g.label}</span><span class="bucket-count">${tasks.length}</span>`;
    list.appendChild(h);
    for (const t of tasks) list.appendChild(rowNode(t, state.today));
  }
  if (total === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = state.syncing
      ? 'Syncing…'
      : filterText
        ? `No tasks match “${esc(filterText)}”.`
        : 'Nothing open. <div class="empty-sub">You are caught up. 🎉</div>';
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
  render(await window.api.getState());
}

/* ---- wiring ---- */
el('syncBtn').addEventListener('click', async () => {
  el('syncState').textContent = 'syncing…';
  render(await window.api.syncNow());
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
el('search').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); load(); });

window.api.onRefresh(() => load());
load();
