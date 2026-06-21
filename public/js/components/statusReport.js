// statusReport.js — generate a markdown status report for a project for the
// last 7/14/30 days. Outputs ready-to-paste content for Slack/email/vault.

import { state, findProject } from '../state.js';
import { api } from '../api.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { todayKey, addDays, minsBetween, minsToHrs, escapeHtml } from '../utils.js';

const PRIORITY_LABEL = { high: 'alta', med: 'media', low: 'baja' };

let currentProject = null;
let currentPeriod = 7;

const descendantIds = (rootId) => {
  const out = new Set([rootId]);
  const walk = (pid) => { for (const c of state.projects.filter(p => p.parentId === pid)) { out.add(c.id); walk(c.id); } };
  walk(rootId);
  return out;
};

const generate = (project, days) => {
  const ids = descendantIds(project.id);
  const tk = todayKey();
  const fromDate = addDays(new Date(), -(days - 1));
  fromDate.setHours(0,0,0,0);
  const fromKey = todayKey(fromDate);
  const toKey = tk;

  // Tasks done in window — uses activity log "task.state ... Hecho"
  const doneActs = (state.activity || [])
    .filter(a => a.type === 'task.state' && /Hecho/.test(a.text || '') && ids.has(a.projectId))
    .filter(a => {
      const k = todayKey(new Date(a.ts));
      return k >= fromKey && k <= toKey;
    });
  const doneIds = new Set();
  const done = [];
  for (const a of doneActs) {
    if (a.taskId && doneIds.has(a.taskId)) continue;
    if (a.taskId) doneIds.add(a.taskId);
    const t = a.taskId ? state.tasks.find(x => x.id === a.taskId) : null;
    done.push({ text: t?.text || (a.text || '').replace(/\*\*([^*]+)\*\*.*/, '$1'), task: t });
  }

  const inProgress = state.tasks.filter(t => ids.has(t.projectId) && t.state === 'doing');
  const next = state.tasks
    .filter(t => ids.has(t.projectId) && (t.state === 'todo' || t.state === 'inbox'))
    .sort((a, b) => {
      const pri = { high: 0, med: 1, low: 2 };
      return (pri[a.priority] || 1) - (pri[b.priority] || 1);
    })
    .slice(0, 5);

  const overdue = state.tasks.filter(t =>
    ids.has(t.projectId) && t.state !== 'done' && t.due && t.due < tk);

  const followUps = state.tasks.filter(t =>
    ids.has(t.projectId) && t.state !== 'done' && t.followUpAt && t.followUpAt <= tk);

  const blocks = state.blocks.filter(b => ids.has(b.projectId) && b.date >= fromKey && b.date <= toKey);
  const totalMins = blocks.reduce((s, b) => s + minsBetween(b.start, b.end), 0);

  const pomos = (state.pomodoroLog || []).filter(p => ids.has(p.projectId) && p.completedAt >= fromDate.getTime() && p.type !== 'break');

  const recentActs = (state.activity || [])
    .filter(a => ids.has(a.projectId) && a.ts >= fromDate.getTime())
    .slice(0, 8);

  // Build markdown
  const L = [];
  L.push(`# Status · ${project.name}`);
  L.push(`> Período: ${fromKey} → ${toKey} · generado por Tempo · ${new Date().toISOString()}\n`);

  L.push(`## TL;DR`);
  L.push(`- ${done.length} tarea(s) terminadas`);
  L.push(`- ${inProgress.length} en curso, ${next.length} en cola`);
  L.push(`- ${minsToHrs(totalMins) || '0'} trackeadas${pomos.length ? ' · ' + pomos.length + ' 🍅' : ''}`);
  if (overdue.length) L.push(`- ⚠ ${overdue.length} tarea(s) vencida(s)`);
  if (followUps.length) L.push(`- ⏰ ${followUps.length} seguimiento(s) pendiente(s)`);
  L.push('');

  L.push(`## Hecho`);
  if (done.length) for (const d of done) L.push(`- ✅ ${d.text}`);
  else L.push('_(nada terminado en el período)_');
  L.push('');

  L.push(`## En curso`);
  if (inProgress.length) for (const t of inProgress) L.push(`- 🔄 ${t.text}`);
  else L.push('_(nada en curso)_');
  L.push('');

  L.push(`## Próximos pasos`);
  if (next.length) for (const t of next) {
    const tags = [];
    if (t.priority && t.priority !== 'med') tags.push(`#${PRIORITY_LABEL[t.priority] || t.priority}`);
    if (t.due) tags.push(`@${t.due}`);
    L.push(`- ${t.text}${tags.length ? ' ' + tags.join(' ') : ''}`);
  } else L.push('_(sin próximos pasos en cola)_');
  L.push('');

  if (overdue.length) {
    L.push(`## Atrasadas`);
    for (const t of overdue.slice(0, 8)) L.push(`- ⚠ ${t.text} (vencía ${t.due})`);
    L.push('');
  }
  if (followUps.length) {
    L.push(`## Follow-ups pendientes`);
    for (const t of followUps.slice(0, 8)) L.push(`- ⏰ ${t.text} (${t.followUpAt})`);
    L.push('');
  }

  L.push(`## Tiempo y métricas`);
  L.push(`- Total trackeado: **${minsToHrs(totalMins) || '0'}**`);
  L.push(`- Pomodoros: ${pomos.length}`);
  L.push(`- Bloques: ${blocks.length}`);
  L.push('');

  if (recentActs.length) {
    L.push(`## Actividad reciente`);
    for (const a of recentActs) {
      const d = new Date(a.ts);
      const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      L.push(`- ${stamp}: ${(a.text || '').replace(/\n/g, ' ')}`);
    }
  }

  return L.join('\n');
};

const renderBody = () => {
  const body = document.getElementById('review-modal-body');
  document.getElementById('review-modal-title').textContent = `Status report · ${currentProject.name}`;

  const md = generate(currentProject, currentPeriod);

  body.innerHTML = `
    <div class="row gap-6" style="margin-bottom:10px;flex-wrap:wrap;align-items:center">
      <span class="muted text-xs">Período:</span>
      <div class="board-filter-group" id="sr-period">
        <button class="board-filter ${currentPeriod === 7 ? 'active' : ''}" data-d="7">7 días</button>
        <button class="board-filter ${currentPeriod === 14 ? 'active' : ''}" data-d="14">14 días</button>
        <button class="board-filter ${currentPeriod === 30 ? 'active' : ''}" data-d="30">30 días</button>
      </div>
      <button class="btn btn-secondary btn-sm" id="sr-copy" style="margin-left:auto">📋 Copiar</button>
      ${state.vault?.path && currentProject.vaultFolder ? '<button class="btn btn-secondary btn-sm" id="sr-save">💾 Guardar a vault</button>' : ''}
    </div>
    <textarea class="textarea mono" id="sr-text" style="min-height:380px;font-size:12px;line-height:1.45">${escapeHtml(md)}</textarea>
  `;

  body.querySelectorAll('#sr-period [data-d]').forEach(b => b.addEventListener('click', () => {
    currentPeriod = parseInt(b.dataset.d, 10);
    renderBody();
  }));

  document.getElementById('sr-copy').addEventListener('click', async () => {
    const text = document.getElementById('sr-text').value;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copiado al portapapeles', 'success');
    } catch { toast('No pude copiar (permiso del browser)', 'error'); }
  });

  const saveBtn = document.getElementById('sr-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const text = document.getElementById('sr-text').value;
    const filename = `status-${todayKey()}.md`;
    const filePath = `${currentProject.vaultFolder}/${filename}`;
    try {
      await api.saveVaultFile(filePath, text);
      toast(`Guardado en ${filePath}`, 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });
};

export const openStatusReport = (projectId) => {
  const p = findProject(projectId);
  if (!p) return;
  currentProject = p;
  currentPeriod = 7;
  // Reuse the review modal shell; just save button is unused here.
  document.getElementById('review-save').style.display = 'none';
  renderBody();
  openModal('modal-review');
  // Restore save button when the modal closes
  const obs = new MutationObserver(() => {
    if (!document.getElementById('modal-review').classList.contains('open')) {
      document.getElementById('review-save').style.display = '';
      obs.disconnect();
    }
  });
  obs.observe(document.getElementById('modal-review'), { attributes: true, attributeFilter: ['class'] });
};
