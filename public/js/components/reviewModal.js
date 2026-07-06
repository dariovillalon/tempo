// reviewModal.js — cierre semanal. openReviewModal('week') es EL review de
// Tempo: junta métricas de la semana, preguntas de reflexión y el status
// markdown por cliente (proyecto raíz), y lo guarda en state.reviews — la
// fuente de verdad. El vault es best-effort DESPUÉS del save: si no está
// disponible (deploy en la nube) o falla, el cierre igual queda guardado.
// Un argumento 'day' cae a 'week' (el cierre diario se unificó en el semanal);
// la firma openReviewModal(mode) no cambia.

import { state, findProject, mutate, addActivity, isVaultAvailable } from '../state.js';
import { api } from '../api.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { uid, todayKey, startOfWeek, addDays, minsBetween, minsToHrs, escapeHtml } from '../utils.js';
import { generateStatusMarkdown } from './statusReport.js';

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

const doneText = (d) =>
  d.task?.text || (d.activity.text || '').replace(/\*\*([^*]+)\*\*.*/, '$1');

const computeContext = () => {
  const now = new Date();
  // Ventana anclada a la semana que se cierra (lunes → hoy), coherente con
  // weekOf. Cerrar un lunes significa cerrar la semana PASADA completa (si no,
  // el cierre del lunes archivaría los datos de la semana vieja bajo la nueva).
  const anchor = now.getDay() === 1 ? addDays(now, -1) : now;
  const weekStart = startOfWeek(anchor);
  const from = new Date(weekStart); from.setHours(0, 0, 0, 0);
  const weekEnd = addDays(weekStart, 6); weekEnd.setHours(23, 59, 59, 999);
  const to = now < weekEnd ? new Date(now) : new Date(weekEnd);
  to.setHours(23, 59, 59, 999);
  const weekOf = todayKey(weekStart);
  const label = `${todayKey(from)} → ${todayKey(to)}`;
  const fileName = `DailyNotes/Week-${weekOf}.md`;
  const headerTitle = `Cierre de semana · ${label}`;

  const done = tasksDoneInRange(from, to);
  const blocks = blocksInRange(from, to);
  const pomos = pomosInRange(from, to);
  const totalMins = blocks.reduce((s, b) => s + minsBetween(b.start, b.end), 0);

  // minutos por proyecto
  const byProj = {};
  for (const b of blocks) {
    if (!b.projectId) continue;
    byProj[b.projectId] = (byProj[b.projectId] || 0) + minsBetween(b.start, b.end);
  }

  // Status por cliente = un markdown por proyecto raíz activo
  const roots = (state.projects || []).filter(p => !p.parentId && p.status !== 'archived');
  const statusByProject = roots.map(p => ({
    id: p.id, name: p.name, md: generateStatusMarkdown(p, 7),
  }));

  return { from, to, weekOf, label, fileName, headerTitle, done, blocks, pomos, totalMins, byProj, statusByProject };
};

const renderBody = () => {
  const ctx = computeContext();
  prefill = ctx;
  const body = document.getElementById('review-modal-body');
  document.getElementById('review-modal-title').textContent = ctx.headerTitle;

  const existing = (state.reviews || []).find(r => r.weekOf === ctx.weekOf);

  const projectBreakdown = Object.entries(ctx.byProj)
    .sort((a, b) => b[1] - a[1])
    .map(([pid, mins]) => `<li><strong>${escapeHtml(projectName(pid))}</strong> — ${minsToHrs(mins)}</li>`)
    .join('') || '<li class="muted">Sin tiempo trackeado.</li>';

  const doneList = ctx.done.length
    ? ctx.done.map(d => `
        <li>
          ${escapeHtml(doneText(d))}
          ${d.task?.projectId ? ` · <span class="muted">${escapeHtml(projectName(d.task.projectId))}</span>` : ''}
        </li>`).join('')
    : '<li class="muted">Nada terminado en este período.</li>';

  const statusSection = ctx.statusByProject.length ? `
    <div style="margin-top:14px">
      <div class="review-label" style="margin-bottom:6px">Status por cliente</div>
      <div class="muted text-xs" style="margin-bottom:8px">Markdown listo para pegar en Slack/mail. Se guarda con el cierre.</div>
      ${ctx.statusByProject.map((sp, i) => `
        <details style="margin-bottom:8px">
          <summary style="cursor:pointer;padding:6px 0">${escapeHtml(sp.name)}</summary>
          <textarea class="textarea mono" id="rv-sr-md-${i}" readonly
            style="width:100%;min-height:160px;font-size:11.5px;line-height:1.45;margin-top:4px">${escapeHtml(sp.md)}</textarea>
          <button class="btn btn-secondary btn-sm" data-sr-copy="${i}" style="margin-top:6px">📋 Copiar</button>
        </details>
      `).join('')}
    </div>` : '';

  body.innerHTML = `
    ${existing ? `<div class="muted text-xs" style="margin-bottom:8px">✓ Esta semana ya tiene un cierre — guardar lo actualiza.</div>` : ''}
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

    <div class="field">
      <label>Lo que funcionó</label>
      <textarea class="textarea" id="rv-good" placeholder="¿Qué salió bien esta semana?" style="min-height:60px">${escapeHtml(existing?.answers?.good || '')}</textarea>
    </div>
    <div class="field">
      <label>Lo que no funcionó</label>
      <textarea class="textarea" id="rv-bad" placeholder="¿Qué rebotó? ¿Bloqueos crónicos?" style="min-height:60px">${escapeHtml(existing?.answers?.bad || '')}</textarea>
    </div>
    <div class="field">
      <label>Plan próxima semana</label>
      <textarea class="textarea" id="rv-plan" placeholder="Top 3-5 prioridades para la semana que viene" style="min-height:80px">${escapeHtml(existing?.answers?.plan || '')}</textarea>
    </div>

    ${statusSection}

    ${isVaultAvailable() && state.vault?.path
      ? `<div class="muted text-xs" style="margin-top:10px">Se guarda en Tempo y, de yapa, en <code>${escapeHtml(ctx.fileName)}</code> de tu vault.</div>`
      : `<div class="muted text-xs" style="margin-top:10px">Se guarda en Tempo. El vault vive en tu Mac — se sincroniza cuando entrés desde ahí.</div>`}
  `;

  body.querySelectorAll('[data-sr-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const i = btn.dataset.srCopy;
      const ta = document.getElementById(`rv-sr-md-${i}`);
      if (!ta) return;
      try {
        await navigator.clipboard.writeText(ta.value);
        toast('Copiado al portapapeles', 'success');
      } catch { toast('No pude copiar (permiso del browser)', 'error'); }
    });
  });
};

const composeMarkdown = (ctx, answers) => {
  const lines = [];
  lines.push(`# ${ctx.headerTitle}\n`);
  lines.push(`> Generado por Tempo · ${new Date().toISOString()}\n`);

  lines.push('## Hecho\n');
  if (ctx.done.length) {
    for (const d of ctx.done) {
      const proj = d.task?.projectId ? ` _(${projectName(d.task.projectId)})_` : '';
      lines.push(`- ${doneText(d)}${proj}`);
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

  if (answers.good) { lines.push('## Lo que funcionó\n'); lines.push(answers.good, ''); }
  if (answers.bad) { lines.push('## Lo que no funcionó\n'); lines.push(answers.bad, ''); }
  if (answers.plan) { lines.push('## Plan próxima semana\n'); lines.push(answers.plan, ''); }

  if (ctx.statusByProject.length) {
    lines.push('---\n');
    lines.push('# Status por cliente\n');
    for (const sp of ctx.statusByProject) {
      lines.push(sp.md, '', '---', '');
    }
  }

  return lines.join('\n');
};

// Contrato compartido: la firma openReviewModal(mode) NO cambia. 'day' cae a
// 'week' — los botones de Hoy y Dashboard apuntan los dos al cierre semanal.
export const openReviewModal = (m = 'week') => {
  renderBody();
  openModal('modal-review');
};

export const initReviewModal = () => {
  document.getElementById('review-save').addEventListener('click', async () => {
    const ctx = prefill;
    if (!ctx) return;
    const answers = {
      good: document.getElementById('rv-good')?.value || '',
      bad: document.getElementById('rv-bad')?.value || '',
      plan: document.getElementById('rv-plan')?.value || '',
    };

    const statusMarkdown = ctx.statusByProject.map(sp => sp.md).join('\n\n---\n\n');
    const review = {
      id: uid(),
      weekOf: ctx.weekOf,
      done: ctx.done.map(d => ({
        taskId: d.task?.id || d.activity.taskId || null,
        text: doneText(d),
        project: d.task?.projectId ? projectName(d.task.projectId) : null,
      })),
      // horas decimales por proyecto (nombre → horas), redondeadas a 0.1
      hoursByProject: Object.fromEntries(Object.entries(ctx.byProj)
        .map(([pid, mins]) => [projectName(pid), Math.round((mins / 60) * 10) / 10])),
      totalMins: ctx.totalMins,
      answers,
      statusMarkdown,
      createdAt: Date.now(),
    };

    // 1) Guardar en el ESTADO — la fuente de verdad. Upsert por weekOf: cerrar
    //    dos veces la misma semana actualiza el cierre en vez de duplicarlo.
    mutate(s => {
      if (!Array.isArray(s.reviews)) s.reviews = [];
      const i = s.reviews.findIndex(r => r.weekOf === review.weekOf);
      if (i >= 0) review.id = s.reviews[i].id || review.id;
      if (i >= 0) s.reviews[i] = review;
      else s.reviews.push(review);
      addActivity({ type: 'review.week', text: `📝 ${ctx.headerTitle}` });
    });

    toast('Semana cerrada', 'success');
    closeModal('modal-review');

    // 2) Vault: best-effort, DESPUÉS del save y solo si está disponible.
    //    Un fallo acá nunca bloquea el cierre (antes abortaba todo — ese era
    //    el bug que hacía imposible cerrar la semana desde el teléfono).
    if (isVaultAvailable() && state.vault?.path) {
      const md = composeMarkdown(ctx, answers);
      api.saveVaultFile(ctx.fileName, md).catch((e) => {
        console.warn('[review] escritura al vault falló (best-effort)', e);
        toast('Cierre guardado en Tempo; el vault no respondió', 'info');
      });
    }
  });
};
