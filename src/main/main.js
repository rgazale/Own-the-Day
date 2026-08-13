'use strict';
/* eslint-disable no-console */
const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification, nativeImage, dialog,
} = require('electron');

const config = require('./config');
const { Store } = require('./db');
const { runSync } = require('../sync/engine');
const { groupAndSort, urgentCount, todayISO, bucketFor } = require('../parsers/buckets');
const { badgePng } = require('./pngutil');

let tray = null;
let win = null;
let store = null;
let syncing = false;
let lastErrors = [];
let syncTimer = null;
let isQuitting = false;

const ASSET = (f) => path.join(__dirname, '..', '..', 'assets', f);

function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

// ---------------------------------------------------------------- state
function buildState() {
  const today = todayISO();
  const all = store.allTasks();
  const groups = groupAndSort(all, today);
  const last = store.lastSuccessfulSync();
  const urgent = urgentCount(all, today);
  return {
    today,
    groups,
    urgent,
    lastSync: last ? last.finished_at : null,
    errors: lastErrors,
    syncing,
    writeback: { monday: config.monday.writeback, outlook: config.outlook.writeback },
    outlookConfigured: !!config.outlook.clientId,
  };
}

function refreshRenderer() {
  if (win && !win.isDestroyed()) win.webContents.send('state:refresh');
}

// ---------------------------------------------------------------- tray / badge
function updateTray() {
  const all = store.allTasks();
  const urgent = urgentCount(all, todayISO());
  if (tray) {
    tray.setToolTip(urgent > 0 ? `MDC Daily — ${urgent} due/overdue` : 'MDC Daily — all clear');
  }
  try { app.setBadgeCount(urgent); } catch (_) { /* platform */ }
  if (win && !win.isDestroyed()) {
    if (urgent > 0) {
      const img = nativeImage.createFromBuffer(badgePng());
      win.setOverlayIcon(img, `${urgent} due or overdue`);
    } else {
      win.setOverlayIcon(null, '');
    }
  }
}

// ---------------------------------------------------------------- notifications
function maybeNotifyOverdue() {
  if (!config.notify.onOverdue || !Notification.isSupported()) return;
  const today = todayISO();
  const all = store.allTasks();
  const overdueIds = all
    .filter((t) => !t.checked && !t.dismissed && !t.absent && !t.source_done)
    .filter((t) => bucketFor(t.due_date, today) === 'overdue')
    .map((t) => t.id);

  const prev = new Set(JSON.parse(store.getMeta('last_overdue_ids') || '[]'));
  const newly = overdueIds.filter((id) => !prev.has(id));
  store.setMeta('last_overdue_ids', JSON.stringify(overdueIds));

  if (newly.length === 0) return;
  if (store.getMeta('last_notify_date') === today) return; // at most one digest per day

  const titles = newly
    .map((id) => all.find((t) => t.id === id))
    .filter(Boolean)
    .slice(0, 4)
    .map((t) => `• ${t.project || t.title}`)
    .join('\n');
  new Notification({
    title: `MDC Daily — ${newly.length} newly overdue`,
    body: titles,
    icon: ASSET('icon.png'),
    silent: false,
  }).show();
  store.setMeta('last_notify_date', today);
}

// ---------------------------------------------------------------- sync
async function doSync(reason) {
  if (syncing) return;
  syncing = true;
  refreshRenderer();
  try {
    const result = await runSync(store, config, {
      deviceCodeCallback: (info) => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Sign in to Outlook',
          message: 'One-time Microsoft sign-in',
          detail: info.message,
          buttons: ['OK'],
        });
      },
    });
    lastErrors = result.errors;
    console.log(`[sync:${reason}]`, JSON.stringify(result.counts), result.errors.length ? result.errors : 'ok');
  } catch (e) {
    lastErrors = [{ source: 'engine', message: e.message }];
    console.error('[sync] fatal', e);
  } finally {
    syncing = false;
    updateTray();
    maybeNotifyOverdue();
    refreshRenderer();
  }
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  const mins = Math.max(5, config.sync.intervalMinutes || 60);
  syncTimer = setInterval(() => doSync('interval'), mins * 60 * 1000);
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 800,
    minWidth: 400,
    minHeight: 480,
    show: false,
    title: 'MDC Daily',
    backgroundColor: '#F7F6F2',
    icon: ASSET('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // When launched by the Windows autostart entry (args include --hidden),
  // start silently in the tray instead of popping the window open.
  const startHidden = process.argv.includes('--hidden');
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); } // minimize to tray
  });
}

function createTray() {
  const img = nativeImage.createFromPath(ASSET('tray.png'));
  tray = new Tray(img);
  const menu = Menu.buildFromTemplate([
    { label: 'Open MDC Daily', click: () => showWindow() },
    { label: 'Sync now', click: () => doSync('tray') },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('MDC Daily');
  tray.on('click', () => showWindow());
}

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('tasks:get', () => buildState());
  ipcMain.handle('sync:now', async () => { await doSync('manual'); return buildState(); });
  ipcMain.handle('task:check', (_e, { id, checked }) => {
    store.setChecked(id, checked);
    updateTray();
    return buildState();
  });
  ipcMain.handle('task:snooze', (_e, { id, dateISO }) => {
    store.snooze(id, dateISO);
    updateTray();
    return buildState();
  });
  ipcMain.handle('task:dismiss', (_e, { id }) => {
    store.dismiss(id);
    updateTray();
    return buildState();
  });
  ipcMain.handle('task:add', (_e, task) => {
    store.addManual(task);
    updateTray();
    return buildState();
  });
  ipcMain.handle('task:open', (_e, { url }) => {
    if (url) shell.openExternal(url);
    return true;
  });
}

// ---------------------------------------------------------------- lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    store = await Store.open(path.join(dataDir(), 'mdc-daily.sqlite'));

    // Proper autostart entry (registry Run key on Windows), not a shortcut hack.
    app.setLoginItemSettings({
      openAtLogin: config.autostart,
      args: ['--hidden'],
    });

    if (app.setAppUserModelId) app.setAppUserModelId('com.mcmillanlv.mdcdaily');

    registerIpc();
    createTray();
    createWindow();
    updateTray();

    // Sync on launch, then on the configured interval.
    doSync('launch');
    scheduleSync();
  });

  app.on('window-all-closed', () => { /* stay in tray */ });
  app.on('before-quit', () => { isQuitting = true; if (store) store.close(); });
}
