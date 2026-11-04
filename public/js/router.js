// router.js — view switcher

import { renderToday }      from './views/today.js';
import { renderDashboard }  from './views/dashboard.js';
import { renderCalendar }   from './views/calendar.js';
import { renderBoard }      from './views/board.js';
import { renderWhiteboard } from './views/whiteboard.js';
import { renderPomodoro }   from './views/pomodoro.js';
import { renderNotes }      from './views/notes.js';
import { renderBtcAlerts }  from './views/btcAlerts.js';
import { renderFitness }    from './views/fitness.js';
import { renderMyTime }     from './views/mytime.js';
import { renderBills }      from './views/bills.js';
import { renderPromos }     from './views/promos.js';
import { renderProject }    from './views/project.js';
import { renderSettings }   from './views/settings.js';
import { setLastUsed, state } from './state.js';
import { expandSidebarProject } from './components/projectModal.js';
import { closeAllModals } from './components/modal.js';

const TITLES = {
  today: 'Hoy',
  dashboard: 'Dashboard',
  calendar: 'Agenda',
  board: 'Board',
  whiteboard: 'Pizarra',
  pomodoro: 'Pomodoro',
  notes: 'Notas',
  btcAlerts: 'BTC Alerts',
  fitness: 'Fitness',
  mytime: 'Mi tiempo',
  bills: 'Cuentas',
  promos: 'Promociones',
  settings: 'Ajustes',
};

let currentRoute = '';

const renderView = (route) => {
  const root = document.getElementById('view-content');
  if (!root) return;

  // Clear interval/cleanup if previous view registered one
  if (window._viewCleanup) {
    // Un cleanup que tira puede dejar intervals/listeners colgados entre vistas
    try { window._viewCleanup(); } catch (e) { console.warn('[router] view cleanup falló', e); }
    window._viewCleanup = null;
  }

  root.innerHTML = '';
  root.scrollTop = 0;

  const [base, ...rest] = route.split('/');
  const arg = rest.join('/');

  let title = TITLES[base] || 'Tempo';

  switch (base) {
    case 'today':      renderToday(root); break;
    case 'dashboard':  renderDashboard(root); break;
    case 'calendar':   renderCalendar(root); break;
    case 'board':      renderBoard(root); break;
    case 'whiteboard': renderWhiteboard(root); break;
    case 'pomodoro':   renderPomodoro(root); break;
    case 'notes':      renderNotes(root, arg); break;
    case 'btcAlerts':  renderBtcAlerts(root); break;
    case 'fitness':    renderFitness(root); break;
    case 'mytime':     renderMyTime(root); break;
    case 'bills':      renderBills(root); break;
    case 'promos':     renderPromos(root); break;
    case 'project': {
      title = renderProject(root, arg) || 'Proyecto';
      // expand any ancestor in the sidebar so this subproject is visible
      let cursor = state.projects.find(p => p.id === arg);
      while (cursor?.parentId) { expandSidebarProject(cursor.parentId); cursor = state.projects.find(p => p.id === cursor.parentId); }
      break;
    }
    case 'settings':   renderSettings(root); break;
    default:           renderToday(root);
  }

  const titleEl = document.getElementById('view-title');
  if (titleEl) titleEl.textContent = title;

  // Highlight active nav button (only top-level matches)
  document.querySelectorAll('.nav-btn[data-route]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.route === base);
  });

  document.querySelectorAll('.project-pill').forEach(pill => {
    pill.classList.toggle('active', base === 'project' && pill.dataset.id === arg);
  });
};

// ----- Rutas en la URL (#bills, #project/<id>) -----
// Sin historial, el gesto "atrás" del celular cerraba la PWA. Cada vista apila
// una entrada; atrás vuelve a la anterior y, si hay algo abierto encima (modal,
// captura rápida, menú lateral), primero lo cierra y se queda en la vista.
const hashFor = (route) => '#' + route.split('/').map(encodeURIComponent).join('/');
const isKnownRoute = (route) => { const base = route.split('/')[0]; return base === 'project' || Object.hasOwn(TITLES, base); };
const routeFromHash = () => {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return '';
  let route;
  try { route = raw.split('/').map(decodeURIComponent).join('/'); } catch { return ''; }
  return isKnownRoute(route) ? route : '';
};
// Vista de arranque: la del link (#...) gana sobre la última usada en este dispositivo.
export const initialRoute = () => routeFromHash() || state.lastUsed?.view || 'today';

const writeHistory = (route, replace) => {
  try { history[replace ? 'replaceState' : 'pushState']({ route }, '', hashFor(route)); }
  catch (e) { console.warn('[router] history no disponible', e); }
};

export const router = {
  go(route, { fromHistory = false } = {}) {
    if (route === currentRoute) return;
    // La primera vista reemplaza la entrada: atrás desde ahí sale de la app, no a una página vacía.
    if (!fromHistory) writeHistory(route, !currentRoute);
    currentRoute = route;
    setLastUsed({ view: route });
    renderView(route);
  },
  current() { return currentRoute; },
  refresh() { renderView(currentRoute || 'today'); },
};

window.addEventListener('popstate', () => {
  const overlay = document.querySelector('.modal-backdrop.open, .qc-backdrop.open');
  if (overlay || document.body.classList.contains('nav-open')) {
    closeAllModals();
    document.querySelector('.qc-backdrop.open')?.classList.remove('open');
    document.body.classList.remove('nav-open');
    if (currentRoute) writeHistory(currentRoute, false); // re-apilar: la vista no cambia
    return;
  }
  const target = routeFromHash();
  // Hash inválido (tipeado a mano): corregir la URL y quedarse en la vista actual
  if (!target) { writeHistory(currentRoute || 'today', true); return; }
  router.go(target, { fromHistory: true });
});
