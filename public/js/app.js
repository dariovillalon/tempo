// app.js — bootstrap: load state, wire chrome, mount router

import { api } from './api.js';
import { state, initState, subscribe, getSaveStatus, runObsidianAutoImport, refreshTasksFromVault, reloadState } from './state.js';
import { router } from './router.js';
import { todayKey, fmtDate } from './utils.js';
import { initModals } from './components/modal.js';
import { initBlockModal } from './components/blockModal.js';
import { initTaskModal } from './components/taskModal.js';
import { initProjectModal, renderSidebarProjects } from './components/projectModal.js';
import { initVaultModal } from './components/vaultModal.js';
import { initQuickCapture } from './components/quickCapture.js';
import { initImportModal } from './components/importModal.js';
import { initVaultFolderPicker } from './components/vaultFolderPicker.js';
import { initReviewModal } from './components/reviewModal.js';
import { initFocusMode } from './components/focusMode.js';
import { startNotifications, requestNotifPermission } from './notifications.js';
import { startGlobalTicker } from './views/pomodoro.js';
import { toast } from './components/toast.js';
import { openTaskModal } from './components/taskModal.js';
import { applyTheme } from './theme.js';

const wireSidebar = () => {
  document.querySelectorAll('.nav-btn[data-route]').forEach(btn => {
    btn.addEventListener('click', () => router.go(btn.dataset.route));
  });
  document.getElementById('pom-mini').addEventListener('click', () => router.go('pomodoro'));

  // Topbar refresh: re-read tasks/ folder from each linked project (vault wins).
  const refreshBtn = document.getElementById('vault-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    if (!state.vault?.path) { toast('Sin vault conectado', 'info'); return; }
    refreshBtn.classList.add('spinning');
    try {
      const r = await refreshTasksFromVault();
      if (r.ok) {
        toast(`Sync: +${r.added || 0} · ~${r.updated || 0} · -${r.removed || 0}`, 'success');
        router.refresh();
      } else {
        toast('Error: ' + (r.reason || 'desconocido'), 'error');
      }
    } catch (e) { toast('Error: ' + e.message, 'error'); }
    finally { refreshBtn.classList.remove('spinning'); }
  });
};

const updateChrome = () => {
  // Date pill
  const datePill = document.getElementById('date-pill');
  if (datePill) datePill.textContent = fmtDate(new Date(), { weekday: true, short: true });

  // Save indicator
  const saveEl = document.getElementById('save-indicator');
  if (saveEl) {
    saveEl.classList.remove('saving', 'saved', 'error');
    const s = getSaveStatus();
    if (s !== 'idle') saveEl.classList.add(s);
    saveEl.title = s === 'saving' ? 'Guardando...' : (s === 'error' ? 'Error al guardar' : 'Sincronizado');
  }

  // Board count badge
  const badge = document.getElementById('nav-board-count');
  if (badge) {
    const n = state.tasks.filter(t => t.state !== 'done').length;
    badge.textContent = String(n);
  }

  // Projects sidebar
  renderSidebarProjects();
};

const main = async () => {
  try {
    await initState();
  } catch (e) {
    document.body.innerHTML = `
      <div style="padding:60px;text-align:center;color:#e8e9ed;font-family:system-ui">
        <h1>No pude conectarme al servidor</h1>
        <p style="color:#797d88">¿Está corriendo? Probá <code>node server.js</code></p>
        <pre style="color:#e26b6b">${String(e.message || e)}</pre>
      </div>
    `;
    return;
  }

  // Apply persisted theme
  applyTheme(state.settings?.theme || 'dark');

  // Initial chrome
  updateChrome();

  // Wire components
  initModals();
  initBlockModal();
  initTaskModal();
  initProjectModal();
  initVaultModal();
  initQuickCapture();
  initImportModal();
  initVaultFolderPicker();
  initReviewModal();
  initFocusMode();

  wireSidebar();

  // Subscribe to state changes
  subscribe(() => updateChrome());

  // Periodic chrome refresh (date pill rolls over at midnight, etc.)
  setInterval(updateChrome, 60_000);

  // Pomodoro mini display ticker
  startGlobalTicker();

  // Desktop notifications for upcoming meetings (idempotent — uses Permission API)
  if (state.settings?.notifEnabled !== false) startNotifications();

  // Initial route
  const initialRoute = state.lastUsed?.view || 'today';
  router.go(initialRoute);

  // Auto-import Obsidian projects (silent, idempotent) every time the app boots.
  // Picks up new folders in <vault>/<root>/ down to settings.autoImportDepth.
  if (state.vault?.path && state.settings?.autoImportObsidian !== false) {
    runObsidianAutoImport({ silent: true }).then(res => {
      if (res?.ok && res.projects > 0) {
        toast(`Importé ${res.projects} proyecto(s) nuevo(s) de Obsidian`, 'success');
        router.refresh();
      }
    }).catch(() => {});
  }

  // Re-render the current view when state changes happen.
  // Defer to a task so handlers that mutate then close a modal still trigger a refresh.
  let refreshScheduled = false;
  subscribe((event) => {
    if (event === 'init' || event === 'save-status') return;
    if (refreshScheduled) return;
    refreshScheduled = true;
    setTimeout(() => {
      refreshScheduled = false;
      const view = router.current().split('/')[0];
      if (!view || view === 'pomodoro') return;
      if (document.querySelector('.modal-backdrop.open')) return;
      router.refresh();
    }, 0);
  });

  // Helpful shortcut: open Quick Capture from search field everywhere
  // + vim-style 'g' prefix for navigation, 'n' for new task, '?' for cheatsheet
  const isTyping = () => {
    const a = document.activeElement;
    if (!a) return false;
    if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
    if (a.isContentEditable) return true;
    return false;
  };
  let gWaiting = false;
  let gTimer = null;
  const G_MAP = {
    t: 'today', d: 'dashboard', c: 'calendar', b: 'board',
    p: 'pomodoro', n: 'notes', w: 'whiteboard', s: 'settings',
    f: 'fitness', m: 'mytime',
  };
  document.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (gWaiting) {
      const dest = G_MAP[e.key.toLowerCase()];
      gWaiting = false;
      clearTimeout(gTimer);
      if (dest) { e.preventDefault(); router.go(dest); }
      return;
    }

    if (e.key === 'g') {
      gWaiting = true;
      gTimer = setTimeout(() => { gWaiting = false; }, 800);
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('quick-capture-btn').click();
      return;
    }
    if (e.key === 'n') {
      e.preventDefault();
      openTaskModal({ state: 'inbox' });
      return;
    }
    if (e.key === '?') {
      e.preventDefault();
      toast('g+t/d/c/b/p/n/w/s · n nueva tarea · pizarra: V/S/R/O/T/C/A · ⌘Z deshacer · ⌘K búsqueda', 'info');
    }
  });

  // Re-sincronizar al volver a la pestaña (evita que una pestaña vieja pise datos nuevos)
  let _lastResync = Date.now();
  const resync = async () => {
    if (document.hidden) return;
    if (getSaveStatus() === 'saving') return;
    if (Date.now() - _lastResync < 2000) return;
    _lastResync = Date.now();
    const ok = await reloadState();
    if (ok && !document.querySelector('.modal-backdrop.open')) {
      const view = router.current().split('/')[0];
      if (view !== 'pomodoro') router.refresh();
    }
  };
  window.addEventListener('focus', resync);
  document.addEventListener('visibilitychange', resync);

  // Health ping
  api.health().catch(() => toast('Servidor inalcanzable', 'error'));
};

main();
