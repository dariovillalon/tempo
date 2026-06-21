// notifications.js — desktop notifications for upcoming meetings.
// Pomodoro end already fires its own notification from the timer module.

import { state } from './state.js';
import { api } from './api.js';

let pollHandle = null;
const fired = new Set(); // event uid|start fingerprints, cleared at midnight

const fingerprint = (ev) => `${ev.uid || ev.summary}|${ev.start}`;

const isPermitted = () => 'Notification' in window && Notification.permission === 'granted';

export const requestNotifPermission = async () => {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return await Notification.requestPermission();
};

const checkUpcoming = async () => {
  if (!isPermitted()) return;
  if (!state.settings?.notifEnabled) return;
  const lead = (state.settings?.notifLeadMin ?? 5) * 60 * 1000;
  const now = Date.now();
  try {
    const from = new Date(); from.setHours(0,0,0,0);
    const to = new Date(from); to.setDate(to.getDate() + 1);
    const res = await api.getCalendarEvents(from.toISOString(), to.toISOString());
    if (!res.connected) return;
    for (const ev of (res.events || [])) {
      if (ev.allDay) continue;
      const startMs = new Date(ev.start).getTime();
      const delta = startMs - now;
      if (delta > 0 && delta <= lead) {
        const fp = fingerprint(ev);
        if (fired.has(fp)) continue;
        fired.add(fp);
        const minLeft = Math.max(1, Math.round(delta / 60000));
        try {
          new Notification(`Reunión en ${minLeft} min`, {
            body: `${ev.summary}${ev.location ? ' · ' + ev.location : ''}`,
            tag: fp,
          });
        } catch {}
      }
    }
  } catch {}
};

export const startNotifications = () => {
  // Reset the "already fired" set at local midnight so tomorrow's events fire
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 2) fired.clear();
  }, 60_000);
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(checkUpcoming, 30_000);
  // Run once shortly after boot
  setTimeout(checkUpcoming, 4_000);
};
