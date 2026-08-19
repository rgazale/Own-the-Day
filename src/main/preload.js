'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * preload.js — the only bridge between the renderer and the main process.
 * contextIsolation is on; the renderer gets a small, explicit API surface.
 */
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('tasks:get'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  check: (id, checked) => ipcRenderer.invoke('task:check', { id, checked }),
  snooze: (id, dateISO) => ipcRenderer.invoke('task:snooze', { id, dateISO }),
  setDue: (id, value) => ipcRenderer.invoke('task:setDue', { id, value }),
  setTitle: (id, title) => ipcRenderer.invoke('task:setTitle', { id, title }),
  dismiss: (id) => ipcRenderer.invoke('task:dismiss', { id }),
  remove: (id) => ipcRenderer.invoke('task:delete', { id }),
  addManual: (task) => ipcRenderer.invoke('task:add', task),
  open: (url) => ipcRenderer.invoke('task:open', { url }),
  // main -> renderer: refresh the list after a background sync completes
  onRefresh: (cb) => ipcRenderer.on('state:refresh', cb),
});
