// btcAlerts.js — alertas de precio de BTC con notificación por email
//
// La vista deja crear/editar/borrar alertas. El backend consulta CoinGecko
// cada 10 minutos y dispara un email SMTP cuando el precio cumple la
// condición. Cooldown configurable por alerta (default 6h) para evitar
// spam mientras la condición se mantenga.

import { api } from '../api.js';
import { escapeHtml, relTime } from '../utils.js';
import { toast } from '../components/toast.js';

const DEFAULT_EMAIL = 'dariovillalon17@gmail.com';

let cache = {
  alerts: [],
  log: [],
  snapshot: null,
  mailConfigured: false,
  mailProvider: 'gmail-smtp',
  mailFrom: '',
  checkIntervalMs: 10 * 60 * 1000,
};
let editingId = null;     // id de alerta en edición, o '__new' para nueva
let priceTimer = null;

const fmtPrice = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtPct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const fmtDirection = (d) => d === 'above' ? '≥ supera' : '≤ cae a';

const loadAll = async () => {
  try {
    const r = await api.listBtcAlerts();
    cache = { ...cache, ...r };
  } catch (e) {
    toast('Error cargando alertas: ' + e.message, 'error');
  }
};

const refreshPrice = async () => {
  try {
    const r = await api.getBtcPrice();
    if (r?.snapshot) cache.snapshot = r.snapshot;
  } catch {}
};

export const renderBtcAlerts = (root) => {
  // Limpiar timers de la vista anterior si los hubiera
  if (priceTimer) { clearInterval(priceTimer); priceTimer = null; }

  paint(root);
  loadAll().then(() => paint(root));
  refreshPrice().then(() => paint(root));

  // Refrescar precio cada 60s mientras la vista esté visible
  priceTimer = setInterval(() => {
    refreshPrice().then(() => updatePriceBox(root));
  }, 60_000);

  window._viewCleanup = () => {
    if (priceTimer) { clearInterval(priceTimer); priceTimer = null; }
  };
};

const paint = (root) => {
  const snap = cache.snapshot;
  const intervalMin = Math.round(cache.checkIntervalMs / 60000);
  const mailWarning = cache.mailConfigured ? '' : `
    <div class="btc-warning">
      <strong>Email no configurado.</strong> Las alertas se evalúan, pero no se envía
      el correo hasta que exportes <code>SMTP_USER</code> y <code>SMTP_PASS</code>
      (App Password de Gmail) antes de arrancar el servidor. Instrucciones abajo.
    </div>`;

  root.innerHTML = `
    <div class="view-h">
      <div>
        <h2 style="margin-bottom:2px">BTC Alerts</h2>
        <div style="font-size:11.5px;color:var(--text-3)">
          Chequeo cada ${intervalMin} min · CoinGecko · email vía Gmail SMTP
        </div>
      </div>
      <div class="view-h-actions">
        <button class="btn btn-secondary btn-sm" id="btc-refresh">Actualizar</button>
        <button class="btn btn-secondary btn-sm" id="btc-force-check" title="Forzar check ahora (ignora cooldown)">Probar disparo</button>
        <button class="btn btn-primary btn-sm" id="btc-new">+ Nueva alerta</button>
      </div>
    </div>

    ${mailWarning}

    <div id="btc-price-box">${renderPriceBox()}</div>

    <div class="btc-grid">
      <section class="btc-card">
        <div class="btc-card-h">
          <span>Alertas</span>
          <span class="muted text-xs">${cache.alerts.length} configuradas</span>
        </div>
        <div id="btc-alerts-list">${renderAlertsList()}</div>
      </section>

      <section class="btc-card">
        <div class="btc-card-h">
          <span>Historial</span>
          <span class="muted text-xs">${(cache.log || []).length} eventos</span>
        </div>
        <div id="btc-log">${renderLog()}</div>
      </section>
    </div>

  `;

  wire(root);
};

const renderPriceBox = () => {
  const s = cache.snapshot;
  if (!s) {
    return `<div class="btc-price-box loading">
      <div class="spinner" style="margin:0"></div>
      <div>Consultando precio…</div>
    </div>`;
  }
  const ch = s.change24h;
  const klass = ch == null ? '' : (ch >= 0 ? 'up' : 'down');
  return `
    <div class="btc-price-box">
      <div class="btc-price-main">
        <div class="btc-price-label">Bitcoin · USD</div>
        <div class="btc-price-value">${fmtPrice(s.price)}</div>
        <div class="btc-price-change ${klass}">${fmtPct(ch)} <span class="muted">24h</span></div>
      </div>
      <div class="btc-price-meta">
        <div><span>Última lectura</span><strong>${relTime(s.fetchedAt)}</strong></div>
        <div><span>Fuente</span><strong>${escapeHtml(s.source || 'coingecko')}</strong></div>
      </div>
    </div>
  `;
};

const updatePriceBox = (root) => {
  const box = root.querySelector('#btc-price-box');
  if (box) box.innerHTML = renderPriceBox();
};

const renderAlertsList = () => {
  const items = [];
  if (editingId === '__new') items.push(renderForm({ id: '__new', target: '', email: DEFAULT_EMAIL, direction: 'below', cooldownHours: 6, active: true, note: '' }));
  if (!cache.alerts.length && editingId !== '__new') {
    return `<div class="empty" style="padding:24px">
      <div class="empty-title">Sin alertas todavía</div>
      <div>Tocá <strong>+ Nueva alerta</strong> para configurar la primera.</div>
    </div>`;
  }
  for (const a of cache.alerts) {
    if (editingId === a.id) {
      items.push(renderForm(a));
    } else {
      items.push(renderAlertRow(a));
    }
  }
  return items.join('');
};

const renderAlertRow = (a) => {
  const triggered = a.lastTriggeredAt
    ? `<span class="btc-meta-pill">Disparada ${relTime(a.lastTriggeredAt)} a ${fmtPrice(a.lastTriggerPrice || 0)}</span>`
    : '';
  const status = a.active
    ? `<span class="btc-pill on">Activa</span>`
    : `<span class="btc-pill off">Pausada</span>`;
  const note = a.note ? `<div class="btc-alert-note">${escapeHtml(a.note)}</div>` : '';
  return `
    <div class="btc-alert" data-id="${escapeHtml(a.id)}">
      <div class="btc-alert-main">
        <div class="btc-alert-headline">
          <span class="btc-direction ${a.direction}">${fmtDirection(a.direction)}</span>
          <span class="btc-target">${fmtPrice(a.target)}</span>
        </div>
        <div class="btc-alert-sub">
          → ${escapeHtml(a.email)} · cooldown ${a.cooldownHours ?? 6}h · ${a.triggerCount || 0} disparos
        </div>
        ${note}
        <div class="btc-alert-meta">${status}${triggered}</div>
      </div>
      <div class="btc-alert-actions">
        <button class="btn btn-ghost btn-sm" data-act="toggle">${a.active ? 'Pausar' : 'Activar'}</button>
        <button class="btn btn-ghost btn-sm" data-act="test">Email prueba</button>
        <button class="btn btn-secondary btn-sm" data-act="edit">Editar</button>
        <button class="btn btn-danger btn-sm" data-act="del">Eliminar</button>
      </div>
    </div>
  `;
};

const renderForm = (a) => {
  const isNew = a.id === '__new';
  return `
    <div class="btc-alert btc-alert-form" data-id="${escapeHtml(a.id)}">
      <div class="btc-alert-form-grid">
        <div class="field">
          <label>Condición</label>
          <select class="select" data-f="direction">
            <option value="below" ${a.direction === 'below' ? 'selected' : ''}>Precio cae a (≤)</option>
            <option value="above" ${a.direction === 'above' ? 'selected' : ''}>Precio supera (≥)</option>
          </select>
        </div>
        <div class="field">
          <label>Precio objetivo (USD)</label>
          <input type="number" class="input" data-f="target" min="1" step="any" value="${escapeHtml(a.target)}" placeholder="60000">
        </div>
        <div class="field">
          <label>Cooldown (horas)</label>
          <input type="number" class="input" data-f="cooldownHours" min="0.25" step="0.25" value="${a.cooldownHours ?? 6}">
        </div>
        <div class="field" style="grid-column: 1 / -1">
          <label>Enviar email a</label>
          <input type="email" class="input" data-f="email" value="${escapeHtml(a.email || '')}" placeholder="${DEFAULT_EMAIL}">
        </div>
        <div class="field" style="grid-column: 1 / -1">
          <label>Nota (opcional)</label>
          <input type="text" class="input" data-f="note" value="${escapeHtml(a.note || '')}" placeholder="Por ej: comprar más si llega ahí">
        </div>
        <label class="btc-active-row" style="grid-column: 1 / -1">
          <input type="checkbox" data-f="active" ${a.active !== false ? 'checked' : ''}>
          <span>Alerta activa</span>
        </label>
      </div>
      <div class="btc-alert-form-actions">
        <button class="btn btn-ghost btn-sm" data-act="cancel">Cancelar</button>
        <button class="btn btn-primary btn-sm" data-act="save">${isNew ? 'Crear alerta' : 'Guardar'}</button>
      </div>
    </div>
  `;
};

const renderLog = () => {
  const log = cache.log || [];
  if (!log.length) {
    return `<div class="muted" style="padding:14px">Todavía no se disparó ninguna alerta.</div>`;
  }
  return log.slice(0, 25).map(ev => {
    const arrow = ev.direction === 'above' ? '↑' : '↓';
    const status = ev.ok
      ? `<span class="btc-pill on">enviado</span>`
      : `<span class="btc-pill err" title="${escapeHtml(ev.error || '')}">falló</span>`;
    return `
      <div class="btc-log-row">
        <div class="btc-log-time">${relTime(ev.ts)}</div>
        <div class="btc-log-main">
          <strong>${arrow} ${fmtPrice(ev.price)}</strong>
          <span class="muted">objetivo ${fmtPrice(ev.target)} → ${escapeHtml(ev.email)}</span>
        </div>
        <div>${status}</div>
      </div>
    `;
  }).join('');
};

const wire = (root) => {
  root.querySelector('#btc-refresh').addEventListener('click', async () => {
    await Promise.all([loadAll(), refreshPrice()]);
    paint(root);
    toast('Actualizado', 'success');
  });

  root.querySelector('#btc-force-check').addEventListener('click', async () => {
    if (!cache.alerts.length) { toast('No hay alertas configuradas', 'info'); return; }
    if (!confirm('Esto fuerza un chequeo y dispara emails (ignora cooldown). ¿Continuar?')) return;
    try {
      const r = await api.forceBtcCheck(true);
      if (r.fired?.length) toast(`Disparé ${r.fired.length} alerta(s)`, 'success');
      else toast('Ninguna alerta cumple condición ahora mismo', 'info');
      await loadAll();
      paint(root);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  root.querySelector('#btc-new').addEventListener('click', () => {
    editingId = '__new';
    paint(root);
    const form = root.querySelector(`[data-id="__new"]`);
    if (form) form.querySelector('input[data-f="target"]')?.focus();
  });

  root.querySelectorAll('.btc-alert').forEach(card => {
    const id = card.dataset.id;
    card.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => handleAction(e, root, id, btn.dataset.act, card));
    });
  });
};

const handleAction = async (_e, root, id, act, card) => {
  const alert = cache.alerts.find(a => a.id === id);
  switch (act) {
    case 'edit':
      editingId = id;
      paint(root);
      break;
    case 'cancel':
      editingId = null;
      paint(root);
      break;
    case 'save': {
      const get = (f) => card.querySelector(`[data-f="${f}"]`);
      const payload = {
        direction: get('direction').value,
        target: parseFloat(get('target').value),
        email: get('email').value.trim() || DEFAULT_EMAIL,
        cooldownHours: parseFloat(get('cooldownHours').value),
        note: get('note').value.trim(),
        active: get('active').checked,
      };
      if (!Number.isFinite(payload.target) || payload.target <= 0) {
        toast('Precio inválido', 'error'); return;
      }
      try {
        if (id === '__new') {
          await api.createBtcAlert(payload);
          toast('Alerta creada', 'success');
        } else {
          await api.updateBtcAlert(id, payload);
          toast('Alerta actualizada', 'success');
        }
        editingId = null;
        await loadAll();
        paint(root);
      } catch (e) { toast('Error: ' + e.message, 'error'); }
      break;
    }
    case 'toggle':
      try {
        await api.updateBtcAlert(id, { active: !alert.active });
        await loadAll();
        paint(root);
      } catch (e) { toast('Error: ' + e.message, 'error'); }
      break;
    case 'test':
      try {
        await api.sendBtcTestEmail(alert.email);
        toast('Email de prueba enviado a ' + alert.email, 'success');
      } catch (e) { toast('Falló: ' + e.message, 'error'); }
      break;
    case 'del':
      if (!confirm('¿Eliminar esta alerta?')) return;
      try {
        await api.deleteBtcAlert(id);
        await loadAll();
        paint(root);
        toast('Eliminada', 'success');
      } catch (e) { toast('Error: ' + e.message, 'error'); }
      break;
  }
};
