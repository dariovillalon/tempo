// flights.js — Vuelos: ofertas validadas, rutas que sigo y alertas por mail
//
// Los precios los valida una tarea diaria de Claude en la Mac (Chrome, hasta
// la página de pago del vendedor) y los sube con vuelos-tempo.mjs a
// POST /api/flights/report. Esta vista solo muestra y edita: seguimientos,
// umbral de alerta y mail. Ver VUELOS-ALERTAS.md.

import { api } from '../api.js';
import { escapeHtml, sanitizeUrl, relTime } from '../utils.js';
import { toast } from '../components/toast.js';

const STALE_MS = 72 * 3600 * 1000;      // un precio de hace más de 3 días ya no es confiable
const REFETCH_MS = 60 * 1000;
const ORIGINS = [
  ['BUE', 'Buenos Aires (EZE + AEP)'], ['EZE', 'Ezeiza'], ['AEP', 'Aeroparque'],
  ['COR', 'Córdoba'], ['ROS', 'Rosario'], ['MDZ', 'Mendoza'],
];
const REGIONS = [['caribe', 'Caribe / México'], ['eeuu', 'Estados Unidos'], ['europa', 'Europa'], ['brasil', 'Brasil'], ['otro', 'Otro']];
const FILTERS = [['todas', 'Todas'], ['great', 'Muy buenas'], ['playa', 'Con playa'], ['cor', 'Desde Córdoba'], ['multi', 'Multidestino']];

let cache = null;          // respuesta de GET /api/flights
let loadedAt = 0;
let loading = null;
let loadError = null;
let gen = 0;               // sube al entrar o salir de la vista: un fetch viejo no pinta encima de otra
let filter = 'todas';
let editing = null;        // id del seguimiento en edición, '__new' o null

try { filter = localStorage.getItem('tempo-vuelos-filtro') || 'todas'; } catch { /* sin storage */ }

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtDay = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const fmtRange = (a, b) => {
  if (!a) return '';
  if (!b) return fmtDay(a);
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  if (ya === yb && ma === mb) return `${da}–${db} ${MONTHS[mb - 1]} ${yb}`;
  if (ya === yb) return `${da} ${MONTHS[ma - 1]} – ${db} ${MONTHS[mb - 1]} ${yb}`;
  return `${fmtDay(a)} – ${fmtDay(b)}`;
};
const fmtNum = (n) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const fmtUsd = (n, approx) => `${approx ? '≈ ' : ''}USD ${fmtNum(n)}`;
const fmtArs = (n) => 'ARS ' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const pctBelow = (d) => (d.normal ? Math.round((1 - d.priceUsd / d.normal.lo) * 100) : null);
// hasOwn: un id raro (ej. "__proto__") no puede devolver algo del prototipo
const historyFor = (id) => {
  if (!id || !cache?.history || !Object.hasOwn(cache.history, id)) return null;
  return Array.isArray(cache.history[id]) ? cache.history[id] : null;
};

const load = async ({ force = false } = {}) => {
  if (loading) return loading;
  if (!force && cache && Date.now() - loadedAt < REFETCH_MS) return cache;
  loading = api.getFlights()
    .then(r => { cache = r; loadedAt = Date.now(); loadError = null; return r; })
    .catch(e => { loadError = e; toast('No pude cargar Vuelos: ' + e.message, 'error'); return cache; })
    .finally(() => { loading = null; });
  return loading;
};

export const renderFlights = (root) => {
  const g = ++gen;
  window._viewCleanup = () => { gen++; };
  const pending = load(); // primero, así paint ve `loading` y no un error viejo
  paint(root);
  pending.then(() => { if (g === gen) paint(root); });
};

// Un repintado (volver a la pestaña, otra mutación, un filtro) no tiene que
// borrar lo que Dario está tipeando: se guardan los campos tocados y se reponen.
const snapshotDirty = (root) => {
  const saved = [];
  root.querySelectorAll('.fl-form [id], .fl-settings [id]').forEach(el => {
    if (el.tagName === 'SELECT') {
      const def = [...el.options].find(o => o.defaultSelected)?.value;
      if (el.value !== def) saved.push([el.id, 'value', el.value]);
    } else if (el.type === 'checkbox') {
      if (el.checked !== el.defaultChecked) saved.push([el.id, 'checked', el.checked]);
    } else if ('value' in el && el.value !== el.defaultValue) {
      saved.push([el.id, 'value', el.value]);
    }
  });
  const active = root.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : null;
  return { saved, active };
};
const restoreDirty = (root, snap) => {
  for (const [id, prop, v] of snap.saved) {
    const el = root.querySelector('#' + CSS.escape(id));
    if (el) el[prop] = v;
  }
  if (snap.active) root.querySelector('#' + CSS.escape(snap.active))?.focus();
};

// ---------- pintado ----------

const paint = (root) => {
  if (!cache) {
    root.innerHTML = `<div class="view-h"><h2>Vuelos</h2></div>` + (loadError && !loading
      ? `<div class="fl-note fl-note-warn">No pude cargar Vuelos: ${escapeHtml(loadError.message)}</div>
         <button class="btn btn-secondary btn-sm" data-act="reload" type="button">Reintentar</button>`
      : `<div class="fl-empty">Cargando…</div>`);
    wire(root);
    return;
  }
  const dirty = snapshotDirty(root);
  const { settings, watches, deals, runs } = cache;
  const lastRun = runs[0];
  const active = watches.filter(w => w.active);
  const shown = deals.filter(passesFilter);
  const groups = [
    ['great', 'Muy buenas', 'Validadas y bastante debajo del rango normal. Por estas te llega mail y push.', d => d.great],
    ['bajo', 'Debajo de lo normal', null, d => !d.great && d.kind !== 'multi' && d.verdict === 'bajo'],
    ['multi', 'Multidestino', 'Dos o más destinos en un mismo viaje.', d => !d.great && d.kind === 'multi'],
    ['normal', 'Precio normal o alto', 'Baratos en absoluto, pero en el rango que Google considera normal para esas fechas.', d => !d.great && d.kind !== 'multi' && d.verdict !== 'bajo'],
  ];
  const activeIds = new Set(watches.filter(w => w.active).map(w => w.id));
  const best = deals.filter(d => d.validated && d.normal && d.priceUsd < d.normal.lo
      && Date.now() - d.validatedAt <= STALE_MS && (!d.watchId || activeIds.has(d.watchId)))
    .sort((a, b) => (pctBelow(b) ?? 0) - (pctBelow(a) ?? 0))[0];

  root.innerHTML = `
    <div class="view-h">
      <div>
        <h2 style="margin-bottom:2px">Vuelos</h2>
        <div class="fl-sub">Precios validados en la página de pago · 1 adulto${lastRun ? ` · último chequeo hace ${relTime(lastRun.ts)}` : ''}</div>
      </div>
      <div class="view-h-actions">
        <button class="btn btn-secondary btn-sm" data-act="reload" type="button">Actualizar</button>
        <button class="btn btn-primary btn-sm" data-act="new-watch" type="button">+ Seguir ruta</button>
      </div>
    </div>

    ${!lastRun ? `<div class="fl-note">Todavía no corrió el chequeo diario. Corre en la Mac todos los días a las 9:00 con Chrome y sube lo que valida acá.</div>` : ''}
    ${settings.paused ? `<div class="fl-note fl-note-warn">Avisos pausados: se siguen chequeando precios, pero no te llega mail ni push.</div>` : ''}
    ${!cache.mailConfigured ? `<div class="fl-note fl-note-warn">El mail no está configurado en este server (faltan SMTP_USER y SMTP_PASS). Las ofertas se guardan igual.</div>` : ''}

    <div class="fl-kpis">
      <div class="fl-kpi"><span>Mejor oferta</span><strong>${best ? `${escapeHtml(best.destName || best.dest || '')} ${fmtUsd(best.priceUsd, best.approx)}` : '—'}</strong>${best ? `<em>${pctBelow(best)}% debajo del piso normal</em>` : '<em>Nada debajo de lo normal por ahora</em>'}</div>
      <div class="fl-kpi"><span>Rutas que sigo</span><strong>${active.length}</strong><em>${watches.filter(w => w.active && w.due).length} tocan en el próximo chequeo</em></div>
      <div class="fl-kpi"><span>Te aviso si baja</span><strong>${settings.alertPct}%</strong><em>debajo del piso del rango normal</em></div>
      <div class="fl-kpi"><span>Mails enviados</span><strong>${cache.stats?.mailsSent ?? cache.log.filter(l => l.ok).length}</strong><em>${escapeHtml(settings.email)}</em></div>
    </div>

    <div class="fl-filters" role="group" aria-label="Filtrar ofertas">
      ${FILTERS.map(([k, label]) => `<button type="button" class="fl-chip${filter === k ? ' on' : ''}" data-act="filter" data-f="${k}" aria-pressed="${filter === k}">${label}</button>`).join('')}
    </div>

    ${deals.length === 0 ? `<div class="fl-empty">Todavía no hay ofertas validadas. Aparecen después del primer chequeo.</div>` : ''}
    ${deals.length > 0 && shown.length === 0 ? `<div class="fl-empty">Ninguna oferta cumple el filtro.</div>` : ''}
    ${groups.map(([key, title, note, test]) => {
      const list = shown.filter(test);
      if (!list.length) return '';
      return `<section class="fl-group fl-group-${key}">
        <h3>${title} <span class="muted">(${list.length})</span></h3>
        ${note ? `<p class="fl-group-note">${note}</p>` : ''}
        <div class="fl-list">${list.map(renderDeal).join('')}</div>
      </section>`;
    }).join('')}

    <section class="fl-card" id="fl-watches">
      <div class="fl-card-h"><span>Rutas que sigo</span><span class="muted text-xs">cada una se revalida cada N días</span></div>
      ${editing === '__new' ? renderWatchForm(null) : ''}
      <div class="fl-watches">${watches.map(w => editing === w.id ? renderWatchForm(w) : renderWatch(w)).join('') || '<div class="fl-empty">No seguís ninguna ruta.</div>'}</div>
    </section>

    <div class="fl-grid2">
      <section class="fl-card">
        <div class="fl-card-h"><span>Alertas por mail</span></div>
        <form class="fl-settings" data-form="settings">
          <label>Mail<input class="input" id="fl-email" type="email" value="${escapeHtml(settings.email)}" required></label>
          <label>Avisar si el precio queda
            <span class="fl-inline"><input class="input" id="fl-pct" type="number" min="0" max="80" step="1" required value="${settings.alertPct}"> % o más debajo del piso normal</span>
          </label>
          <label class="fl-check"><input type="checkbox" id="fl-paused" ${settings.paused ? 'checked' : ''}> Pausar avisos (mail y push)</label>
          <p class="fl-help">También aviso si una ruta o un multidestino baja de su tope en USD. No repito un aviso salvo que baje 3% más o pase una semana. El push lo manda la tarea de la Mac (al celular llega con Remote Control conectado).</p>
          <div class="fl-row">
            <button class="btn btn-primary btn-sm" type="submit">Guardar</button>
            <button class="btn btn-secondary btn-sm" type="button" data-act="test-mail">Mandar mail de prueba</button>
          </div>
        </form>
      </section>

      <section class="fl-card">
        <div class="fl-card-h"><span>Últimos chequeos</span></div>
        <div class="fl-runs">${runs.slice(0, 8).map(renderRun).join('') || '<div class="fl-empty">Sin chequeos todavía.</div>'}</div>
        ${cache.log.length ? `<div class="fl-card-h fl-mt"><span>Mails</span></div><div class="fl-runs">${cache.log.slice(0, 6).map(renderLog).join('')}</div>` : ''}
      </section>
    </div>
  `;
  restoreDirty(root, dirty);
  wire(root);
};

const passesFilter = (d) => {
  if (filter === 'great') return !!d.great;
  if (filter === 'playa') return !!d.beach;
  if (filter === 'cor') return d.origin === 'COR' || d.legs?.[0]?.from === 'COR';
  if (filter === 'multi') return d.kind === 'multi';
  return true;
};

const VERDICT = {
  bajo: ['Debajo de lo normal', 'down'],
  normal: ['Precio normal', 'flat'],
  alto: ['Arriba de lo normal', 'up'],
  'sin-ref': ['Sin referencia de Google', 'flat'],
};

const renderDeal = (d) => {
  const legs = d.legs || [];
  const out = legs[0], back = legs[legs.length - 1];
  const route = d.kind === 'multi'
    ? legs.map(l => l.from).concat(back ? [back.to] : []).join(' → ')
    : `${d.origin || out?.from || ''} → ${d.dest || out?.to || ''}`;
  const age = Date.now() - d.validatedAt;
  const stale = age > STALE_MS;
  const pct = pctBelow(d);
  const [vLabel, vKind] = d.great
    ? [`Muy buena${pct > 0 ? ` · −${pct}%` : ''}`, 'great']
    : (VERDICT[d.verdict] || VERDICT['sin-ref']);
  const tags = [
    d.validated ? `<span class="fl-tag ${stale ? 'warn' : 'ok'}">${stale ? `Precio de hace ${Math.floor(age / 86400000)} días` : `Validado en ${escapeHtml(d.seller || 'el vendedor')} · hace ${relTime(d.validatedAt)}`}</span>` : '<span class="fl-tag warn">Sin validar</span>',
    d.beach ? '<span class="fl-tag sea">Playa</span>' : '',
    d.kind !== 'multi' && out?.stops ? `<span class="fl-tag">${escapeHtml(out.stops)}</span>` : '',
    d.fare ? `<span class="fl-tag">Tarifa ${escapeHtml(d.fare)}</span>` : '',
    d.seatsLeft ? `<span class="fl-tag warn">${escapeHtml(d.seatsLeft)}</span>` : '',
  ].join('');
  const dates = d.kind === 'multi'
    ? ''
    : `<span><span class="muted">Fechas</span> ${fmtRange(out?.date, back && back !== out ? back.date : null)}</span>`;
  const airline = [...new Set(legs.map(l => l.airline).filter(Boolean))].join(' + ');
  const hist = historyFor(d.watchId);
  return `<article class="fl-deal${d.great ? ' is-great' : ''}">
    <div class="fl-route">
      <div class="fl-legs">${escapeHtml(route)}</div>
      <div class="fl-code${d.kind === 'multi' ? ' fl-code-sm' : ''}">${escapeHtml(d.kind === 'multi' ? legs.slice(0, -1).map(l => l.to).join('+') : (d.dest || out?.to || ''))}</div>
      <div class="fl-city">${escapeHtml(d.title || d.destName || '')}</div>
    </div>
    <div class="fl-body">
      <div class="fl-meta">${airline ? `<span><span class="muted">Aerolínea</span> ${escapeHtml(airline)}</span>` : ''}${dates}</div>
      <div class="fl-tags">${tags}</div>
      ${d.kind === 'multi' ? renderLegs(legs) : ''}
      ${d.normal ? renderBar(d) : `<p class="fl-small muted">${escapeHtml(d.googleNote || 'Google no dio rango normal para estas fechas.')}</p>`}
      ${hist && hist.length > 1 ? renderSpark(hist) : ''}
      ${d.kind === 'multi' && d.maxUsd ? `<p class="fl-small muted">Te aviso si baja de USD ${fmtNum(d.maxUsd)}.</p>` : ''}
      ${d.notes?.length ? `<ul class="fl-notes">${d.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="fl-stub">
      <div class="fl-cur">${d.approx ? '≈ USD' : 'USD'} · total</div>
      <div class="fl-price">${fmtNum(d.priceUsd)}</div>
      ${d.priceArs ? `<div class="fl-small"><strong>${fmtArs(d.priceArs)}</strong>${d.seller ? ` en ${escapeHtml(d.seller)}` : ''}</div>` : (d.seller ? `<div class="fl-small">Precio final en <strong>${escapeHtml(d.seller)}</strong></div>` : '')}
      <span class="fl-verdict ${vKind}">${escapeHtml(vLabel)}</span>
      <div class="fl-links">
        ${(d.links || []).map(l => { const u = sanitizeUrl(l.url); return u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(l.label)} ↗</a>` : ''; }).join('')}
        <button class="fl-linkbtn" type="button" data-act="del-deal" data-id="${escapeHtml(d.id)}">Quitar</button>
      </div>
    </div>
  </article>`;
};

const renderLegs = (legs) => `<ol class="fl-leglist">${legs.map(l => `
  <li><strong>${escapeHtml(l.from)} → ${escapeHtml(l.to)}</strong> · ${fmtDay(l.date)}${l.airline ? ` · ${escapeHtml(l.airline)}` : ''}${l.stops ? ` · ${escapeHtml(l.stops)}` : ''}${l.priceUsd ? ` · ${fmtUsd(l.priceUsd)}` : ''}${l.seller ? ` <span class="muted">(${escapeHtml(l.seller)})</span>` : ''}</li>`).join('')}
</ol>`;

const renderBar = (d) => {
  const { lo, hi } = d.normal;
  const min = Math.min(d.priceUsd, lo), max = Math.max(d.priceUsd, hi);
  const span = Math.max(max - min, 100);
  const a0 = min - span * 0.12, b0 = max + span * 0.12;
  const pos = v => ((v - a0) / (b0 - a0)) * 100;
  const p = pos(d.priceUsd);
  const al = p < 12 ? ' al-l' : p > 88 ? ' al-r' : '';
  return `<div class="fl-bar" role="img" aria-label="Precio ${d.priceUsd} dólares, rango normal ${lo} a ${hi}">
      <div class="fl-track"></div>
      <div class="fl-band" style="left:${pos(lo)}%;width:${pos(hi) - pos(lo)}%"></div>
      <div class="fl-mk${al}" style="left:${p}%"><span>${fmtUsd(d.priceUsd, d.approx)}</span></div>
    </div>
    <div class="fl-legend"><span><i class="l-mk"></i>Precio validado</span><span><i class="l-band"></i>Normal según Google: USD ${fmtNum(lo)}–${fmtNum(hi)}</span></div>`;
};

const renderSpark = (hist) => {
  const pts = hist.slice(-30);
  const vals = pts.map(p => p.priceUsd);
  const min = Math.min(...vals), max = Math.max(...vals);
  const W = 160, H = 32, pad = 3;
  const x = i => pad + (i * (W - 2 * pad)) / Math.max(pts.length - 1, 1);
  const y = v => (max === min ? H / 2 : pad + ((max - v) * (H - 2 * pad)) / (max - min));
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.priceUsd).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<div class="fl-spark">
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
      <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.priceUsd).toFixed(1)}" r="2.6" fill="currentColor"/>
    </svg>
    <span class="fl-small muted">${pts.length} chequeos · mín USD ${fmtNum(min)} · máx USD ${fmtNum(max)}</span>
  </div>`;
};

const renderWatch = (w) => {
  const h = historyFor(w.id);
  const last = h && h.length ? h[h.length - 1] : null;
  return `<div class="fl-watch${w.active ? '' : ' is-off'}">
    <div class="fl-watch-main">
      <div class="fl-watch-title">
        <strong>${escapeHtml(w.origin)} → ${escapeHtml(w.dest)}</strong> <span>${escapeHtml(w.destName || '')}</span>
        ${w.beach ? '<span class="fl-tag sea">Playa</span>' : ''}
        ${w.active && w.due ? '<span class="fl-tag">Toca en el próximo chequeo</span>' : ''}
      </div>
      <div class="fl-small muted">${fmtRange(w.window?.from, w.window?.to)} · ${w.nights?.min}–${w.nights?.max} noches · cada ${w.everyDays} días${w.maxUsd ? ` · tope USD ${fmtNum(w.maxUsd)}` : ''}${w.note ? ` · ${escapeHtml(w.note)}` : ''}</div>
    </div>
    <div class="fl-watch-last fl-small">
      ${last ? `${fmtUsd(last.priceUsd)}<br><span class="muted">${fmtRange(last.out, last.ret)}</span>` : '<span class="muted">Sin precio todavía</span>'}
      <br><span class="muted">${w.lastCheckedAt ? `chequeada hace ${relTime(w.lastCheckedAt)}` : 'nunca chequeada'}</span>
    </div>
    <div class="fl-watch-act">
      <label class="fl-check" title="Activa"><input type="checkbox" data-act="toggle-watch" data-id="${escapeHtml(w.id)}" ${w.active ? 'checked' : ''}> Activa</label>
      <button class="fl-linkbtn" type="button" data-act="edit-watch" data-id="${escapeHtml(w.id)}">Editar</button>
      <button class="fl-linkbtn danger" type="button" data-act="del-watch" data-id="${escapeHtml(w.id)}">Borrar</button>
    </div>
  </div>`;
};

const renderWatchForm = (w) => {
  const v = w || { origin: 'BUE', dest: '', destName: '', region: 'caribe', beach: true, window: { from: '2027-03-01', to: '2027-06-30' }, nights: { min: 7, max: 14 }, everyDays: 2, maxUsd: null, note: '' };
  const id = w ? w.id : 'new';
  return `<form class="fl-form" data-form="watch" data-id="${escapeHtml(w ? w.id : '__new')}">
    <div class="fl-form-grid">
      <label>Desde<select class="input" id="fw-origin-${id}">${ORIGINS.map(([c, n]) => `<option value="${c}" ${v.origin === c ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Hasta (código)<input class="input" id="fw-dest-${id}" value="${escapeHtml(v.dest)}" maxlength="3" placeholder="PUJ" required pattern="[A-Za-z]{3}"></label>
      <label>Nombre<input class="input" id="fw-name-${id}" value="${escapeHtml(v.destName || '')}" placeholder="Punta Cana"></label>
      <label>Región<select class="input" id="fw-region-${id}">${REGIONS.map(([c, n]) => `<option value="${c}" ${v.region === c ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Salir desde<input class="input" type="date" id="fw-from-${id}" value="${escapeHtml(v.window?.from || '')}" required></label>
      <label>Volver hasta<input class="input" type="date" id="fw-to-${id}" value="${escapeHtml(v.window?.to || '')}" required></label>
      <label>Noches mín.<input class="input" type="number" min="1" max="60" id="fw-nmin-${id}" value="${v.nights?.min ?? 7}"></label>
      <label>Noches máx.<input class="input" type="number" min="1" max="60" id="fw-nmax-${id}" value="${v.nights?.max ?? 14}"></label>
      <label>Revisar cada (días)<input class="input" type="number" min="1" max="30" id="fw-every-${id}" value="${v.everyDays ?? 2}"></label>
      <label>Tope USD (opcional)<input class="input" type="number" min="0" step="1" id="fw-max-${id}" value="${v.maxUsd ?? ''}" placeholder="ej. 500"></label>
      <label class="fl-span2">Nota<input class="input" id="fw-note-${id}" value="${escapeHtml(v.note || '')}" placeholder="opcional"></label>
      <label class="fl-check"><input type="checkbox" id="fw-beach-${id}" ${v.beach ? 'checked' : ''}> Tiene playa</label>
    </div>
    <div class="fl-row">
      <button class="btn btn-primary btn-sm" type="submit">${w ? 'Guardar' : 'Seguir esta ruta'}</button>
      <button class="btn btn-secondary btn-sm" type="button" data-act="cancel-edit">Cancelar</button>
    </div>
  </form>`;
};

const renderRun = (r) => `<div class="fl-run">
  <span>${new Date(r.ts).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
  <span>${r.checked.length} rutas · ${r.validated} precios${r.alerts ? ` · <strong>${r.alerts} alerta${r.alerts > 1 ? 's' : ''}</strong>` : ''}</span>
  ${r.failures?.length ? `<span class="fl-small warn-text">${r.failures.length} sin validar: ${escapeHtml(r.failures.map(f => f.reason).filter(Boolean).slice(0, 2).join(' · '))}</span>` : ''}
  ${r.note ? `<span class="fl-small muted">${escapeHtml(r.note)}</span>` : ''}
</div>`;

const renderLog = (l) => `<div class="fl-run">
  <span>${new Date(l.ts).toLocaleString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
  <span>${l.ok ? 'Mail enviado' : '<span class="warn-text">Mail falló</span>'} · ${escapeHtml((l.deals || []).map(d => `${d.title || d.id} USD ${fmtNum(d.priceUsd)}`).join(', '))}</span>
  ${l.error ? `<span class="fl-small warn-text">${escapeHtml(l.error)}</span>` : ''}
</div>`;

// ---------- eventos ----------

// Devuelve true si la carga anduvo (para no decir "Actualizado" después de un error)
const reloadAndPaint = async (root) => {
  const g = gen;
  await load({ force: true });
  if (g === gen) paint(root);
  return !loadError;
};

const wire = (root) => {
  root.querySelectorAll('[data-act]').forEach(el => {
    const act = el.dataset.act;
    const ev = el.type === 'checkbox' ? 'change' : 'click';
    el.addEventListener(ev, async () => {
      const id = el.dataset.id;
      try {
        if (act === 'reload') { if (await reloadAndPaint(root)) toast('Actualizado'); }
        else if (act === 'filter') {
          filter = el.dataset.f;
          try { localStorage.setItem('tempo-vuelos-filtro', filter); } catch { /* sin storage */ }
          paint(root);
        }
        else if (act === 'new-watch') { editing = '__new'; paint(root); root.querySelector('#fl-watches')?.scrollIntoView({ behavior: 'smooth' }); }
        else if (act === 'edit-watch') { editing = id; paint(root); }
        else if (act === 'cancel-edit') { editing = null; paint(root); }
        else if (act === 'toggle-watch') {
          await api.updateFlightWatch(id, { active: el.checked });
          await reloadAndPaint(root);
        }
        else if (act === 'del-watch') {
          const w = cache.watches.find(x => x.id === id);
          if (!confirm(`¿Dejar de seguir ${w ? `${w.origin} → ${w.dest}` : 'esta ruta'}? Se borra su historial de precios.`)) return;
          await api.deleteFlightWatch(id);
          await reloadAndPaint(root);
          toast(`Dejé de seguir ${w ? `${w.origin} → ${w.dest}` : 'la ruta'}`);
        }
        else if (act === 'del-deal') {
          await api.deleteFlightDeal(id);
          await reloadAndPaint(root);
          toast('Oferta quitada');
        }
        else if (act === 'test-mail') {
          const to = root.querySelector('#fl-email')?.value.trim();
          el.disabled = true;
          const r = await api.sendFlightTestEmail(to);
          toast('Mail de prueba enviado a ' + r.to, 'success');
          el.disabled = false;
        }
      } catch (e) {
        el.disabled = false;
        toast(e.message, 'error');
        if (el.type === 'checkbox') el.checked = !el.checked;
      }
    });
  });

  root.querySelector('[data-form="settings"]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.currentTarget.querySelector('[type=submit]');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const body = { email: root.querySelector('#fl-email').value.trim(), paused: root.querySelector('#fl-paused').checked };
      const pctRaw = root.querySelector('#fl-pct').value.trim();
      if (pctRaw !== '') body.alertPct = Number(pctRaw); // vacío = no tocar el umbral guardado
      await api.saveFlightSettings(body);
      await reloadAndPaint(root);
      toast('Alertas guardadas', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { if (btn) btn.disabled = false; }
  });

  root.querySelectorAll('[data-form="watch"]').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter || form.querySelector('[type=submit]');
      if (btn?.disabled) return; // doble clic = una sola ruta
      if (btn) btn.disabled = true;
      const wid = form.dataset.id;
      const k = wid === '__new' ? 'new' : wid;
      const val = (name) => form.querySelector(`#fw-${name}-${k}`);
      const maxRaw = val('max').value.trim();
      const body = {
        origin: val('origin').value,
        dest: val('dest').value.trim().toUpperCase(),
        destName: val('name').value.trim(),
        region: val('region').value,
        beach: val('beach').checked,
        window: { from: val('from').value, to: val('to').value },
        nights: { min: Number(val('nmin').value), max: Number(val('nmax').value) },
        everyDays: Number(val('every').value),
        maxUsd: maxRaw === '' ? null : Number(maxRaw),
        note: val('note').value.trim(),
      };
      try {
        if (wid === '__new') await api.createFlightWatch(body);
        else await api.updateFlightWatch(wid, body);
        editing = null;
        await reloadAndPaint(root);
        toast(wid === '__new' ? `Sigo ${body.origin} → ${body.dest}` : 'Ruta guardada', 'success');
      } catch (err) { toast(err.message, 'error'); }
      finally { if (btn) btn.disabled = false; }
    });
  });
};
