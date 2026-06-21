// vaultFolderPicker.js — pick a folder inside the connected vault.
//
// Usage: pickVaultFolder({ initial }) → Promise<string|null>

import { api } from '../api.js';
import { state } from '../state.js';
import { openModal, closeModal } from './modal.js';
import { escapeHtml } from '../utils.js';

let resolver = null;
let chosen = null;
let tree = null;
let expanded = new Set(['']); // relative paths that are expanded; '' = root

const renderNode = (node, depth = 0) => {
  if (node.kind === 'file') return ''; // folder picker = directories only
  const path = node.path || '';
  const isOpen = expanded.has(path);
  const isSel = chosen === path;
  const childDirs = (node.children || []).filter(c => c.kind === 'dir' || c.kind === 'directory');
  const arrow = childDirs.length ? (isOpen ? '▾' : '▸') : '·';
  const prefix = '  '.repeat(depth);

  let html = `
    <div class="vault-folder-node ${isSel ? 'selected' : ''}"
         data-path="${escapeHtml(path)}"
         style="padding-left:${depth * 14 + 6}px">
      <span class="twist">${arrow}</span>
      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>${escapeHtml(node.name || '(vault)')}</span>
    </div>`;

  if (isOpen && childDirs.length) {
    html += childDirs.map(c => renderNode(c, depth + 1)).join('');
  }
  return html;
};

const render = () => {
  const body = document.getElementById('vault-folder-body');
  if (!body) return;

  if (!state.vault) {
    body.innerHTML = `
      <div class="import-empty">
        <div class="empty-title">No hay vault conectado</div>
        Conectá una carpeta de Obsidian primero (vista Notas).
      </div>`;
    return;
  }

  if (!tree) {
    body.innerHTML = `<div class="import-empty">Cargando árbol del vault…</div>`;
    return;
  }

  body.innerHTML = `
    <div class="text-xs muted" style="margin-bottom:10px">
      Carpeta seleccionada: <code style="font-family:var(--font-mono)">${escapeHtml(chosen ?? '(ninguna)')}</code>
    </div>
    <div class="vault-folder-tree">${renderNode(tree)}</div>
  `;

  body.querySelectorAll('.vault-folder-node').forEach(node => {
    const p = node.dataset.path;
    node.addEventListener('click', (e) => {
      // Toggle expand on twist click; otherwise just select.
      const twist = e.target.closest('.twist');
      if (twist || e.metaKey) {
        if (expanded.has(p)) expanded.delete(p);
        else expanded.add(p);
      } else {
        chosen = p;
      }
      render();
      document.getElementById('vault-folder-pick').disabled = chosen === null;
    });
  });
};

export const pickVaultFolder = ({ initial = null } = {}) => {
  return new Promise(async (resolve) => {
    resolver = resolve;
    chosen = initial;
    tree = null;
    expanded = new Set(['']);
    if (initial) {
      // Expand all parents of the initial selection so it's visible
      let cur = '';
      for (const seg of initial.split('/')) {
        cur = cur ? cur + '/' + seg : seg;
        expanded.add(cur);
      }
    }
    render();
    openModal('modal-vault-folder');
    document.getElementById('vault-folder-pick').disabled = !initial;

    try {
      const data = await api.getVaultTree();
      if (data.connected) tree = data.tree;
      render();
      document.getElementById('vault-folder-pick').disabled = chosen === null;
    } catch (e) {
      console.error(e);
    }
  });
};

export const initVaultFolderPicker = () => {
  const modal = document.getElementById('modal-vault-folder');
  if (!modal) return;
  document.getElementById('vault-folder-pick').addEventListener('click', () => {
    closeModal('modal-vault-folder');
    if (resolver) resolver(chosen);
    resolver = null;
  });
  // If user closes via backdrop/Esc, resolve null
  modal.addEventListener('transitionend', () => {});
  const observer = new MutationObserver(() => {
    if (!modal.classList.contains('open') && resolver) {
      resolver(null);
      resolver = null;
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
};
