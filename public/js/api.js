// api.js — thin wrapper around the Tempo server REST API

const json = async (res) => {
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    let err;
    try { err = ct.includes('json') ? await res.json() : await res.text(); }
    catch { err = res.statusText; }
    throw new Error(typeof err === 'string' ? err : (err.error || res.statusText));
  }
  return ct.includes('json') ? res.json() : res.text();
};

export const api = {
  health:        () => fetch('/api/health').then(json),
  getState:      () => fetch('/api/state').then(json),
  putState:      (state) => fetch('/api/state', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state })
                  }).then(json),
  getConfig:     () => fetch('/api/config').then(json),
  connectVault:  (path) => fetch('/api/vault', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path })
                  }).then(json),
  disconnectVault: () => fetch('/api/vault', { method: 'DELETE' }).then(json),
  getVaultTree:  () => fetch('/api/vault/tree').then(json),
  getVaultFile:  (path) => fetch('/api/vault/file?path=' + encodeURIComponent(path)).then(json),
  saveVaultFile: (path, content) => fetch('/api/vault/save', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, content })
                  }).then(json),
  suggestVaults: () => fetch('/api/vault/suggest').then(json),
  listDir:       (path) => fetch('/api/vault/list-dir?path=' + encodeURIComponent(path || '')).then(json),

  // Obsidian project sync
  listProjects:  (rel = 'Projects') => fetch('/api/vault/list-projects?path=' + encodeURIComponent(rel)).then(json),
  standardizeProject: (data) => fetch('/api/vault/standardize-project', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                  }).then(json),
  importProjects: (items) => fetch('/api/vault/import-projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items }),
                  }).then(json),
  syncTasks:     (folder, name, tasks) => fetch('/api/vault/sync-tasks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folder, name, tasks }),
                  }).then(json),
  cleanLegacyTasks: (folders, alsoWipeTasksDir = false) => fetch('/api/vault/clean-legacy-tasks', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folders, alsoWipeTasksDir }),
                  }).then(json),
  listVaultTasks: (folder) => fetch('/api/vault/list-tasks?folder=' + encodeURIComponent(folder)).then(json),
  searchVault:    (q) => fetch('/api/search?q=' + encodeURIComponent(q)).then(json),

  // Local notes
  listNotes:     () => fetch('/api/notes').then(json),
  getNote:       (id) => fetch('/api/notes/' + encodeURIComponent(id)).then(json),
  createNote:    (data) => fetch('/api/notes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                  }).then(json),
  updateNote:    (id, data) => fetch('/api/notes/' + encodeURIComponent(id), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                  }).then(json),
  deleteNote:    (id) => fetch('/api/notes/' + encodeURIComponent(id), {
                    method: 'DELETE',
                  }).then(json),

  // Google Calendar (iCal subscriptions, multiple)
  getCalendarUrls: () => fetch('/api/calendar/urls').then(json),
  setCalendarUrls: (urls) => fetch('/api/calendar/urls', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls }),
                  }).then(json),
  addCalendarUrl: (url) => fetch('/api/calendar/urls/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url }),
                  }).then(json),
  removeCalendarUrl: (url) => fetch('/api/calendar/urls/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url }),
                  }).then(json),
  getCalendarEvents: (from, to) =>
                    fetch(`/api/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(json),

  // BTC price alerts
  getBtcPrice:    () => fetch('/api/btc/price').then(json),
  listBtcAlerts:  () => fetch('/api/btc/alerts').then(json),
  createBtcAlert: (data) => fetch('/api/btc/alerts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                  }).then(json),
  updateBtcAlert: (id, data) => fetch('/api/btc/alerts/' + encodeURIComponent(id), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                  }).then(json),
  deleteBtcAlert: (id) => fetch('/api/btc/alerts/' + encodeURIComponent(id), {
                    method: 'DELETE',
                  }).then(json),
  forceBtcCheck:  (force = false) => fetch('/api/btc/check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force }),
                  }).then(json),
  sendBtcTestEmail: (to) => fetch('/api/btc/test-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to }),
                  }).then(json),

  // Backup / restore
  exportAll:     () => fetch('/api/export').then(json),
  importAll:     (data) => fetch('/api/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data),
                  }).then(json),
};
