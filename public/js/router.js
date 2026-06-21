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
import { renderProject }    from './views/project.js';
import { renderSettings }   from './views/settings.js';
import { setLastUsed, state } from './state.js';
import { expandSidebarProject } from './components/projectModal.js';

const TITLES = {
  today: 'Hoy',
  dashboard: 'Dashboard',
  calendar: 'Calendario',
  board: 'Board',
  whiteboard: 'Pizarra',
  pomodoro: 'Pomodoro',
  notes: 'Notas',
  btcAlerts: 'BTC Alerts',
  fitness: 'Fitness',
  mytime: 'Mi tiempo',
  settings: 'Ajustes',
};

let currentRoute = '';

const renderView = (route) => {
  const root = document.getElementById('view-content');
  if (!root) return;

  // Clear interval/cleanup if previous view registered one
  if (window._viewCleanup) {
    try { window._viewCleanup(); } catch {}
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
    case 'notes':      renderNotes(root); break;
    case 'btcAlerts':  renderBtcAlerts(root); break;
    case 'fitness':    renderFitness(root); break;
    case 'mytime':     renderMyTime(root); break;
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

export const router = {
  go(route) {
    if (route === currentRoute) return;
    currentRoute = route;
    setLastUsed({ view: route });
    renderView(route);
  },
  current() { return currentRoute; },
  refresh() { renderView(currentRoute || 'today'); },
};
