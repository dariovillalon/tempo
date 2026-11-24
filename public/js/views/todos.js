// todos.js — Pendientes: lista de cosas por hacer con check, categorías y orden a mano.
// El orden de state.todos.items es el orden en pantalla (dentro de cada categoría);
// arrastrar desde ⋮⋮ reordena y también mueve entre categorías.

import { state, mutate } from '../state.js';
import { uid, escapeHtml } from '../utils.js';
import { toast } from '../components/toast.js';

const NONE = '__none__';      // clave de "Sin categoría" en el DOM (catId null en el estado)
const showDone = new Set();   // categorías con las hechas desplegadas (por defecto plegadas)
let refocus = null;           // selector a enfocar después del re-render (cargar varias seguidas)
let keepFocus = null;         // campo que tenía el foco cuando el router redibujó (resync, otra mutación)

// El router vacía la vista antes de llamar a renderTodos: el campo activo se guarda en el
// cleanup (que corre antes) para devolverle foco, texto y cursor después del re-render.
const FOCUS_ATTRS = ['data-tadd', 'data-ttext', 'data-tcatname'];
const snapshotFocus = (root) => {
  const a = document.activeElement;
  keepFocus = null;
  if (!a || !root.contains(a) || a.tagName !== 'INPUT') return;
  const attr = FOCUS_ATTRS.find(n => a.hasAttribute(n));
  const sel = attr ? `[${attr}="${a.getAttribute(attr)}"]` : (a.id ? `#${a.id}` : null);
  if (sel) keepFocus = { sel, value: a.value, start: a.selectionStart, end: a.selectionEnd, at: Date.now() };
};
const restoreFocus = (root) => {
  if (refocus) {
    const el = root.querySelector(refocus);
    refocus = null; keepFocus = null;
    el?.focus();
    return;
  }
  const k = keepFocus; keepFocus = null;
  if (!k || Date.now() - k.at > 2000) return; // de otra visita a la pestaña: no aplica
  const el = root.querySelector(k.sel);
  if (!el) return;
  el.value = k.value;
  el.focus();
  try { el.setSelectionRange(k.start, k.end); } catch { /* inputs sin selección */ }
};

const keyOf = (catId) => catId || NONE;
const catOf = (key) => (key === NONE ? null : key);
const itemsOf = (catId) => state.todos.items.filter(i => (i.catId || null) === (catId || null));

// ----- Mutaciones -----
const addItem = (catId, text) => {
  refocus = `[data-tadd="${keyOf(catId)}"]`;
  mutate(s => { s.todos.items.push({ id: uid(), text, done: false, catId: catId || null, createdAt: Date.now(), doneAt: null }); });
};
const toggleDone = (id) => mutate(s => {
  const it = s.todos.items.find(i => i.id === id); if (!it) return;
  it.done = !it.done;
  it.doneAt = it.done ? Date.now() : null;
});
const patchText = (id, text) => mutate(s => { const it = s.todos.items.find(i => i.id === id); if (it) it.text = text; });
// El ✕ queda a un toque en el celular: borrar avisa con "Deshacer" en vez de confirmar.
const delItem = (id) => {
  const idx = state.todos.items.findIndex(i => i.id === id);
  if (idx < 0) return;
  const removed = state.todos.items[idx];
  mutate(s => { s.todos.items = s.todos.items.filter(i => i.id !== id); });
  toast(`Borré "${removed.text || 'el pendiente'}"`, '', {
    actionLabel: 'Deshacer', duration: 6000,
    onAction: () => mutate(s => { if (!s.todos.items.some(i => i.id === id)) s.todos.items.splice(Math.min(idx, s.todos.items.length), 0, removed); }),
  });
};
const clearDone = (catId) => {
  const inCat = (i) => i.done && (i.catId || null) === (catId || null);
  const removed = state.todos.items.map((it, idx) => ({ it, idx })).filter(x => inCat(x.it));
  if (!removed.length) return;
  mutate(s => { s.todos.items = s.todos.items.filter(i => !inCat(i)); });
  toast(`Borré ${removed.length} hecha(s)`, '', {
    actionLabel: 'Deshacer', duration: 6000,
    // Vuelven a su lugar sin pisar lo que se haya cargado mientras tanto
    onAction: () => mutate(s => {
      for (const { it, idx } of removed) if (!s.todos.items.some(i => i.id === it.id)) s.todos.items.splice(Math.min(idx, s.todos.items.length), 0, it);
    }),
  });
};
const addCategory = (name) => {
  const id = uid();
  refocus = `[data-tadd="${id}"]`;
  mutate(s => { s.todos.categories.push({ id, name }); });
};
const renameCategory = (id, name) => mutate(s => { const c = s.todos.categories.find(x => x.id === id); if (c) c.name = name; });
const moveCategory = (id, dir) => mutate(s => {
  const arr = s.todos.categories; const i = arr.findIndex(c => c.id === id); const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
});
const delCategory = (id) => {
  const cIdx = state.todos.categories.findIndex(c => c.id === id);
  if (cIdx < 0) return;
  const cat = state.todos.categories[cIdx];
  const items = state.todos.items.map((it, idx) => ({ it, idx })).filter(x => x.it.catId === id);
  mutate(s => {
    s.todos.categories = s.todos.categories.filter(c => c.id !== id);
    s.todos.items = s.todos.items.filter(i => i.catId !== id);
  });
  toast(`Borré "${cat.name || 'la categoría'}"${items.length ? ` y sus ${items.length} pendiente(s)` : ''}`, '', {
    actionLabel: 'Deshacer', duration: 8000,
    onAction: () => mutate(s => {
      if (s.todos.categories.some(c => c.id === id)) return;
      s.todos.categories.splice(Math.min(cIdx, s.todos.categories.length), 0, cat);
      for (const { it, idx } of items) if (!s.todos.items.some(i => i.id === it.id)) s.todos.items.splice(Math.min(idx, s.todos.items.length), 0, it);
    }),
  });
};

// ----- Arrastrar para reordenar (mouse y touch con Pointer Events) -----
// El HTML5 drag & drop no anda en el celular: acá la fila se mueve en el DOM mientras
// arrastrás y al soltar se guarda el orden que quedó en pantalla.
const orderSnapshot = (root) => [...root.querySelectorAll('[data-tlist]')]
  .map(l => l.dataset.tlist + ':' + [...l.querySelectorAll('.todo-item')].map(r => r.dataset.tid).join(','))
  .join('|');

const commitOrder = (root) => {
  const placement = [];
  for (const l of root.querySelectorAll('[data-tlist]')) {
    const catId = catOf(l.dataset.tlist);
    for (const r of l.querySelectorAll('.todo-item')) placement.push([r.dataset.tid, catId]);
  }
  mutate(s => {
    const byId = new Map(s.todos.items.map(i => [i.id, i]));
    const seen = new Set(); const out = [];
    for (const [id, catId] of placement) {
      const it = byId.get(id);
      if (!it || seen.has(id)) continue;
      it.catId = catId; out.push(it); seen.add(id);
    }
    // Hechas (no se arrastran) y cualquier otro ítem quedan al final, en su orden relativo
    for (const it of s.todos.items) if (!seen.has(it.id)) out.push(it);
    s.todos.items = out;
  });
};

let dragging = false;
const startDrag = (e, handle, root) => {
  if (e.button > 0 || dragging) return;
  e.preventDefault();
  const row = handle.closest('.todo-item');
  if (!row) return;
  dragging = true;
  const sc = document.getElementById('view-content');
  const before = orderSnapshot(root);
  // Los eventos se escuchan en window: mover la fila en el DOM suelta la captura del
  // puntero (y con ella el pointerup en el ⋮⋮), así que capturar no alcanza.
  const pid = e.pointerId;
  row.classList.add('is-dragging');
  document.body.classList.add('todo-dragging');
  let x = e.clientX, y = e.clientY, raf = 0;

  const place = () => {
    if (!root.contains(row)) return; // la vista se redibujó: no meter la fila vieja en el DOM nuevo
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const over = el.closest('.todo-item');
    if (over && over !== row && over.parentElement?.matches('[data-tlist]')) {
      const r = over.getBoundingClientRect();
      over.parentElement.insertBefore(row, y < r.top + r.height / 2 ? over : over.nextSibling);
      return;
    }
    // Sobre una categoría sin pendientes (o su encabezado): va al final de esa lista
    const list = el.closest('[data-tlist]') || el.closest('.todo-cat')?.querySelector('[data-tlist]');
    if (list && !list.contains(row)) list.appendChild(row);
  };
  const autoScroll = () => {
    if (!sc) return;
    const r = sc.getBoundingClientRect(); const edge = 56;
    if (y < r.top + edge) sc.scrollTop -= 14;
    else if (y > r.bottom - edge) sc.scrollTop += 14;
  };
  const tick = () => { autoScroll(); place(); raf = requestAnimationFrame(tick); };
  const move = (ev) => { if (ev.pointerId !== pid) return; x = ev.clientX; y = ev.clientY; };
  const end = (ev) => {
    if (ev.pointerId !== pid) return;
    cancelAnimationFrame(raf);
    // Un arrastre rápido puede soltar antes del próximo frame: ubicar con la posición final
    if (ev.type === 'pointerup') { x = ev.clientX; y = ev.clientY; place(); }
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    dragging = false;
    row.classList.remove('is-dragging');
    document.body.classList.remove('todo-dragging');
    // La vista se pudo redibujar en el medio (resync): entonces la fila ya no está y no hay nada que guardar
    if (root.contains(row) && orderSnapshot(root) !== before) commitOrder(root);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  raf = requestAnimationFrame(tick);
};

// ----- Render -----
const itemRow = (it) => `<div class="todo-item" data-tid="${it.id}">
    <span class="todo-handle" title="Arrastrá para cambiar el orden o la categoría" aria-label="Mover">⋮⋮</span>
    <input type="checkbox" data-tdone="${it.id}" title="Hecho">
    <input type="text" class="input todo-text" data-ttext="${it.id}" value="${escapeHtml(it.text)}" aria-label="Pendiente">
    <button class="btn btn-ghost btn-sm todo-del" data-tdel="${it.id}" title="Borrar">✕</button>
  </div>`;

const doneRow = (it) => `<div class="todo-item is-done">
    <input type="checkbox" checked data-tdone="${it.id}" title="Desmarcar">
    <span class="todo-done-text">${escapeHtml(it.text || '(sin texto)')}</span>
    <button class="btn btn-ghost btn-sm todo-del" data-tdel="${it.id}" title="Borrar">✕</button>
  </div>`;

const section = (cat, { title, idx, total }) => {
  const key = keyOf(cat?.id);
  const items = itemsOf(cat?.id || null);
  const open = items.filter(i => !i.done);
  const done = items.filter(i => i.done);
  const doneOpen = showDone.has(key);
  const head = cat
    ? `<div class="todo-cat-head">
        <input type="text" class="input todo-cat-name" data-tcatname="${cat.id}" value="${escapeHtml(cat.name)}" placeholder="(sin nombre)" aria-label="Nombre de la categoría">
        <span class="muted text-xs todo-cat-count">${open.length}</span>
        <button class="btn btn-ghost btn-sm" data-tcatmove="${cat.id}" data-dir="-1" title="Subir categoría" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-sm" data-tcatmove="${cat.id}" data-dir="1" title="Bajar categoría" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-ghost btn-sm" data-tcatdel="${cat.id}" title="Borrar categoría">✕</button>
      </div>`
    : `<div class="todo-cat-head"><div class="card-title todo-cat-title">${escapeHtml(title)}</div><span class="muted text-xs todo-cat-count">${open.length}</span></div>`;
  return `<div class="card todo-cat" data-tcat="${key}">
      ${head}
      <input type="text" class="input todo-add" data-tadd="${key}" placeholder="Agregar pendiente… (Enter)" enterkeyhint="done">
      <div class="todo-list" data-tlist="${key}">${open.map(itemRow).join('')}</div>
      ${done.length ? `<div class="todo-done-bar">
          <button class="btn btn-ghost btn-sm todo-done-toggle" data-tshowdone="${key}">${doneOpen ? '▾' : '▸'} Hechas (${done.length})</button>
          ${doneOpen ? `<button class="btn btn-ghost btn-sm" data-tcleardone="${key}">Borrar hechas</button>` : ''}
        </div>
        ${doneOpen ? `<div class="todo-done-list">${done.map(doneRow).join('')}</div>` : ''}` : ''}
    </div>`;
};

export const renderTodos = (root) => {
  const { categories, items } = state.todos;
  const pending = items.filter(i => !i.done).length;
  const hasUncat = items.some(i => !i.catId);

  const sections = categories.map((c, idx) => section(c, { idx, total: categories.length }));
  // Sin categorías: una sola lista. Con categorías: "Sin categoría" solo si quedó algo ahí.
  if (!categories.length) sections.push(section(null, { title: 'Pendientes' }));
  else if (hasUncat) sections.push(section(null, { title: 'Sin categoría' }));

  root.innerHTML = `
    <div class="card todo-top">
      <div class="muted text-xs">${pending ? `<b>${pending}</b> pendiente(s)` : 'Nada pendiente'}${items.length - pending ? ` · ${items.length - pending} hecha(s)` : ''}</div>
      <div class="row gap-6" style="flex-wrap:wrap;align-items:center;margin-top:10px">
        <input type="text" class="input" id="todo-new-cat" placeholder="Nueva categoría (ej: Casa, Trabajo, Viaje)" style="flex:1;min-width:160px" enterkeyhint="done">
        <button class="btn btn-primary" id="todo-add-cat">+ Categoría</button>
      </div>
      ${!categories.length && !items.length ? '<div class="muted text-xs" style="margin-top:8px">Cargá pendientes abajo; con categorías los agrupás. Arrastrá desde ⋮⋮ para cambiar el orden o pasarlos a otra categoría.</div>' : ''}
    </div>
    ${sections.join('')}
  `;

  const all = (s) => Array.from(root.querySelectorAll(s));
  const onEnter = (el, fn) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); fn(); } });

  const newCat = root.querySelector('#todo-new-cat');
  const doAddCat = () => { const name = newCat.value.trim(); if (name) addCategory(name); };
  root.querySelector('#todo-add-cat').addEventListener('click', doAddCat);
  onEnter(newCat, doAddCat);

  all('[data-tadd]').forEach(el => onEnter(el, () => {
    const text = el.value.trim(); if (!text) return;
    addItem(catOf(el.dataset.tadd), text);
  }));
  all('[data-tdone]').forEach(c => c.addEventListener('change', () => toggleDone(c.dataset.tdone)));
  all('[data-tdel]').forEach(b => b.addEventListener('click', () => delItem(b.dataset.tdel)));
  all('[data-ttext]').forEach(el => {
    onEnter(el, () => el.blur());
    el.addEventListener('change', () => {
      const text = el.value.trim();
      if (!text) delItem(el.dataset.ttext); // vaciar el texto = borrar (con Deshacer)
      else patchText(el.dataset.ttext, text);
    });
  });
  all('[data-tcatname]').forEach(el => {
    onEnter(el, () => el.blur());
    el.addEventListener('change', () => renameCategory(el.dataset.tcatname, el.value.trim()));
  });
  all('[data-tcatmove]').forEach(b => b.addEventListener('click', () => moveCategory(b.dataset.tcatmove, +b.dataset.dir)));
  all('[data-tcatdel]').forEach(b => b.addEventListener('click', () => delCategory(b.dataset.tcatdel)));
  all('[data-tshowdone]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.tshowdone;
    if (showDone.has(k)) showDone.delete(k); else showDone.add(k);
    renderTodos(root);
  }));
  all('[data-tcleardone]').forEach(b => b.addEventListener('click', () => clearDone(catOf(b.dataset.tcleardone))));
  all('.todo-handle').forEach(h => h.addEventListener('pointerdown', (e) => startDrag(e, h, root)));

  window._viewCleanup = () => snapshotFocus(root);
  restoreFocus(root);
};
