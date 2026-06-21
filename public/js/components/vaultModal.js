// vaultModal.js — connect / inspect Obsidian vault

import { api } from '../api.js';
import { state, setVault } from '../state.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { router } from '../router.js';
import { escapeHtml } from '../utils.js';
import { openImportModal } from './importModal.js';

let manualPath = '';
let suggestions = [];
let chosenPath = '';

const renderBody = () => {
  const body = document.getElementById('vault-modal-body');
  const v = state.vault;

  let html = '';

  if (v && v.path) {
    html += `
      <div class="vault-current">
        <div class="label">Actualmente conectado</div>
        <div class="path">${escapeHtml(v.path)}</div>
        <div class="stats">
          <div><strong>${v.notes ?? 0}</strong> notas</div>
          <div><strong>${v.files ?? 0}</strong> archivos</div>
          <div><strong>${v.folders ?? 0}</strong> carpetas</div>
        </div>
      </div>
    `;
  }

  html += `<div class="field"><label>Sugerencias</label></div>`;

  if (suggestions.length === 0) {
    html += `<div class="empty" style="padding:14px">Buscando carpetas de Obsidian...</div>`;
  } else {
    html += `<div class="vault-suggestions">`;
    for (const s of suggestions) {
      html += `
        <div class="vault-suggestion ${s.path === chosenPath ? 'selected' : ''}" data-path="${escapeHtml(s.path)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <div style="flex:1;min-width:0">
            <div class="label">${escapeHtml(s.label)}</div>
            <div class="path">${escapeHtml(s.path)}</div>
          </div>
          ${s.isObsidianVault ? '<span class="obs">Obsidian</span>' : ''}
        </div>
      `;
    }
    html += `</div>`;
  }

  html += `
    <div class="vault-manual">
      <label>O pegá la ruta manualmente</label>
      <input class="input" id="vault-manual-input" placeholder="/Users/tu-user/Obsidian Vault" value="${escapeHtml(manualPath)}">
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">
        Tip: en Obsidian, abrí "Show in Finder" sobre cualquier carpeta del vault y copiá la ruta.
      </div>
    </div>
  `;

  body.innerHTML = html;

  body.querySelectorAll('.vault-suggestion').forEach(node => {
    node.addEventListener('click', () => {
      chosenPath = node.dataset.path;
      manualPath = '';
      renderBody();
    });
  });

  const manualInput = document.getElementById('vault-manual-input');
  if (manualInput) {
    manualInput.addEventListener('input', (e) => {
      manualPath = e.target.value;
      chosenPath = '';
      // re-highlight
      body.querySelectorAll('.vault-suggestion').forEach(n => n.classList.remove('selected'));
    });
  }
};

export const openVaultModal = async () => {
  manualPath = '';
  chosenPath = state.vault?.path || '';
  suggestions = [];
  openModal('modal-vault');
  renderBody();
  try {
    const res = await api.suggestVaults();
    suggestions = res.suggestions || [];
    if (!chosenPath && suggestions[0]) chosenPath = suggestions[0].path;
    renderBody();
  } catch (e) {
    toast('No pude buscar vaults: ' + e.message, 'error');
  }
};

export const initVaultModal = () => {
  document.getElementById('vault-connect').addEventListener('click', async () => {
    const target = manualPath.trim() || chosenPath;
    if (!target) { toast('Elegí o escribí una ruta', 'error'); return; }
    try {
      const res = await api.connectVault(target);
      if (res.error) { toast(res.error, 'error'); return; }
      setVault(res.vault);
      toast(`Vault conectado · ${res.vault.notes} notas`, 'success');
      closeModal('modal-vault');
      // refresh notes view if open
      if (router.current() === 'notes') router.refresh();

      // If the vault has Projects/ folders not yet linked, open the import wizard
      // so the user can pull them into Tempo (names, descriptions, tasks).
      try {
        const probe = await api.listProjects('Projects').catch(() => null);
        const folders = probe?.folders || [];
        const unlinked = folders.filter(f =>
          !state.projects.some(p => p.vaultFolder === f.folder));
        if (unlinked.length) {
          setTimeout(() => openImportModal(), 220);
        }
      } catch {}
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  });
};
