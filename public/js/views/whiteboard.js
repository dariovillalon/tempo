// whiteboard.js — multi-tool canvas: stickies, shapes, text, checklists, arrows.
//
// Item shapes (`wb.items`):
//   { id, type: 'sticky'|'rect'|'ellipse'|'text'|'checklist',
//     x, y, w, h, color, text, todos? }
// Connectors (`wb.connectors`):
//   { id, from, to, color, label, style }
//
// One re-render of the whole canvas runs on every meaningful action (drop,
// edit commit, tool change). For drag/resize we mutate inline styles + redraw
// just the affected SVG paths to keep things smooth without touching the DOM.

import {
  state,
  addWhiteboard, updateWhiteboard, deleteWhiteboard,
  addWhiteboardItem, updateWhiteboardItem, deleteWhiteboardItem,
  addWhiteboardConnector, updateWhiteboardConnector, deleteWhiteboardConnector,
} from '../state.js';
import { escapeHtml, uid } from '../utils.js';
import { toast } from '../components/toast.js';

const COLORS = ['yellow', 'pink', 'blue', 'green', 'violet', 'orange', 'teal', 'red'];
const TOOLS = [
  { id: 'select',    label: 'Seleccionar', hint: 'V', icon: 'M3 3l7 17 2-7 7-2z' },
  { id: 'sticky',    label: 'Post-it',     hint: 'S', icon: 'M3 3h14l4 4v14H3z' },
  { id: 'rect',      label: 'Rectángulo',  hint: 'R', icon: 'M3 5h18v14H3z' },
  { id: 'ellipse',   label: 'Elipse',      hint: 'O', icon: 'M12 5a7 5 0 1 0 0 14 7 5 0 1 0 0-14z' },
  { id: 'text',      label: 'Texto',       hint: 'T', icon: 'M5 5h14M12 5v14' },
  { id: 'checklist', label: 'Checklist',   hint: 'C', icon: 'M4 6l3 3 6-6 M4 14l3 3 6-6 M16 7h5 M16 15h5' },
  { id: 'arrow',     label: 'Flecha',      hint: 'A', icon: 'M4 12h14m-4-4 4 4-4 4' },
];
const RESIZABLE = new Set(['sticky', 'rect', 'ellipse', 'checklist', 'text']);

let activeId = null;            // active whiteboard id
let tool = 'select';            // current tool
let selectedColor = 'yellow';   // color used when creating a new item
let selectedItemId = null;
let connectFromId = null;       // when arrow tool is mid-connection
let history = [];               // simple snapshot stack for Ctrl+Z

// ----- Public entry point -----------------------------------------------

export const renderWhiteboard = (root) => {
  if (state.whiteboards.length === 0) {
    addWhiteboard({ name: 'Pizarra principal' });
  }
  if (!activeId || !state.whiteboards.find(w => w.id === activeId)) {
    activeId = state.whiteboards[0].id;
    selectedItemId = null;
    connectFromId = null;
  }
  paint(root);
};

// ----- Helpers -----------------------------------------------------------

const getActive = () => state.whiteboards.find(w => w.id === activeId);

const snapshot = () => {
  const wb = getActive();
  if (!wb) return;
  history.push(JSON.stringify({ items: wb.items || [], connectors: wb.connectors || [] }));
  if (history.length > 30) history.shift();
};

const undo = (root) => {
  const prev = history.pop();
  if (!prev) { toast('Nada para deshacer', 'info'); return; }
  const data = JSON.parse(prev);
  updateWhiteboard(activeId, { items: data.items, connectors: data.connectors });
  paint(root);
};

const setTool = (next, root) => {
  tool = next;
  connectFromId = null;
  if (next !== 'select') selectedItemId = null;
  paintToolbar(root);
  const canvas = root.querySelector('#wb-canvas');
  if (canvas) {
    canvas.classList.remove('tool-arrow', 'tool-place', 'tool-select');
    if (next === 'arrow') canvas.classList.add('tool-arrow');
    else if (next === 'select') canvas.classList.add('tool-select');
    else canvas.classList.add('tool-place');
  }
};

// Anchor point on an item rectangle along a line going to (tx, ty).
// Picks the side intersection so arrows touch the border, not the centre.
const anchorOnRect = (it, tx, ty) => {
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = it.w / 2, halfH = it.h / 2;
  const scale = Math.min(halfW / Math.abs(dx || 1), halfH / Math.abs(dy || 1));
  return { x: cx + dx * scale, y: cy + dy * scale };
};

const connectorPath = (wb, conn) => {
  const a = wb.items.find(i => i.id === conn.from);
  const b = wb.items.find(i => i.id === conn.to);
  if (!a || !b) return null;
  const aCenter = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bCenter = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const start = anchorOnRect(a, bCenter.x, bCenter.y);
  const end = anchorOnRect(b, aCenter.x, aCenter.y);
  // Soft curve: control point pulled out perpendicular to the line.
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const curve = Math.min(60, len * 0.18);
  const cx = midX + (-dy / len) * curve;
  const cy = midY + (dx / len) * curve;
  return { d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`, end, start, mid: { x: cx, y: cy } };
};

// ----- Top-level paint --------------------------------------------------

const paint = (root) => {
  const wb = getActive();
  if (!wb) return;

  root.innerHTML = `
    <div class="view-h">
      <h2>Pizarras</h2>
      <div class="view-h-actions">
        <button class="btn btn-ghost btn-sm" id="wb-undo" title="Deshacer (⌘Z)">↶ Deshacer</button>
        <button class="btn btn-secondary" id="wb-rename">Renombrar</button>
        <button class="btn btn-ghost" id="wb-delete" ${state.whiteboards.length === 1 ? 'disabled style="opacity:.5;cursor:not-allowed"' : ''}>Eliminar pizarra</button>
      </div>
    </div>

    <div class="whiteboard-toolbar">
      <div class="wb-tabs" id="wb-tabs">
        ${state.whiteboards.map(w => `
          <div class="wb-tab ${w.id === activeId ? 'active' : ''}" data-id="${w.id}">
            ${escapeHtml(w.name)}
            ${state.whiteboards.length > 1 ? '<span class="x" data-x>×</span>' : ''}
          </div>
        `).join('')}
        <button class="btn btn-icon" id="wb-add-tab" title="Nueva pizarra">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
    </div>

    <div class="wb-tools" id="wb-tools"></div>

    <div class="wb-canvas tool-${tool}" id="wb-canvas">
      <svg class="wb-svg" id="wb-svg"></svg>
      <div class="wb-items" id="wb-items"></div>
    </div>

    <div class="wb-status" id="wb-status">
      <span>${itemHint(tool)}</span>
      <span class="wb-status-meta">${(wb.items || []).length} elementos · ${(wb.connectors || []).length} flechas</span>
    </div>
  `;

  paintToolbar(root);
  paintItems(root);
  paintConnectors(root);
  wireTabs(root);
  wireCanvas(root);
  wireKeyboard(root);
};

const itemHint = (t) => ({
  select:    'Click para seleccionar · doble-click sobre canvas para crear post-it · arrastrá para mover · Supr para borrar',
  sticky:    'Click en el canvas para crear un post-it',
  rect:      'Click en el canvas para crear un rectángulo',
  ellipse:   'Click en el canvas para crear una elipse',
  text:      'Click en el canvas para crear texto',
  checklist: 'Click en el canvas para crear una checklist',
  arrow:     connectFromId ? 'Click en otro elemento para conectar (Esc cancela)' : 'Click en un elemento para empezar la flecha',
}[t] || '');

// ----- Toolbar ----------------------------------------------------------

const paintToolbar = (root) => {
  const bar = root.querySelector('#wb-tools');
  if (!bar) return;
  bar.innerHTML = `
    <div class="wb-tool-group" id="wb-tool-group">
      ${TOOLS.map(t => `
        <button class="wb-tool ${tool === t.id ? 'active' : ''}" data-tool="${t.id}" title="${t.label} (${t.hint})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg>
        </button>
      `).join('')}
    </div>
    <div class="wb-tool-sep"></div>
    <div class="wb-color-group" id="wb-color-group">
      ${COLORS.map(c => `
        <button class="wb-color color-${c} ${selectedColor === c ? 'active' : ''}" data-color="${c}" title="${c}"></button>
      `).join('')}
    </div>
    <div class="wb-tool-sep"></div>
    <button class="btn btn-ghost btn-sm" id="wb-clear-sel" ${selectedItemId ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'}>
      ${selectedItemId ? 'Borrar seleccionado (Supr)' : 'Sin selección'}
    </button>
  `;
  bar.querySelector('#wb-tool-group').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) setTool(b.dataset.tool, root);
  });
  bar.querySelector('#wb-color-group').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    selectedColor = b.dataset.color;
    if (selectedItemId) {
      snapshot();
      updateWhiteboardItem(activeId, selectedItemId, { color: selectedColor });
    }
    paint(root);
  });
  bar.querySelector('#wb-clear-sel').addEventListener('click', () => {
    if (!selectedItemId) return;
    snapshot();
    deleteWhiteboardItem(activeId, selectedItemId);
    selectedItemId = null;
    paint(root);
  });
};

// ----- Items render ------------------------------------------------------

const paintItems = (root) => {
  const wb = getActive();
  const layer = root.querySelector('#wb-items');
  if (!wb || !layer) return;
  layer.innerHTML = (wb.items || []).map(renderItem).join('');
  layer.querySelectorAll('.wb-item').forEach(node => wireItem(node, root));
};

const renderItem = (it) => {
  const sel = it.id === selectedItemId ? ' selected' : '';
  const fromMark = it.id === connectFromId ? ' connect-from' : '';
  const cls = `wb-item type-${it.type} color-${escapeHtml(it.color || 'yellow')}${sel}${fromMark}`;
  const style = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px`;
  let body = '';
  if (it.type === 'sticky' || it.type === 'rect' || it.type === 'ellipse') {
    body = `<div class="wb-item-text">${escapeHtml(it.text || '')}</div>`;
  } else if (it.type === 'text') {
    body = `<div class="wb-item-text wb-item-text-plain">${escapeHtml(it.text || 'Texto')}</div>`;
  } else if (it.type === 'checklist') {
    const todos = it.todos || [];
    const done = todos.filter(t => t.done).length;
    body = `
      <div class="wb-checklist-h">
        <div class="wb-checklist-title">${escapeHtml(it.text || 'Checklist')}</div>
        <div class="wb-checklist-counter">${done}/${todos.length}</div>
      </div>
      <div class="wb-checklist-body">
        ${todos.map(t => `
          <label class="wb-todo" data-tid="${escapeHtml(t.id)}">
            <input type="checkbox" ${t.done ? 'checked' : ''} data-toggle>
            <span class="wb-todo-text" contenteditable="true" data-text>${escapeHtml(t.text || '')}</span>
            <button class="wb-todo-x" data-rm title="Borrar">×</button>
          </label>
        `).join('')}
        <button class="wb-todo-add" data-add>+ Agregar</button>
      </div>
    `;
  }
  const handle = RESIZABLE.has(it.type)
    ? '<div class="wb-resize" data-resize title="Redimensionar"></div>'
    : '';
  return `
    <div class="${cls}" data-id="${it.id}" data-type="${it.type}" style="${style}">
      <div class="wb-item-x" data-x title="Borrar">×</div>
      ${body}
      ${handle}
    </div>
  `;
};

// ----- Connectors render -------------------------------------------------

const paintConnectors = (root) => {
  const wb = getActive();
  const svg = root.querySelector('#wb-svg');
  const canvas = root.querySelector('#wb-canvas');
  if (!wb || !svg || !canvas) return;
  // Size SVG to canvas content so the arrows scroll with items.
  const w = Math.max(canvas.scrollWidth, canvas.clientWidth);
  const h = Math.max(canvas.scrollHeight, canvas.clientHeight);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const defs = `
    <defs>
      ${COLORS.concat(['accent']).map(c => `
        <marker id="wb-arrow-${c}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="wb-arrow-head color-${c}"/>
        </marker>
      `).join('')}
    </defs>
  `;
  const paths = (wb.connectors || []).map(conn => {
    const p = connectorPath(wb, conn);
    if (!p) return '';
    const color = conn.color || 'accent';
    const dash = conn.style === 'dashed' ? 'stroke-dasharray:6,5;' : '';
    const labelHtml = conn.label
      ? `<text x="${p.mid.x}" y="${p.mid.y}" class="wb-arrow-label color-${color}" text-anchor="middle" dy="-4">${escapeHtml(conn.label)}</text>`
      : '';
    return `
      <g class="wb-arrow-g" data-cid="${conn.id}">
        <path d="${p.d}" class="wb-arrow-hit" />
        <path d="${p.d}" class="wb-arrow color-${color}" style="${dash}" marker-end="url(#wb-arrow-${color})"/>
        ${labelHtml}
      </g>
    `;
  }).join('');
  svg.innerHTML = defs + paths;

  // Wire arrow click → cycle color on click, dbl-click to label, alt+click to delete.
  svg.querySelectorAll('.wb-arrow-g').forEach(g => {
    const cid = g.dataset.cid;
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.altKey) {
        snapshot();
        deleteWhiteboardConnector(activeId, cid);
        paint(root);
        return;
      }
      const conn = wb.connectors.find(c => c.id === cid);
      if (!conn) return;
      const next = COLORS[(COLORS.indexOf(conn.color) + 1) % COLORS.length];
      snapshot();
      updateWhiteboardConnector(activeId, cid, { color: next });
      paint(root);
    });
    g.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const conn = wb.connectors.find(c => c.id === cid);
      const label = prompt('Etiqueta de la flecha:', conn?.label || '');
      if (label !== null) {
        snapshot();
        updateWhiteboardConnector(activeId, cid, { label });
        paint(root);
      }
    });
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const conn = wb.connectors.find(c => c.id === cid);
      const next = conn.style === 'dashed' ? 'solid' : 'dashed';
      snapshot();
      updateWhiteboardConnector(activeId, cid, { style: next });
      paint(root);
    });
  });
};

// Recompute only the SVG paths affected by an item move — used during drag
// to skip a full re-render and keep the canvas responsive.
const refreshConnectorsFor = (itemId, root) => {
  const wb = getActive();
  if (!wb) return;
  const svg = root.querySelector('#wb-svg');
  if (!svg) return;
  for (const conn of wb.connectors || []) {
    if (conn.from !== itemId && conn.to !== itemId) continue;
    const g = svg.querySelector(`[data-cid="${conn.id}"]`);
    if (!g) continue;
    const p = connectorPath(wb, conn);
    if (!p) continue;
    g.querySelectorAll('path').forEach(path => path.setAttribute('d', p.d));
    const text = g.querySelector('text');
    if (text) { text.setAttribute('x', p.mid.x); text.setAttribute('y', p.mid.y); }
  }
};

// ----- Tabs --------------------------------------------------------------

const wireTabs = (root) => {
  root.querySelector('#wb-tabs').addEventListener('click', (e) => {
    const x = e.target.closest('[data-x]');
    if (x) {
      e.stopPropagation();
      const tab = x.closest('.wb-tab');
      if (state.whiteboards.length > 1 && confirm('¿Eliminar pizarra?')) {
        deleteWhiteboard(tab.dataset.id);
        paint(root);
      }
      return;
    }
    const tab = e.target.closest('.wb-tab');
    if (tab) {
      activeId = tab.dataset.id;
      selectedItemId = null;
      connectFromId = null;
      history.length = 0;
      paint(root);
    }
  });
  root.querySelector('#wb-add-tab').addEventListener('click', () => {
    const name = prompt('Nombre de la pizarra:', 'Nueva pizarra');
    if (!name) return;
    const wb = addWhiteboard({ name });
    activeId = wb.id;
    paint(root);
  });
  root.querySelector('#wb-rename').addEventListener('click', () => {
    const wb = getActive();
    const name = prompt('Nuevo nombre:', wb.name);
    if (name) { updateWhiteboard(activeId, { name }); paint(root); }
  });
  root.querySelector('#wb-delete').addEventListener('click', () => {
    if (state.whiteboards.length === 1) return;
    const wb = getActive();
    if (!confirm(`¿Eliminar "${wb.name}" y todo su contenido?`)) return;
    deleteWhiteboard(activeId);
    activeId = state.whiteboards[0]?.id;
    paint(root);
  });
  root.querySelector('#wb-undo').addEventListener('click', () => undo(root));
};

// ----- Canvas wiring -----------------------------------------------------

const wireCanvas = (root) => {
  const canvas = root.querySelector('#wb-canvas');
  if (!canvas) return;

  // Click on empty canvas → either create a new item (placement tools) or
  // cancel selection (select tool) or cancel arrow start (arrow tool).
  canvas.addEventListener('click', (e) => {
    if (e.target !== canvas && e.target.id !== 'wb-svg' && !e.target.closest('.wb-svg')) return;
    if (tool === 'select') {
      selectedItemId = null;
      paintToolbar(root);
      root.querySelectorAll('.wb-item.selected').forEach(n => n.classList.remove('selected'));
      return;
    }
    if (tool === 'arrow') {
      connectFromId = null;
      paint(root);
      return;
    }
    // Placement tools (sticky/rect/ellipse/text/checklist)
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + canvas.scrollLeft - 60;
    const y = e.clientY - rect.top + canvas.scrollTop - 30;
    snapshot();
    const created = addWhiteboardItem(activeId, {
      type: tool,
      x: Math.max(0, x),
      y: Math.max(0, y),
      color: selectedColor,
      text: tool === 'checklist' ? 'Checklist' : (tool === 'text' ? 'Texto' : ''),
      todos: tool === 'checklist' ? [{ id: uid(), text: 'Item 1', done: false }] : undefined,
    });
    if (created) {
      selectedItemId = created.id;
      setTool('select', root);
      paint(root);
      // Auto-edit text on stickies/rect/ellipse/text
      if (created.type !== 'checklist') {
        const node = root.querySelector(`.wb-item[data-id="${created.id}"] .wb-item-text`);
        if (node) enterEditMode(node, created.id, root);
      }
    }
  });

  // Double-click on empty canvas → quick post-it (regardless of tool)
  canvas.addEventListener('dblclick', (e) => {
    if (e.target !== canvas && !(e.target.closest && e.target.closest('.wb-svg'))) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + canvas.scrollLeft - 80;
    const y = e.clientY - rect.top + canvas.scrollTop - 30;
    snapshot();
    const it = addWhiteboardItem(activeId, { type: 'sticky', x, y, color: selectedColor });
    selectedItemId = it.id;
    paint(root);
    const node = root.querySelector(`.wb-item[data-id="${it.id}"] .wb-item-text`);
    if (node) enterEditMode(node, it.id, root);
  });
};

// ----- Item wiring -------------------------------------------------------

const wireItem = (node, root) => {
  const id = node.dataset.id;
  const type = node.dataset.type;
  const canvas = root.querySelector('#wb-canvas');
  const textNode = node.querySelector('.wb-item-text');

  // Delete (×) — kept on the item for quick removal regardless of tool
  const xBtn = node.querySelector('[data-x]');
  if (xBtn) xBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    snapshot();
    deleteWhiteboardItem(activeId, id);
    if (selectedItemId === id) selectedItemId = null;
    paint(root);
  });

  // Click in arrow mode → start/finish a connection
  node.addEventListener('mousedown', (e) => {
    if (tool !== 'arrow') return;
    if (e.target.closest('[data-x]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!connectFromId) {
      connectFromId = id;
      paint(root);
      return;
    }
    if (connectFromId === id) { connectFromId = null; paint(root); return; }
    snapshot();
    addWhiteboardConnector(activeId, { from: connectFromId, to: id, color: 'accent' });
    connectFromId = null;
    paint(root);
  });

  // Right-click cycles color (same as old behavior). Also exits arrow mode.
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const wb = getActive();
    const it = wb.items.find(x => x.id === id);
    if (!it) return;
    const next = COLORS[(COLORS.indexOf(it.color) + 1) % COLORS.length];
    snapshot();
    updateWhiteboardItem(activeId, id, { color: next });
    paint(root);
  });

  // Text edit on double-click for non-checklist text-bearing types
  if (type !== 'checklist' && textNode) {
    node.addEventListener('dblclick', (e) => {
      if (e.target.closest('.wb-resize')) return;
      e.stopPropagation();
      enterEditMode(textNode, id, root);
    });
  }

  // Checklist interactions
  if (type === 'checklist') {
    node.querySelectorAll('[data-toggle]').forEach(cb => {
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = cb.closest('[data-tid]').dataset.tid;
        const wb = getActive();
        const it = wb.items.find(x => x.id === id);
        const t = (it.todos || []).find(x => x.id === tid);
        if (!t) return;
        snapshot();
        updateWhiteboardItem(activeId, id, {
          todos: it.todos.map(x => x.id === tid ? { ...x, done: !t.done } : x),
        });
        paint(root);
      });
    });
    node.querySelectorAll('[data-rm]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = b.closest('[data-tid]').dataset.tid;
        const wb = getActive();
        const it = wb.items.find(x => x.id === id);
        snapshot();
        updateWhiteboardItem(activeId, id, { todos: (it.todos || []).filter(x => x.id !== tid) });
        paint(root);
      });
    });
    node.querySelectorAll('[data-text]').forEach(span => {
      span.addEventListener('blur', () => {
        const tid = span.closest('[data-tid]').dataset.tid;
        const wb = getActive();
        const it = wb.items.find(x => x.id === id);
        const next = (it.todos || []).map(x => x.id === tid ? { ...x, text: span.textContent } : x);
        updateWhiteboardItem(activeId, id, { todos: next });
      });
      span.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      });
    });
    const titleEl = node.querySelector('.wb-checklist-title');
    if (titleEl) {
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        titleEl.contentEditable = 'true';
        titleEl.focus();
        titleEl.addEventListener('blur', () => {
          titleEl.contentEditable = 'false';
          updateWhiteboardItem(activeId, id, { text: titleEl.textContent });
        }, { once: true });
      });
    }
    const addBtn = node.querySelector('[data-add]');
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wb = getActive();
      const it = wb.items.find(x => x.id === id);
      snapshot();
      const newTodos = (it.todos || []).concat({ id: uid(), text: 'Nuevo', done: false });
      updateWhiteboardItem(activeId, id, { todos: newTodos });
      paint(root);
    });
  }

  // Drag (select tool) — also handles selection on click-without-drag
  let drag = null;
  let startMouse = null;
  const DRAG_THRESHOLD = 4;
  node.addEventListener('mousedown', (e) => {
    if (tool !== 'select') return;
    if (e.target.closest('[data-x]')) return;
    if (e.target.closest('.wb-resize')) return;
    if (e.target.isContentEditable) return;
    if (textNode?.contentEditable === 'true') return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    startMouse = { x: e.clientX, y: e.clientY };
    drag = {
      offX: e.clientX - rect.left + canvas.scrollLeft - parseFloat(node.style.left),
      offY: e.clientY - rect.top + canvas.scrollTop - parseFloat(node.style.top),
      moved: false,
      tookSnapshot: false,
    };
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - startMouse.x) + Math.abs(e.clientY - startMouse.y) < DRAG_THRESHOLD) return;
      drag.moved = true;
      node.classList.add('dragging');
      if (!drag.tookSnapshot) { snapshot(); drag.tookSnapshot = true; }
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left + canvas.scrollLeft - drag.offX);
    const y = Math.max(0, e.clientY - rect.top + canvas.scrollTop - drag.offY);
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    // Live update model so connector recompute reads fresh coords
    const wb = getActive();
    const it = wb.items.find(x => x.id === id);
    if (it) { it.x = x; it.y = y; }
    refreshConnectorsFor(id, root);
  });

  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    startMouse = null;
    node.classList.remove('dragging');
    if (wasDrag) {
      updateWhiteboardItem(activeId, id, {
        x: parseFloat(node.style.left),
        y: parseFloat(node.style.top),
      });
    } else if (tool === 'select') {
      selectedItemId = id;
      paintToolbar(root);
      // Solo toggle de clase — no re-render, asi el dblclick puede dispararse
      root.querySelectorAll('.wb-item').forEach(n => {
        n.classList.toggle('selected', n.dataset.id === id);
      });
    }
  });

  // Resize handle
  const handle = node.querySelector('[data-resize]');
  if (handle) {
    let rs = null;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      snapshot();
      rs = {
        startX: e.clientX, startY: e.clientY,
        w: parseFloat(node.style.width), h: parseFloat(node.style.height),
      };
    });
    document.addEventListener('mousemove', (e) => {
      if (!rs) return;
      const w = Math.max(80, rs.w + (e.clientX - rs.startX));
      const h = Math.max(40, rs.h + (e.clientY - rs.startY));
      node.style.width = w + 'px';
      node.style.height = h + 'px';
      const wb = getActive();
      const it = wb.items.find(x => x.id === id);
      if (it) { it.w = w; it.h = h; }
      refreshConnectorsFor(id, root);
    });
    document.addEventListener('mouseup', () => {
      if (!rs) return;
      updateWhiteboardItem(activeId, id, {
        w: parseFloat(node.style.width),
        h: parseFloat(node.style.height),
      });
      rs = null;
    });
  }
};

// ----- Inline text editing ----------------------------------------------

const enterEditMode = (textNode, id, root) => {
  textNode.contentEditable = 'true';
  textNode.focus();
  const range = document.createRange();
  range.selectNodeContents(textNode);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    textNode.contentEditable = 'false';
    const text = textNode.textContent || '';
    const wb = getActive();
    const it = wb?.items.find(x => x.id === id);
    if (!it) return;
    if (!text.trim() && it.type === 'sticky') {
      // Empty sticky → delete (preserves old behavior).
      deleteWhiteboardItem(activeId, id);
      paint(root);
    } else {
      updateWhiteboardItem(activeId, id, { text });
    }
  };

  textNode.addEventListener('blur', finish, { once: true });
  textNode.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') textNode.blur();
  });
};

// ----- Keyboard ----------------------------------------------------------

let keyboardWired = false;
const wireKeyboard = (root) => {
  if (keyboardWired) return;
  keyboardWired = true;
  document.addEventListener('keydown', (e) => {
    // Only when whiteboard view is mounted and not typing
    if (!document.body.contains(root.querySelector('#wb-canvas'))) return;
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);

    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !typing) {
      e.preventDefault();
      undo(root);
      return;
    }
    if (typing) return;

    if (e.key === 'Escape') {
      if (connectFromId || selectedItemId) {
        connectFromId = null;
        selectedItemId = null;
        paint(root);
      } else if (tool !== 'select') {
        setTool('select', root);
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItemId) {
      e.preventDefault();
      snapshot();
      deleteWhiteboardItem(activeId, selectedItemId);
      selectedItemId = null;
      paint(root);
      return;
    }
    // Tool shortcuts
    const shortcut = { v:'select', s:'sticky', r:'rect', o:'ellipse', t:'text', c:'checklist', a:'arrow' }[e.key.toLowerCase()];
    if (shortcut) {
      e.preventDefault();
      setTool(shortcut, root);
    }
  });
};
