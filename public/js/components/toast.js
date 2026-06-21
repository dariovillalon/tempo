// toast.js — bottom-center notification

let toastEl = null;
let toastTimer = null;

const ensure = () => {
  if (toastEl) return toastEl;
  toastEl = document.getElementById('toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.id = 'toast';
    document.body.appendChild(toastEl);
  }
  return toastEl;
};

export const toast = (msg, kind = '') => {
  const t = ensure();
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
  }, 2400);
};
