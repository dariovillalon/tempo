// blockModal.js — create/edit calendar block

import { state, addBlock, updateBlock, deleteBlock } from '../state.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { todayKey } from '../utils.js';

let editingId = null;
let editingDate = null;

const fillProjectSelect = () => {
  const sel = document.getElementById('block-project');
  sel.innerHTML = '<option value="">— sin proyecto —</option>' +
    state.projects.filter(p => p.status !== 'archived').map(p => `<option value="${p.id}">${p.name}</option>`).join('');
};

export const openBlockModal = (data = {}) => {
  fillProjectSelect();
  editingId = data.id || null;
  editingDate = data.date || todayKey();

  const b = editingId ? state.blocks.find(x => x.id === editingId) : null;

  document.getElementById('block-modal-title').textContent = b ? 'Editar bloque' : 'Nuevo bloque';
  document.getElementById('block-title').value = b?.title || data.title || '';
  document.getElementById('block-start').value = b?.start || data.start || '';
  document.getElementById('block-end').value = b?.end || data.end || '';
  document.getElementById('block-project').value = b?.projectId || data.projectId || '';
  document.getElementById('block-notes').value = b?.notes || '';
  document.getElementById('block-delete').style.display = b ? '' : 'none';

  if (b) editingDate = b.date;

  openModal('modal-block');
};

export const initBlockModal = () => {
  document.getElementById('block-save').addEventListener('click', () => {
    const data = {
      title: document.getElementById('block-title').value.trim(),
      start: document.getElementById('block-start').value,
      end: document.getElementById('block-end').value,
      projectId: document.getElementById('block-project').value || null,
      notes: document.getElementById('block-notes').value.trim(),
      date: editingDate,
    };
    if (!data.title) { toast('Falta el título', 'error'); return; }
    if (!data.start || !data.end) { toast('Faltan los horarios', 'error'); return; }
    if (data.end <= data.start) { toast('Fin debe ser después de Inicio', 'error'); return; }
    if (editingId) {
      updateBlock(editingId, data);
      toast('Bloque actualizado');
    } else {
      addBlock(data);
      toast('Bloque creado', 'success');
    }
    closeModal('modal-block');
  });
  document.getElementById('block-delete').addEventListener('click', () => {
    if (!editingId) return;
    if (!confirm('¿Eliminar este bloque?')) return;
    deleteBlock(editingId);
    closeModal('modal-block');
    toast('Bloque eliminado');
  });
};
