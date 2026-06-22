// notifications.js — alarma (sonido + notificación) 2 min antes de cada reunión
// de la Agenda (bloques locales con kind 'meeting'). El fin de pomodoro avisa aparte.

import { state } from './state.js';

let pollHandle = null;
const fired = new Set(); // fingerprints de reuniones ya avisadas, se limpia a medianoche

const isPermitted = () => 'Notification' in window && Notification.permission === 'granted';

export const requestNotifPermission = async () => {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return await Notification.requestPermission();
};

const todayKeyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Beep de alarma con Web Audio (dos pitidos), sin archivos externos.
let _audioCtx = null;
const playBeep = () => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    [0, 0.32].forEach(t => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      const at = ctx.currentTime + t;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
      o.start(at); o.stop(at + 0.3);
    });
  } catch {}
};

// Margen: ~2 min + un colchón por el poll de 30 s, para no perder la ventana.
const LEAD_MS = 2 * 60 * 1000 + 20 * 1000;

const checkUpcoming = () => {
  if (state.settings?.notifEnabled === false) return;
  const now = Date.now();
  const k = todayKeyLocal();
  for (const b of (state.blocks || [])) {
    if (b.kind !== 'meeting' || b.date !== k || !b.start) continue;
    const [h, m] = b.start.split(':').map(Number);
    if (!Number.isFinite(h)) continue;
    const start = new Date(); start.setHours(h, m || 0, 0, 0);
    const delta = start.getTime() - now;
    if (delta > 0 && delta <= LEAD_MS) {
      const fp = `${b.id}|${b.date}|${b.start}`;
      if (fired.has(fp)) continue;
      fired.add(fp);
      const minLeft = Math.max(1, Math.round(delta / 60000));
      playBeep(); // suena siempre, aunque las notificaciones del navegador no estén permitidas
      if (isPermitted()) {
        try {
          new Notification(`🔔 Reunión en ${minLeft} min — conectate`, {
            body: b.title || 'Reunión',
            tag: fp,
          });
        } catch {}
      }
    }
  }
};

export const startNotifications = () => {
  // Limpiar el set de "ya avisadas" a la medianoche local.
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 2) fired.clear();
  }, 60_000);
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(checkUpcoming, 30_000);
  setTimeout(checkUpcoming, 4_000);
};
