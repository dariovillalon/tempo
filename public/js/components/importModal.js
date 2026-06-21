// importModal.js — wizard for importing project folders from Obsidian
//
// Flow:
//   1. Hits /api/vault/list-projects to discover folders under Projects/.
//   2. User picks which folders to import; each row gets a color swatch.
//   3. Clicking "Importar seleccionados" calls /api/vault/import-projects,
//      which standardizes each folder (writes _index.md/tasks.md/notes/)
//      and returns the parsed projects + tasks for the client to merge.

import { api } from '../api.js';
import { state, PROJECT_COLORS, importProjectsFromVault } from '../state.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { router } from '../router.js';
import { escapeHtml } from '../utils.js';

let scan = null;        // last server response { rootRel, folders: [...] }
let selected = new Map(); // folder -> { folder, name, color }
let rootRel = 'Projects';

const colorAt = (i) => PROJECT_COLORS[i % PROJECT_COLORS.length].value;

const render = () => {
  const body = document.getElementById('import-modal-body');
  if (!body) return;

  if (!state.vault) {
    body.innerHTML = `
      <div class="import-empty">
        <div class="empty-title">No hay vault conectado</div>
        Conectá una carpeta de Obsidian en la vista <strong>Notas</strong> primero.
      </div>`;
    document.getElementById('import-run').disabled = true;
    return;
  }

  if (!scan) {
    body.innerHTML = `
      <div class="import-empty">
        <div class="empty-title">Buscando proyectos…</div>
        <div style="margin-top:8px">Escaneando <code>${escapeHtml(rootRel)}/</code></div>
      </div>`;
    document.getElementById('import-run').disabled = true;
    return;
  }

  if (!scan.folders.length) {
    body.innerHTML = `
      <div class="import-root">
        <span class="label">Carpeta:</span>
        <span class="path">${escapeHtml(scan.rootRel)}/</span>
        <button class="btn btn-ghost btn-sm" id="import-change-root">Cambiar</button>
      </div>
      <div class="import-empty">
        <div class="empty-title">Carpeta vacía</div>
        No hay subcarpetas dentro de <code>${escapeHtml(scan.rootRel)}/</code>.
        Probá con otra ruta — por ejemplo <code>Projects</code>, <code>Areas</code>, o la raíz del vault (vacío).
      </div>`;
    document.getElementById('import-run').disabled = true;
    bindRootChange();
    return;
  }

  body.innerHTML = `
    <div class="import-root">
      <span class="label">Escaneando:</span>
      <span class="path">${escapeHtml(scan.rootRel || '(vault root)')}/</span>
      <button class="btn btn-ghost btn-sm" id="import-change-root">Cambiar carpeta</button>
      <button class="btn btn-ghost btn-sm" id="import-toggle-all">Seleccionar todo</button>
    </div>
    <div class="import-list">
      ${scan.folders.map((f, i) => renderRow(f, i)).join('')}
    </div>
    <div class="text-xs muted" style="margin-top:14px;line-height:1.55">
      Al importar, cada carpeta se estandariza con <code>_index.md</code>,
      <code>tasks.md</code> y <code>notes/</code>. Las tareas existentes se preservan
      y se vuelven a escribir con formato sincronizable. Los proyectos ya vinculados se omiten.
    </div>
  `;

  document.getElementById('import-run').disabled = selected.size === 0;
  bindRootChange();
  bindRows();
  bindToggleAll();
};

const depthOf = (folder) => Math.max(0, (folder || '').split('/').length - 2);

const renderRow = (f, i) => {
  const linkedProject = state.projects.find(p => p.vaultFolder === f.folder);
  const isLinked = !!linkedProject;
  const isSel = selected.has(f.folder);
  const color = isSel ? selected.get(f.folder).color : (f.color || colorAt(i));
  const depth = depthOf(f.folder);
  const indent = depth * 22;

  return `
    <div class="import-row ${isSel ? 'selected' : ''}" data-folder="${escapeHtml(f.folder)}" data-default-color="${escapeHtml(color)}" style="${depth ? `margin-left:${indent}px;border-left:2px solid var(--accent-dim)` : ''}">
      <div class="check" title="Seleccionar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="swatch" style="background:${escapeHtml(color)}" title="Click para cambiar color"></div>
      <div class="info">
        <div class="name">
          ${depth ? '<span class="muted text-xs" style="margin-right:4px">↳</span>' : ''}
          ${escapeHtml(f.name)}
        </div>
        <div class="desc">${escapeHtml(f.description || f.goal || `${f.folder}`)}</div>
      </div>
      <div class="stats">
        ${f.taskCount ? `<span title="tareas">${f.taskCount}t</span>` : ''}
        ${f.noteCount ? `<span title="notas">${f.noteCount}n</span>` : ''}
      </div>
      <div>
        ${isLinked
          ? `<span class="badge-status linked" title="Ya vinculado">vinculado</span>`
          : f.hasIndex
            ? `<span class="badge-status standard" title="Ya tiene formato Tempo">estándar</span>`
            : ''}
      </div>
    </div>
  `;
};

const bindRootChange = () => {
  const btn = document.getElementById('import-change-root');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const next = prompt('Carpeta del vault donde están los proyectos:', rootRel);
    if (next == null) return;
    rootRel = next.replace(/^\/+|\/+$/g, '');
    await refresh();
  });
};

const bindToggleAll = () => {
  const btn = document.getElementById('import-toggle-all');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (selected.size === scan.folders.filter(f => !state.projects.some(p => p.vaultFolder === f.folder)).length) {
      selected.clear();
    } else {
      scan.folders.forEach((f, i) => {
        if (state.projects.some(p => p.vaultFolder === f.folder)) return;
        selected.set(f.folder, {
          folder: f.folder,
          name: f.name,
          color: f.color || colorAt(i),
          parent: f.parent || null,
        });
      });
    }
    render();
  });
};

const childrenOfFolder = (parentFolder) =>
  scan.folders.filter(f => f.parent === parentFolder);

const bindRows = () => {
  document.querySelectorAll('.import-row').forEach((row, i) => {
    const folder = row.dataset.folder;
    const isLinked = state.projects.some(p => p.vaultFolder === folder);

    row.querySelector('.check').addEventListener('click', () => {
      if (isLinked) {
        toast('Ya está vinculado a un proyecto', 'info');
        return;
      }
      if (selected.has(folder)) {
        selected.delete(folder);
        // Cascade-deselect children to keep the wizard intuitive
        for (const child of childrenOfFolder(folder)) {
          selected.delete(child.folder);
        }
      } else {
        const f = scan.folders.find(x => x.folder === folder);
        selected.set(folder, {
          folder,
          name: f.name,
          color: f.color || colorAt(i),
          parent: f.parent || null,
        });
        // Cascade-select children too
        for (const child of childrenOfFolder(folder)) {
          if (state.projects.some(p => p.vaultFolder === child.folder)) continue;
          if (!selected.has(child.folder)) {
            selected.set(child.folder, {
              folder: child.folder,
              name: child.name,
              color: child.color || colorAt(i + 1),
              parent: child.parent || null,
            });
          }
        }
      }
      render();
    });

    row.querySelector('.swatch').addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = selected.get(folder);
      const f = scan.folders.find(x => x.folder === folder);
      const currentColor = cur?.color || row.dataset.defaultColor;
      const idx = PROJECT_COLORS.findIndex(c => c.value === currentColor);
      const next = PROJECT_COLORS[(idx + 1) % PROJECT_COLORS.length].value;
      if (cur) {
        cur.color = next;
      } else if (!isLinked) {
        selected.set(folder, { folder, name: f.name, color: next, parent: f.parent || null });
      }
      render();
    });
  });
};

const refresh = async () => {
  scan = null;
  selected.clear();
  render();
  try {
    scan = await api.listProjects(rootRel);
    render();
  } catch (e) {
    document.getElementById('import-modal-body').innerHTML = `
      <div class="import-empty">
        <div class="empty-title">No pude escanear la carpeta</div>
        <div style="margin-top:6px;color:var(--red)">${escapeHtml(e.message)}</div>
      </div>`;
  }
};

export const openImportModal = async () => {
  selected = new Map();
  rootRel = 'Projects';
  render();
  openModal('modal-import');
  await refresh();
};

export const initImportModal = () => {
  const runBtn = document.getElementById('import-run');
  if (!runBtn) return;
  runBtn.addEventListener('click', async () => {
    if (selected.size === 0) return;
    const items = Array.from(selected.values());
    runBtn.disabled = true;
    runBtn.textContent = 'Importando…';
    try {
      const res = await api.importProjects(items);
      const created = importProjectsFromVault(res.projects || []);
      toast(`${created.projects} proyecto${created.projects === 1 ? '' : 's'} importado${created.projects === 1 ? '' : 's'} · ${created.tasks} tarea${created.tasks === 1 ? '' : 's'}`, 'success');
      closeModal('modal-import');
      router.go('dashboard');
    } catch (e) {
      toast('Error al importar: ' + e.message, 'error');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Importar seleccionados';
    }
  });
};
