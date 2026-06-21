// modal.js — open/close helpers shared by all modals

export const openModal = (id) => {
  const m = typeof id === 'string' ? document.getElementById(id) : id;
  if (!m) return;
  m.classList.add('open');
  // Auto-focus first input
  setTimeout(() => {
    const focusable = m.querySelector('input, textarea, select');
    if (focusable) focusable.focus();
  }, 50);
};

export const closeModal = (id) => {
  const m = typeof id === 'string' ? document.getElementById(id) : id;
  if (!m) return;
  m.classList.remove('open');
};

export const closeAllModals = () => {
  document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
};

// Wire up generic close behaviors (backdrop click + [data-close-modal] buttons)
export const initModals = () => {
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('open');
    });
  });
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const m = e.target.closest('.modal-backdrop');
      if (m) m.classList.remove('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });
};
