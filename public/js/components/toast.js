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

// toast(msg, kind, opts)
//   kind: '' | 'success' | 'error' | 'info'
//   opts.actionLabel + opts.onAction: botón de acción (ej. "Reintentar")
//   opts.duration: ms visible (default 2400)
// Backward compatible: toast(msg) y toast(msg, kind) siguen funcionando igual.
export const toast = (msg, kind = '', opts = {}) => {
  const t = ensure();
  t.textContent = msg;
  if (opts.actionLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      t.classList.remove('show');
      if (typeof opts.onAction === 'function') opts.onAction();
    });
    t.appendChild(btn);
  }
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
  }, opts.duration ?? 2400);
};
