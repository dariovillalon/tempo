// reviewModal.js — daily and weekly review (cierre del día/semana).
// Auto-fills metrics from state, lets you reflect, then writes a markdown
// journal entry to the vault under DailyNotes/ (and an activity log entry).

import { state, findProject, mutate, addActivity } from '../state.js';
import { api } from '../api.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { todayKey, addDays, fmtDate, dayName, minsBetween, minsToHrs, escapeHtml } from '../utils.js';

let mode = 'day';   // 'day' | 'week'
let prefill = null;

// Tasks transitioned to "done" within [from, to] (uses activity log "task.state ... Hecho").
const tasksDoneInRange = (from, to) => {
  const acts = (state.activity || []).filter(a =>
    a.type === 'task.state' && /Hecho/.test(a.text || '') &&
    a.ts >= from.getTime() && a.ts <= to.getTime());
  // collapse to unique taskIds (latest wins)
  const seen = new Set();
  const out = [];
  for (const a of acts) {
    if (a.taskId && !seen.has(a.taskId)) {
      seen.add(a.taskId);
      const t = state.tasks.find(x => x.id === a.taskId);
      out.push({ activity: a, task: t });
    }
  }
  return out;
};

const blocksInRange = (from, to) => {
  const fromKey = todayKey(from);
  const toKey = todayKey(to);
  return state.blocks.filter(b => b.date >= fromKey && b.date <= toKey);
};

const pomosInRange = (from, to) => {
  return (state.pomodoroLog || []).filter(p =>
    p.completedAt >= from.getTime() && p.completedAt <= to.getTime() && p.type !== 'break');
};

const projectName = (id) => findProject(id)?.name || '(sin proyecto)';

const computeContext = (m) => {
  const now = new Date();
  let from, to, label, fileName, headerTitle;
  if (m === 'day') {
    from = new Date(now); from.setHours(0,0,0,0);
    to = new Date(now); to.setHours(23,59,59,999);
    label = fmtDate(now, { weekday: true, year: true });
    const k = todayKey(now);
    fileName = `DailyNotes/${k}.md`;
    headerTitle = `Cierre del día · ${label}`;
  } else {
    // last 7 days
    from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0,0,0,0);
    to = new Date(now); to.setHours(23,59,59,999);
    const fromStr = `${from.getFullYear()}-${String(from.getMonth()+1).padStart(2,'0')}-${String(from.getDate()).padStart(2,'0')}`;
    const toStr = todayKey(now);
    label = `${fromStr} → ${toStr}`;
    fileName = `DailyNotes/Week-${toStr}.md`;
    headerTitle = `Cierre de semana · ${label}`;
  }

  const done = tasksDoneInRange(from, to);
  const blocks = blocksInRange(from, to);
  const pomos = pomosInRange(from, to);
  const totalMins = blocks.reduce((s, b) => s + minsBetween(b.start, b.end), 0);

  // hours per project
  const byProj = {};
  for (const b of blocks) {
    if (!b.projectId) continue;
    byProj[b.projectId] = (byProj[b.projectId] || 0) + minsBetween(b.start, b.end);
  }

  return { from, to, label, fileName, headerTitle, done, blocks, pomos, totalMins, byProj };
};

const renderBody = () => {
  const ctx = computeContext(mode);
  prefill = ctx;
  const body = document.getElementById('review-modal-body');
  document.getElementById('review-modal-title').textContent = ctx.headerTitle;

  const projectBreakdown = Object.entries(ctx.byProj)
    .sort((a, b) => b[1] - a[1])
    .map(([pid, mins]) => `<li><strong>${escapeHtml(projectName(pid))}</strong> — ${minsToHrs(mins)}</li>`)
    .join('') || '<li class="muted">Sin tiempo trackeado.</li>';

  const doneList = ctx.done.length
    ? ctx.done.map(d => `
        <li>
          ${escapeHtml(d.task?.text || (d.activity.text || '').replace(/\*\*([^*]+)\*\*.*/, '$1'))}
          ${d.task?.projectId ? ` · <span class="muted">${escapeHtml(projectName(d.task.projectId))}</span>` : ''}
        </li>`).join('')
    : '<li class="muted">Nada terminado en este período.</li>';

  body.innerHTML = `
    <div class="review-summary">
      <div class="review-section">
        <div class="review-label">Hecho</div>
        <ul class="review-list">${doneList}</ul>
      </div>
      <div class="review-section">
        <div class="review-label">Tiempo · ${minsToHrs(ctx.totalMins) || '0'}${ctx.pomos.length ? ' · ' + ctx.pomos.length + ' 🍅' : ''}</div>
        <ul class="review-list">${projectBreakdown}</ul>
      </div>
    </div>

    ${mode === 'day' ? `
      <div class="field">
        <label>¿Qué hiciste? (libre)</label>
        <textarea class="textarea" id="rv-did" placeholder="Resumí en 1-3 líneas lo más importante" style="min-height:64px"></textarea>
      </div>
      <div class="field">
        <label>Bloqueos / pendientes</label>
        <textarea class="textarea" id="rv-blockers" placeholder="¿Qué quedó trabado? ¿Qué espera respuesta?" style="min-height:64px"></textarea>
      </div>
      <div class="field">
        <label>Plan mañana (top 3)</label>
        <textarea class="textarea" id="rv-plan" placeholder="1. ...\n2. ...\n3. ..." style="min-height:80px"></textarea>
      </div>
    ` : `
      <div class="field">
        <label>Lo que funcionó</label>
        <textarea class="textarea" id="rv-good" placeholder="¿Qué salió bien esta semana?" style="min-height:60px"></textarea>
      </div>
      <div class="field">
        <label>Lo que no funcionó</label>
        <textarea class="textarea" id="rv-bad" placeholder="¿Qué rebotó? ¿Bloqueos crónicos?" style="min-height:60px"></textarea>
      </div>
      <div class="field">
        <label>Plan próxima semana</label>
        <textarea class="textarea" id="rv-plan" placeholder="Top 3-5 prioridades para la semana que viene" style="min-height:80px"></textarea>
      </div>
    `}

    ${state.vault?.path
      ? `<div class="muted text-xs" style="margin-top:6px">Se guarda en <code>${escapeHtml(ctx.fileName)}</code> de tu vault.</div>`
      : `<div class="muted text-xs" style="margin-top:6px">Sin vault — se va a guardar solo en el log de Tempo.</div>`}
  `;
};

const composeMarkdown = (ctx, fields) => {
  const lines = [];
  lines.push(`# ${ctx.headerTitle}\n`);
  lines.push(`> Generado por Tempo · ${new Date().toISOString()}\n`);

  lines.push('## Hecho\n');
  if (ctx.done.length) {
    for (const d of ctx.done) {
      const text = d.task?.text || (d.activity.text || '').replace(/\*\*([^*]+)\*\*.*/, '$1');
      const proj = d.task?.projectId ? ` _(${projectName(d.task.projectId)})_` : '';
      lines.push(`- ${text}${proj}`);
    }
  } else {
    lines.push('_(nada terminado)_');
  }
  lines.push('');

  const totalH = minsToHrs(ctx.totalMins) || '0';
  lines.push(`## Tiempo · ${totalH}${ctx.pomos.length ? ' · ' + ctx.pomos.length + ' 🍅' : ''}\n`);
  const sortedProj = Object.entries(ctx.byProj).sort((a, b) => b[1] - a[1]);
  if (sortedProj.length) {
    for (const [pid, mins] of sortedProj) {
      lines.push(`- **${projectName(pid)}** — ${minsToHrs(mins)}`);
    }
  } else {
    lines.push('_(sin tiempo trackeado)_');
  }
  lines.push('');

  if (mode === 'day') {
    if (fields.did) { lines.push('## Resumen\n'); lines.push(fields.did, ''); }
    if (fields.blockers) { lines.push('## Bloqueos / pendientes\n'); lines.push(fields.blockers, ''); }
    if (fields.plan) { lines.push('## Plan mañana\n'); lines.push(fields.plan, ''); }
  } else {
    if (fields.good) { lines.push('## Lo que funcionó\n'); lines.push(fields.good, ''); }
    if (fields.bad) { lines.push('## Lo que no funcionó\n'); lines.push(fields.bad, ''); }
    if (fields.plan) { lines.push('## Plan próxima semana\n'); lines.push(fields.plan, ''); }
  }

  return lines.join('\n');
};

export const openReviewModal = (m = 'day') => {
  mode = m;
  renderBody();
  openModal('modal-review');
};

export const initReviewModal = () => {
  document.getElementById('review-save').addEventListener('click', async () => {
    const ctx = prefill;
    const fields = mode === 'day' ? {
      did: document.getElementById('rv-did')?.value || '',
      blockers: document.getElementById('rv-blockers')?.value || '',
      plan: document.getElementById('rv-plan')?.value || '',
    } : {
      good: document.getElementById('rv-good')?.value || '',
      bad: document.getElementById('rv-bad')?.value || '',
      plan: document.getElementById('rv-plan')?.value || '',
    };

    const md = composeMarkdown(ctx, fields);

    // Save to vault if connected
    if (state.vault?.path) {
      try {
        await api.saveVaultFile(ctx.fileName, md);
      } catch (e) {
        toast('Error guardando en vault: ' + e.message, 'error');
        return;
      }
    }

    // Log activity (mutate w/o triggering a vault sync)
    mutate(s => {
      addActivity({
        type: mode === 'day' ? 'review.day' : 'review.week',
        text: `📝 ${ctx.headerTitle}`,
      });
    });

    toast(`${mode === 'day' ? 'Día' : 'Semana'} cerrada`, 'success');
    closeModal('modal-review');
  });
};
