// notes.js — Obsidian vault explorer with inline markdown editor (autosave)

import { state } from '../state.js';
import { api } from '../api.js';
import { escapeHtml, debounce } from '../utils.js';
import { openVaultModal } from '../components/vaultModal.js';
import { openImportModal } from '../components/importModal.js';
import { toast } from '../components/toast.js';

let vaultTree = null;
let openFolders = new Set();
let selectedPath = null;
let selectedContent = null;
let editing = false;
let dirty = false;

const isMd = (name = '') => /\.(md|markdown|mdx|txt)$/i.test(name);

const loadVault = async () => {
  try {
    const res = await api.getVaultTree();
    vaultTree = res.tree;
  } catch (e) {
    toast('No pude leer el vault: ' + e.message, 'error');
  }
};

export const renderNotes = (root) => {
  // Pickup from quick capture's full-text search: jump to a specific file
  const pending = window.__pendingVaultPath;
  if (pending) {
    delete window.__pendingVaultPath;
    selectedPath = pending;
    selectedContent = null;
    // expand all parent folders so the file is visible in the tree
    const parts = pending.split('/').slice(0, -1);
    let acc = '';
    for (const p of parts) { acc = acc ? acc + '/' + p : p; openFolders.add(acc); }
  }
  paint(root);
  if (state.vault?.path && !vaultTree) loadVault().then(() => paint(root));
  if (pending) {
    api.getVaultFile(pending).then(r => { selectedContent = r.content; paint(root); }).catch(() => {});
  }
};

export const resetNotesCache = () => {
  vaultTree = null;
  selectedPath = null;
  selectedContent = null;
  editing = false;
  dirty = false;
  openFolders = new Set();
};

const paint = (root) => {
  if (!state.vault?.path) {
    root.innerHTML = `
      <div class="empty" style="padding:60px 20px;max-width:520px;margin:60px auto">
        <div class="empty-title">Conectá tu carpeta de Obsidian</div>
        <div style="margin:10px 0;line-height:1.6">
          Tempo se sincroniza con Obsidian: tus carpetas en <code>Projects/</code> se
          importan como proyectos y todas las notas, tareas y recursos viven en tu vault.
        </div>
        <button class="btn btn-primary" id="connect-vault-btn" style="margin-top:14px">Conectar carpeta</button>
      </div>
    `;
    root.querySelector('#connect-vault-btn').addEventListener('click', openVaultModal);
    return;
  }

  root.innerHTML = `
    <div class="view-h">
      <div>
        <h2 style="margin-bottom:2px">${escapeHtml(state.vault?.name || 'Vault')}</h2>
        <div style="font-size:11.5px;color:var(--text-3);font-family:var(--font-mono)">${escapeHtml(state.vault?.path || '')}</div>
      </div>
      <div class="view-h-actions">
        <button class="btn btn-secondary btn-sm" id="import-projects">↓ Importar Projects/ a Tempo</button>
        <button class="btn btn-ghost btn-sm" id="reload-tree">Actualizar</button>
        <button class="btn btn-ghost btn-sm" id="change-vault">Cambiar carpeta</button>
      </div>
    </div>

    <div class="notes-layout">
      <aside class="notes-sidebar">
        <div class="notes-sidebar-h">
          <span>Archivos</span>
          <span class="muted text-xs">${state.vault?.notes ?? 0} notas</span>
        </div>
        ${vaultTree
          ? renderTree(vaultTree, 0)
          : '<div class="notes-empty"><div class="spinner" style="margin:0 auto 10px"></div>Cargando…</div>'}
      </aside>
      <section class="note-viewer" id="note-viewer">
        ${renderViewer()}
      </section>
    </div>
  `;

  root.querySelector('#reload-tree').addEventListener('click', async () => {
    vaultTree = null;
    paint(root);
    await loadVault();
    paint(root);
  });
  root.querySelector('#change-vault').addEventListener('click', openVaultModal);
  root.querySelector('#import-projects').addEventListener('click', () => openImportModal());

  root.querySelectorAll('.tree-node').forEach(node => {
    node.addEventListener('click', () => {
      const p = node.dataset.path;
      const k = node.dataset.kind;
      if (k === 'dir') {
        if (openFolders.has(p)) openFolders.delete(p); else openFolders.add(p);
        paint(root);
      } else {
        selectFile(p, root);
      }
    });
  });

  wireViewer(root);
};

const renderTree = (node, depth) => {
  if (node.kind === 'root') return (node.children || []).map(c => renderTree(c, 0)).join('');
  if (node.kind === 'dir') {
    const open = openFolders.has(node.path);
    return `
      <div class="tree-node" data-path="${escapeHtml(node.path)}" data-kind="dir" style="padding-left:${8 + depth * 12}px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${open ? 90 : 0}deg);transition:transform 0.15s ease"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="name">${escapeHtml(node.name)}</span>
      </div>
      ${open ? `<div class="tree-children">${(node.children || []).map(c => renderTree(c, depth + 1)).join('')}</div>` : ''}
    `;
  }
  const md = isMd(node.name);
  const active = selectedPath === node.path;
  return `
    <div class="tree-node ${active ? 'active' : ''}" data-path="${escapeHtml(node.path)}" data-kind="file" style="padding-left:${8 + depth * 12 + 13}px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:${md ? 1 : 0.5}"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="name">${escapeHtml(node.name)}</span>
    </div>
  `;
};

const selectFile = async (path, root) => {
  if (dirty && !confirm('Tenés cambios sin guardar. ¿Descartar?')) return;
  selectedPath = path;
  selectedContent = null;
  editing = false;
  dirty = false;
  paint(root);
  try {
    const res = await api.getVaultFile(path);
    selectedContent = res.content;
    paint(root);
  } catch (e) {
    toast('No pude leer: ' + e.message, 'error');
    selectedContent = '_Error al leer el archivo._';
    paint(root);
  }
};

const renderViewer = () => {
  if (!selectedPath) {
    return `
      <div class="note-viewer-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;color:var(--text-4)"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <div>Elegí un archivo a la izquierda.</div>
      </div>
    `;
  }
  const name = selectedPath.split('/').pop();
  const dir = selectedPath.split('/').slice(0, -1).join('/');
  const renderMd = isMd(name);

  let body;
  if (selectedContent === null) {
    body = `<div style="text-align:center;padding:40px"><div class="spinner" style="margin:0 auto"></div></div>`;
  } else if (editing) {
    body = `<textarea id="note-editor" class="note-editor" spellcheck="false">${escapeHtml(selectedContent)}</textarea>`;
  } else if (renderMd && window.marked) {
    try {
      body = `<div class="note-content">${window.marked.parse(selectedContent)}</div>`;
    } catch {
      body = `<pre class="note-content">${escapeHtml(selectedContent)}</pre>`;
    }
  } else {
    body = `<pre class="note-content" style="white-space:pre-wrap">${escapeHtml(selectedContent)}</pre>`;
  }

  return `
    <div class="note-viewer-h">
      <span class="name">${escapeHtml(name)}</span>
      <span class="path">${escapeHtml(dir)}</span>
      <button class="btn btn-ghost btn-sm" id="note-toggle-edit">${editing ? 'Vista previa' : 'Editar'}</button>
      ${editing ? `<button class="btn btn-primary btn-sm" id="note-save">${dirty ? 'Guardar' : 'Guardado'}</button>` : ''}
    </div>
    <div class="note-viewer-body">${body}</div>
  `;
};

const wireViewer = (root) => {
  const toggle = root.querySelector('#note-toggle-edit');
  if (toggle) toggle.addEventListener('click', () => { editing = !editing; paint(root); });

  const editor = root.querySelector('#note-editor');
  const autosave = debounce(async () => {
    if (!selectedPath) return;
    try {
      await api.saveVaultFile(selectedPath, editor.value);
      selectedContent = editor.value;
      dirty = false;
      const sb = root.querySelector('#note-save');
      if (sb) sb.textContent = 'Guardado';
    } catch (e) {
      toast('Error al guardar: ' + e.message, 'error');
    }
  }, 700);

  if (editor) {
    editor.addEventListener('input', () => {
      dirty = true;
      const sb = root.querySelector('#note-save');
      if (sb) sb.textContent = 'Guardar…';
      autosave();
    });
  }
  const saveBtn = root.querySelector('#note-save');
  if (saveBtn) saveBtn.addEventListener('click', () => autosave());
};
