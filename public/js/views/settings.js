// settings.js — preferences, theme, vault, data export/import

import {
  state, updateSettings, updatePomodoroSettings, setVault,
  runObsidianAutoImport, removeAllVaultLinkedProjects, removeAllTasks,
  getAssignees, addAssignee, updateAssignee, removeAssignee,
} from '../state.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { openVaultModal } from '../components/vaultModal.js';
import { openImportModal } from '../components/importModal.js';
import { router } from '../router.js';
import { escapeHtml } from '../utils.js';
import { applyTheme } from '../theme.js';
import { invalidateCalendarCache } from './calendar.js';
import { requestNotifPermission, startNotifications } from '../notifications.js';

export const renderSettings = (root) => {
  const s = state.settings;
  const ps = state.pomodoroSettings;
  const v = state.vault;

  root.innerHTML = `
    <div class="view-h">
      <h2>Ajustes</h2>
    </div>

    <div class="settings-grid">
      <div class="card">
        <div class="card-header"><div class="card-title">Perfil</div></div>
        <div class="field">
          <label>Tu nombre (saludo)</label>
          <input type="text" class="input" id="set-username" value="${escapeHtml(s.userName || '')}" placeholder="Dario">
        </div>
        <div class="field">
          <label>Tema</label>
          <div class="board-filter-group" id="theme-group">
            <button class="board-filter ${s.theme === 'dark' ? 'active' : ''}" data-theme="dark">Oscuro</button>
            <button class="board-filter ${s.theme === 'light' ? 'active' : ''}" data-theme="light">Claro</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Notificaciones</div></div>
        <div class="field">
          <label>Notificaciones desktop</label>
          <label class="row gap-6" style="cursor:pointer">
            <input type="checkbox" id="notif-enabled" ${s.notifEnabled !== false ? 'checked' : ''}>
            <span>Activadas</span>
          </label>
        </div>
        <div class="field">
          <label>Avisar antes de reuniones (min)</label>
          <input type="number" class="input" id="notif-lead" min="1" max="60" value="${s.notifLeadMin ?? 5}">
        </div>
        <div class="row gap-6">
          <button class="btn btn-secondary btn-sm" id="notif-permission">Pedir permiso</button>
          <span class="muted text-xs" id="notif-status">—</span>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Día / metas</div></div>
        <div class="field-row">
          <div class="field">
            <label>Inicio del día</label>
            <input type="number" class="input" id="set-day-start" min="0" max="23" value="${s.dayStartHour ?? 7}">
          </div>
          <div class="field">
            <label>Fin del día</label>
            <input type="number" class="input" id="set-day-end" min="1" max="24" value="${s.dayEndHour ?? 22}">
          </div>
        </div>
        <div class="field">
          <label>Meta semanal (horas)</label>
          <input type="number" class="input" id="set-week-goal" min="1" max="100" value="${s.weeklyGoalHours ?? 35}">
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Personas</div></div>
        <div class="muted text-sm" style="margin-bottom:10px">
          Personas que podés asignar a tareas. La inicial se usa como avatar en las cards del board.
        </div>
        <div id="assignees-list"></div>
        <div class="row gap-6" style="align-items:stretch;margin-top:10px;flex-wrap:wrap">
          <input type="text" class="input" id="assignee-name-new" placeholder="Nombre" style="flex:1;min-width:140px">
          <input type="color" class="input" id="assignee-color-new" value="#8a8a8a" style="width:46px;padding:2px;cursor:pointer">
          <button class="btn btn-secondary btn-sm" id="assignee-add">+ Agregar</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Pomodoro</div></div>
        <div class="field-row">
          <div class="field">
            <label>Foco (min)</label>
            <input type="number" class="input" id="pom-focus" min="1" max="120" value="${ps.focus}">
          </div>
          <div class="field">
            <label>Pausa corta (min)</label>
            <input type="number" class="input" id="pom-short" min="1" max="60" value="${ps.shortBreak}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Pausa larga (min)</label>
            <input type="number" class="input" id="pom-long" min="1" max="60" value="${ps.longBreak}">
          </div>
          <div class="field">
            <label>Pausa larga c/</label>
            <input type="number" class="input" id="pom-every" min="2" max="20" value="${ps.longEvery}">
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Obsidian</div></div>
        ${v?.path
          ? `<div class="text-sm" style="margin-bottom:10px">
              <strong>Conectado:</strong>
              <div class="muted mono text-xs" style="word-break:break-all;margin-top:3px">${escapeHtml(v.path)}</div>
              <div class="muted text-xs" style="margin-top:6px">${v.notes ?? 0} notas · ${v.files ?? 0} archivos · ${v.folders ?? 0} carpetas</div>
             </div>
             <div class="field">
               <label>Auto-import al iniciar</label>
               <div class="row gap-6">
                 <label class="row gap-6" style="cursor:pointer">
                   <input type="checkbox" id="auto-import" ${s.autoImportObsidian !== false ? 'checked' : ''}>
                   <span>Activado</span>
                 </label>
               </div>
             </div>
             <div class="field-row">
               <div class="field">
                 <label>Carpeta raíz</label>
                 <input type="text" class="input mono" id="auto-import-root" value="${escapeHtml(s.autoImportRoot || 'Projects')}" placeholder="Projects">
               </div>
               <div class="field">
                 <label>Profundidad de subprojects</label>
                 <select class="select" id="auto-import-depth">
                   <option value="0" ${s.autoImportDepth === 0 ? 'selected' : ''}>0 — solo top-level</option>
                   <option value="1" ${(s.autoImportDepth ?? 1) === 1 ? 'selected' : ''}>1 — top + 1 nivel (recomendado)</option>
                   <option value="2" ${s.autoImportDepth === 2 ? 'selected' : ''}>2 — hasta 2 niveles</option>
                   <option value="9" ${s.autoImportDepth === 9 ? 'selected' : ''}>9 — todo</option>
                 </select>
               </div>
             </div>
             <div class="row gap-6" style="flex-wrap:wrap;margin-top:8px">
               <button class="btn btn-secondary btn-sm" id="vault-change">Cambiar carpeta</button>
               <button class="btn btn-secondary btn-sm" id="reimport-now">↓ Re-importar ahora</button>
               <button class="btn btn-secondary btn-sm" id="open-import-wizard">Wizard de selección…</button>
               <button class="btn btn-danger btn-sm" id="clean-legacy-md">Borrar tasks.md legacy</button>
               <button class="btn btn-danger btn-sm" id="wipe-vault-tasks">Vaciar tasks/ del vault</button>
               <button class="btn btn-danger btn-sm" id="unlink-all">Desvincular todos</button>
               <button class="btn btn-danger btn-sm" id="vault-disconnect">Desconectar vault</button>
             </div>`
          : `<div class="muted text-sm" style="margin-bottom:10px">Conectá tu vault para importar proyectos automáticamente.</div>
             <button class="btn btn-primary btn-sm" id="vault-connect">Conectar</button>`
        }
      </div>

      <div class="card" style="grid-column:1/-1">
        <div class="card-header"><div class="card-title">Google Calendar</div></div>
        <div class="muted text-sm" style="margin-bottom:10px;line-height:1.55">
          Pegá una o más URLs <strong>secretas iCal</strong> (laburo + personal, etc).
          Tempo merge-ea todos los eventos en <em>Hoy</em> y <em>Calendario</em>.
        </div>
        <div id="cal-urls-list"></div>
        <div class="row gap-6" style="align-items:stretch;margin-top:8px">
          <input type="text" class="input mono" id="cal-url-new" placeholder="https://calendar.google.com/calendar/ical/..." style="font-size:11.5px">
          <button class="btn btn-secondary btn-sm" id="cal-url-add">+ Agregar</button>
        </div>
        <div class="muted text-xs" id="cal-status" style="margin-top:8px"></div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <div class="card-header"><div class="card-title">Datos</div></div>
        <div class="muted text-sm" style="margin-bottom:10px">
          Backup completo: estado + notas locales en un único JSON.
          Importar fusiona el estado y agrega las notas.
        </div>
        <div class="row gap-6" style="flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" id="data-export">Exportar JSON</button>
          <input type="file" id="data-import-file" accept=".json,application/json" style="display:none">
          <button class="btn btn-secondary btn-sm" id="data-import">Importar JSON</button>
          <button class="btn btn-danger btn-sm" id="wipe-tasks">Borrar todas las tareas</button>
        </div>
        <div class="muted text-xs" style="margin-top:6px">
          "Borrar tareas" elimina todas las tareas en Tempo y vacía el folder
          <code>tasks/</code> de cada proyecto vinculado en Obsidian (los demás archivos quedan intactos).
        </div>
      </div>
    </div>
  `;

  // ---- Wiring ----
  const u = root.querySelector('#set-username');
  u.addEventListener('change', () => updateSettings({ userName: u.value.trim() || 'Dario' }));

  root.querySelectorAll('#theme-group [data-theme]').forEach(b => {
    b.addEventListener('click', () => {
      const t = b.dataset.theme;
      updateSettings({ theme: t });
      applyTheme(t);
      router.refresh();
    });
  });

  // Notifications wiring
  const notifEnabled = root.querySelector('#notif-enabled');
  if (notifEnabled) notifEnabled.addEventListener('change', () => {
    updateSettings({ notifEnabled: notifEnabled.checked });
    if (notifEnabled.checked) startNotifications();
  });
  const notifLead = root.querySelector('#notif-lead');
  if (notifLead) notifLead.addEventListener('change', () => updateSettings({ notifLeadMin: clamp(+notifLead.value, 1, 60) }));
  const notifStatus = root.querySelector('#notif-status');
  const updateNotifStatus = () => {
    if (!('Notification' in window)) { notifStatus.textContent = 'No soportado en este navegador'; return; }
    const map = { granted: '✓ Permiso concedido', denied: '✗ Permiso denegado', default: 'Sin permiso (tocá "Pedir permiso")' };
    notifStatus.textContent = map[Notification.permission] || Notification.permission;
  };
  updateNotifStatus();
  const notifBtn = root.querySelector('#notif-permission');
  if (notifBtn) notifBtn.addEventListener('click', async () => {
    const r = await requestNotifPermission();
    updateNotifStatus();
    if (r === 'granted') { toast('Notificaciones activadas', 'success'); startNotifications(); }
    else toast('Permiso: ' + r, 'info');
  });

  const ds = root.querySelector('#set-day-start');
  const de = root.querySelector('#set-day-end');
  const wg = root.querySelector('#set-week-goal');
  ds.addEventListener('change', () => updateSettings({ dayStartHour: clamp(+ds.value, 0, 23) }));
  de.addEventListener('change', () => updateSettings({ dayEndHour: clamp(+de.value, 1, 24) }));
  wg.addEventListener('change', () => updateSettings({ weeklyGoalHours: clamp(+wg.value, 1, 100) }));

  // ---- Personas (assignees CRUD) ----
  const renderAssignees = () => {
    const host = root.querySelector('#assignees-list');
    if (!host) return;
    const list = getAssignees();
    if (!list.length) {
      host.innerHTML = `<div class="muted text-sm">Sin personas configuradas.</div>`;
      return;
    }
    host.innerHTML = list.map(a => `
      <div class="row gap-6" data-aid="${escapeHtml(a.id)}" style="align-items:center;padding:6px 0;border-bottom:1px solid var(--border-soft)">
        <span class="assignee-chip" style="background:${escapeHtml(a.color)}">${escapeHtml(a.initials)}</span>
        <input type="text" class="input" data-a-name value="${escapeHtml(a.label)}" style="flex:1;min-width:120px">
        <input type="color" class="input" data-a-color value="${escapeHtml(a.color)}" style="width:46px;padding:2px;cursor:pointer">
        <button class="btn btn-danger btn-sm" data-a-rm>Quitar</button>
      </div>
    `).join('');
    host.querySelectorAll('[data-a-name]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = inp.closest('[data-aid]').dataset.aid;
        updateAssignee(id, { label: inp.value });
        renderAssignees();
      });
    });
    host.querySelectorAll('[data-a-color]').forEach(inp => {
      inp.addEventListener('change', () => {
        const id = inp.closest('[data-aid]').dataset.aid;
        updateAssignee(id, { color: inp.value });
        renderAssignees();
      });
    });
    host.querySelectorAll('[data-a-rm]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-aid]').dataset.aid;
        if (!confirm(`¿Quitar a ${id}? Las tareas asignadas a esta persona quedarán sin asignar.`)) return;
        removeAssignee(id);
        renderAssignees();
        toast(`${id} eliminado`, 'success');
      });
    });
  };
  renderAssignees();
  const aAdd = root.querySelector('#assignee-add');
  if (aAdd) aAdd.addEventListener('click', () => {
    const nameInp = root.querySelector('#assignee-name-new');
    const colorInp = root.querySelector('#assignee-color-new');
    const a = addAssignee({ label: nameInp.value, color: colorInp.value });
    if (!a) { toast('Nombre vacío o ya existe', 'info'); return; }
    nameInp.value = '';
    renderAssignees();
    toast(`${a.label} agregado`, 'success');
  });
  const aNameInp = root.querySelector('#assignee-name-new');
  if (aNameInp) aNameInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); aAdd.click(); }
  });

  for (const id of ['pom-focus','pom-short','pom-long','pom-every']) {
    const el = root.querySelector('#' + id);
    el.addEventListener('change', () => {
      const map = { 'pom-focus':'focus', 'pom-short':'shortBreak', 'pom-long':'longBreak', 'pom-every':'longEvery' };
      updatePomodoroSettings({ [map[id]]: clamp(+el.value, 1, 240) });
    });
  }

  const vc = root.querySelector('#vault-connect'); if (vc) vc.addEventListener('click', openVaultModal);
  const vch = root.querySelector('#vault-change'); if (vch) vch.addEventListener('click', openVaultModal);
  const vd = root.querySelector('#vault-disconnect');
  if (vd) vd.addEventListener('click', async () => {
    if (!confirm('¿Desconectar el vault?')) return;
    try { await api.disconnectVault(); setVault(null); toast('Vault desconectado'); router.refresh(); }
    catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  // Auto-import controls
  const autoTog = root.querySelector('#auto-import');
  if (autoTog) autoTog.addEventListener('change', () => updateSettings({ autoImportObsidian: autoTog.checked }));
  const autoRoot = root.querySelector('#auto-import-root');
  if (autoRoot) autoRoot.addEventListener('change', () => updateSettings({ autoImportRoot: autoRoot.value.trim() || 'Projects' }));
  const autoDepth = root.querySelector('#auto-import-depth');
  if (autoDepth) autoDepth.addEventListener('change', () => updateSettings({ autoImportDepth: parseInt(autoDepth.value, 10) }));

  const reimport = root.querySelector('#reimport-now');
  if (reimport) reimport.addEventListener('click', async () => {
    reimport.disabled = true;
    const old = reimport.textContent;
    reimport.textContent = 'Importando…';
    const res = await runObsidianAutoImport({ silent: false });
    reimport.disabled = false;
    reimport.textContent = old;
    if (res?.ok) {
      toast(`${res.projects ?? 0} nuevo(s) · ${res.tasks ?? 0} tarea(s)`, 'success');
      router.refresh();
    } else {
      toast('Error: ' + (res?.reason || 'desconocido'), 'error');
    }
  });

  const wiz = root.querySelector('#open-import-wizard');
  if (wiz) wiz.addEventListener('click', () => openImportModal());

  const cleanMd = root.querySelector('#clean-legacy-md');
  if (cleanMd) cleanMd.addEventListener('click', async () => {
    const linked = state.projects.filter(p => p.vaultFolder).map(p => p.vaultFolder);
    if (!linked.length) { toast('No hay proyectos vinculados', 'info'); return; }
    if (!confirm(`Borrar el archivo tasks.md de ${linked.length} carpeta(s) en tu vault. Las tareas en Tempo y los archivos en tasks/ NO se tocan. ¿Confirmar?`)) return;
    try {
      const r = await api.cleanLegacyTasks(linked, false);
      toast(`Borrados ${r.deletedMd} tasks.md`, 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  const wipeVault = root.querySelector('#wipe-vault-tasks');
  if (wipeVault) wipeVault.addEventListener('click', async () => {
    const linked = state.projects.filter(p => p.vaultFolder).map(p => p.vaultFolder);
    if (!linked.length) { toast('No hay proyectos vinculados', 'info'); return; }
    if (!confirm(`Vaciar las carpetas tasks/ de ${linked.length} proyecto(s) en tu vault. Borra TODOS los .md adentro (las tareas). El _index.md, notes/ y demás archivos NO se tocan. ¿Confirmar?`)) return;
    try {
      const r = await api.cleanLegacyTasks(linked, true);
      toast(`Vault: borrados ${r.deletedFiles} task .md`, 'success');
      toast(`Tocá ↻ refresh para sincronizar Tempo`, 'info');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  const unlink = root.querySelector('#unlink-all');
  if (unlink) unlink.addEventListener('click', () => {
    const linked = state.projects.filter(p => p.vaultFolder).length;
    if (!linked) { toast('No hay proyectos vinculados', 'info'); return; }
    if (!confirm(`Eliminar ${linked} proyecto(s) vinculado(s) a Obsidian (incluye sus tareas y bloques en Tempo). Los archivos del vault NO se tocan. ¿Confirmar?`)) return;
    const r = removeAllVaultLinkedProjects();
    toast(`Eliminados ${r.removed} proyecto(s)`, 'success');
    router.refresh();
  });

  root.querySelector('#data-export').addEventListener('click', async () => {
    try {
      const data = await api.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tempo-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Exportado', 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  // ---- Calendar wiring (multi-URL, atomic add/remove via server) ----
  const listEl = root.querySelector('#cal-urls-list');
  const newInput = root.querySelector('#cal-url-new');
  const addBtn = root.querySelector('#cal-url-add');
  const calStatus = root.querySelector('#cal-status');
  let urls = [];
  let isLoaded = false;
  // Block writes until we know the current server state — prevents accidental wipe.
  addBtn.disabled = true;
  newInput.disabled = true;

  const renderList = () => {
    if (!isLoaded) {
      listEl.innerHTML = `<div class="muted text-sm" style="padding:8px 0">Cargando…</div>`;
      return;
    }
    if (!urls.length) {
      listEl.innerHTML = `<div class="muted text-sm" style="padding:8px 0">Sin calendarios conectados.</div>`;
      return;
    }
    listEl.innerHTML = urls.map((u) => `
      <div class="row gap-6" style="align-items:center;padding:6px 0;border-bottom:1px solid var(--border-soft)">
        <span class="muted text-xs mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(u)}">${escapeHtml(u)}</span>
        <button class="btn btn-danger btn-sm" data-rm-url="${escapeHtml(u)}">Quitar</button>
      </div>
    `).join('');
    listEl.querySelectorAll('[data-rm-url]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('¿Quitar este calendario?')) return;
      try {
        const r = await api.removeCalendarUrl(b.dataset.rmUrl);
        urls = r.urls || [];
        invalidateCalendarCache();
        renderList();
        refreshStatus();
        toast('Calendario quitado', 'success');
      } catch (e) { toast('Error: ' + e.message, 'error'); }
    }));
  };

  const refreshStatus = async () => {
    if (!urls.length) { calStatus.textContent = 'Sin calendarios.'; return; }
    try {
      const from = new Date(); from.setHours(0,0,0,0);
      const to = new Date(from.getTime() + 7 * 86400000);
      const ev = await api.getCalendarEvents(from.toISOString(), to.toISOString());
      calStatus.textContent = `${urls.length} calendario(s) · ${ev.events.length} evento(s) en los próximos 7 días.`;
    } catch (e) { calStatus.textContent = 'Lectura falló: ' + e.message; }
  };

  // Load initial list, then unlock controls.
  api.getCalendarUrls().then(r => {
    urls = r.urls || [];
    isLoaded = true;
    addBtn.disabled = false;
    newInput.disabled = false;
    renderList();
    refreshStatus();
  }).catch((e) => {
    isLoaded = true;
    addBtn.disabled = false;
    newInput.disabled = false;
    listEl.innerHTML = `<div class="muted text-sm" style="color:var(--red);padding:8px 0">Error: ${escapeHtml(e.message)}</div>`;
  });

  addBtn.addEventListener('click', async () => {
    if (!isLoaded) return;
    const v = newInput.value.trim();
    if (!v) return;
    if (urls.includes(v)) { toast('Ya está en la lista', 'info'); return; }
    addBtn.disabled = true;
    try {
      const r = await api.addCalendarUrl(v);
      urls = r.urls || [];
      newInput.value = '';
      invalidateCalendarCache();
      renderList();
      refreshStatus();
      toast('Calendario agregado', 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
    finally { addBtn.disabled = false; }
  });
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !addBtn.disabled) addBtn.click();
  });

  const wipe = root.querySelector('#wipe-tasks');
  if (wipe) wipe.addEventListener('click', () => {
    const n = state.tasks.length;
    if (!n) { toast('No hay tareas para borrar', 'info'); return; }
    if (!confirm(`Borrar las ${n} tareas y vaciar tasks/ en Obsidian? Esto NO se puede deshacer.`)) return;
    const r = removeAllTasks({ alsoVault: true });
    toast(`Borradas ${r.removed} tareas`, 'success');
    router.refresh();
  });

  const fileInp = root.querySelector('#data-import-file');
  root.querySelector('#data-import').addEventListener('click', () => fileInp.click());
  fileInp.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!confirm('Importar este JSON? El estado actual se va a fusionar (no destructivo) y las notas se van a agregar.')) return;
    try {
      const text = await f.text();
      const parsed = JSON.parse(text);
      const res = await api.importAll(parsed);
      toast(`Importado · ${res.importedNotes ?? 0} notas`, 'success');
      // hard reload to pick up state
      setTimeout(() => location.reload(), 400);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, isNaN(n) ? lo : n));
