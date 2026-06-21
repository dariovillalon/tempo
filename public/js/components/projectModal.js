// projectModal.js — create/edit project

import {
  state, addProject, updateProject, deleteProject, findProject,
  PROJECT_COLORS, tasksForProject,
} from '../state.js';
import { api } from '../api.js';
import { openModal, closeModal } from './modal.js';
import { pickVaultFolder } from './vaultFolderPicker.js';
import { toast } from './toast.js';
import { router } from '../router.js';
import { escapeHtml } from '../utils.js';
import { openImportModal } from './importModal.js';

let editingId = null;
let currentVaultFolder = null;

// Recursos: una línea por entrada. Acepta "https://url" o "[Label](https://url)".
const parseResourcesText = (raw) => {
  const out = [];
  for (const lineRaw of (raw || '').split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    const md = line.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/);
    if (md) { out.push({ url: md[2].trim(), label: md[1].trim() }); continue; }
    const url = line.match(/(https?:\/\/\S+)/);
    if (url) out.push({ url: url[1].trim(), label: null });
  }
  return out;
};

const resourcesToText = (arr) =>
  (arr || []).map(r => r.label ? `[${r.label}](${r.url})` : r.url).join('\n');

const renderSwatches = (selected) => {
  const root = document.getElementById('project-swatches');
  root.innerHTML = PROJECT_COLORS.map(c => `
    <div class="color-swatch ${c.value === selected ? 'selected' : ''}"
         data-color="${c.value}"
         style="background:${c.value}" title="${c.name}"></div>
  `).join('');
  let chosen = selected || PROJECT_COLORS[0].value;
  root.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      root.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('selected'));
      sw.classList.add('selected');
      chosen = sw.dataset.color;
    });
  });
  return () => chosen;
};

let getColor = () => PROJECT_COLORS[0].value;

const setVaultFolderUI = (folder) => {
  currentVaultFolder = folder || null;
  document.getElementById('project-vault-folder').value = currentVaultFolder || '';
  document.getElementById('project-vault-clear').style.display = currentVaultFolder ? '' : 'none';
  document.getElementById('project-vault-sync').style.display = currentVaultFolder && editingId ? '' : 'none';
};

export const openProjectModal = (id = null) => {
  editingId = id;
  const p = id ? findProject(id) : null;

  document.getElementById('project-modal-title').textContent = p ? 'Editar proyecto' : 'Nuevo proyecto';
  document.getElementById('project-name').value = p?.name || '';
  document.getElementById('project-description').value = p?.description || '';
  document.getElementById('project-goal').value = p?.goal || '';
  document.getElementById('project-resources').value = resourcesToText(p?.resources || []);
  document.getElementById('project-status').value = p?.status || 'active';
  document.getElementById('project-health').value = p?.health || 'on-track';
  document.getElementById('project-delete').style.display = p ? '' : 'none';

  // Parent select — exclude self and descendants to avoid cycles
  const parentSel = document.getElementById('project-parent');
  if (parentSel) {
    const forbidden = new Set();
    if (p) {
      const collect = (pid) => {
        forbidden.add(pid);
        for (const c of state.projects.filter(x => x.parentId === pid)) collect(c.id);
      };
      collect(p.id);
    }
    const opts = state.projects
      .filter(x => x.status !== 'archived' && !forbidden.has(x.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(x => `<option value="${x.id}" ${p?.parentId === x.id ? 'selected' : ''}>${escapeHtml(x.name)}</option>`)
      .join('');
    parentSel.innerHTML = `<option value="">— Ninguno (proyecto raíz) —</option>${opts}`;
  }

  getColor = renderSwatches(p?.color);
  setVaultFolderUI(p?.vaultFolder);
  openModal('modal-project');
};

export const initProjectModal = () => {
  document.getElementById('add-project-btn').addEventListener('click', () => openProjectModal());
  document.getElementById('project-save').addEventListener('click', () => {
    const data = {
      name: document.getElementById('project-name').value.trim(),
      description: document.getElementById('project-description').value.trim(),
      goal: document.getElementById('project-goal').value.trim(),
      resources: parseResourcesText(document.getElementById('project-resources').value),
      status: document.getElementById('project-status').value,
      health: document.getElementById('project-health').value,
      color: getColor(),
      vaultFolder: currentVaultFolder || null,
      parentId: document.getElementById('project-parent')?.value || null,
    };
    if (!data.name) { toast('Falta el nombre', 'error'); return; }
    if (editingId) {
      updateProject(editingId, data);
      toast('Proyecto actualizado', 'success');
    } else {
      const p = addProject(data);
      toast('Proyecto creado', 'success');
      closeModal('modal-project');
      setTimeout(() => router.go(`project/${p.id}`), 60);
      return;
    }
    closeModal('modal-project');
  });
  document.getElementById('project-delete').addEventListener('click', () => {
    if (!editingId) return;
    if (!confirm('¿Eliminar este proyecto y todo su contenido?')) return;
    deleteProject(editingId);
    closeModal('modal-project');
    toast('Proyecto eliminado');
    router.go('dashboard');
  });

  // Vault folder picker
  document.getElementById('project-vault-pick').addEventListener('click', async () => {
    if (!state.vault) {
      toast('Conectá un vault de Obsidian primero (vista Notas)', 'info');
      return;
    }
    const picked = await pickVaultFolder({ initial: currentVaultFolder });
    if (picked !== null) setVaultFolderUI(picked);
  });
  document.getElementById('project-vault-clear').addEventListener('click', () => {
    setVaultFolderUI(null);
  });
  document.getElementById('project-vault-sync').addEventListener('click', async () => {
    if (!editingId || !currentVaultFolder) return;
    const project = findProject(editingId);
    if (!project) return;
    const btn = document.getElementById('project-vault-sync');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Sincronizando…';
    try {
      // Standardize first (creates files if missing) then write current tasks
      await api.standardizeProject({
        folder: currentVaultFolder,
        name: project.name,
        color: project.color,
        status: project.status,
        health: project.health,
        goal: project.goal,
        description: project.description,
      });
      await api.syncTasks(currentVaultFolder, project.name, tasksForProject(editingId));
      toast('Sincronizado a Obsidian', 'success');
    } catch (e) {
      toast('Error al sincronizar: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
};

// Sidebar render — collapsible tree (roots shown; expand to see subprojects)
const expandedRoots = new Set();
export const expandSidebarProject = (id) => { expandedRoots.add(id); renderSidebarProjects(); };

export const renderSidebarProjects = () => {
  const list = document.getElementById('projects-list');
  if (!list) return;
  const projs = state.projects.filter(p => p.status !== 'archived');

  const byParent = new Map();
  for (const p of projs) {
    const pid = p.parentId || null;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(p);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

  const renderPill = (p, depth) => {
    const kids = byParent.get(p.id) || [];
    const hasKids = kids.length > 0;
    const open = expandedRoots.has(p.id);
    const indent = depth * 14;
    return `
      <div class="project-pill ${p.status === 'archived' ? 'archived' : ''}" data-id="${p.id}" style="${depth ? `padding-left:${10 + indent}px` : ''}">
        ${hasKids
          ? `<button class="proj-toggle" data-toggle="${p.id}" title="${open ? 'Colapsar' : 'Expandir'}">
               <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${open ? 90 : 0}deg);transition:transform 0.12s ease"><polyline points="9 18 15 12 9 6"/></svg>
             </button>`
          : (depth ? '<span class="proj-toggle-spacer"></span>' : '<span class="proj-toggle-spacer"></span>')}
        <span class="dot" style="background:${escapeHtml(p.color)}"></span>
        <span class="name">${escapeHtml(p.name)}</span>
        ${hasKids ? `<span class="proj-count">${kids.length}</span>` : ''}
        <span class="health ${escapeHtml(p.health || 'on-track')}" title="${escapeHtml(p.health || 'on-track')}"></span>
      </div>
      ${hasKids && open ? kids.map(k => renderPill(k, depth + 1)).join('') : ''}
    `;
  };
  let html = (byParent.get(null) || []).map(p => renderPill(p, 0)).join('');

  // CTA: empty + vault connected → offer import
  if (projs.length === 0) {
    if (state.vault?.path) {
      html += `
        <button class="sidebar-cta" id="sidebar-import-cta">
          ↓ Importar de Obsidian
        </button>
        <div class="muted text-xs" style="padding:6px 10px;line-height:1.4">
          Importá las carpetas en <code>Projects/</code> como proyectos Tempo.
        </div>
      `;
    } else {
      html += `<div class="muted text-xs" style="padding:6px 10px;line-height:1.4">Conectá Obsidian (Notas → Conectar carpeta) e importá tus proyectos.</div>`;
    }
  }

  list.innerHTML = html;
  // Toggle expand/collapse
  list.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggle;
      if (expandedRoots.has(id)) expandedRoots.delete(id);
      else expandedRoots.add(id);
      renderSidebarProjects();
    });
  });
  // Open project on click (anywhere except the toggle)
  list.querySelectorAll('.project-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      if (e.target.closest('[data-toggle]')) return;
      router.go(`project/${pill.dataset.id}`);
    });
  });
  const cta = list.querySelector('#sidebar-import-cta');
  if (cta) cta.addEventListener('click', () => openImportModal());
};
