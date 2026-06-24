// state.js — single source of truth, persisted to the server

import { api } from './api.js';
import { uid, todayKey, debounce, addDays, fromKey } from './utils.js';

// Compute the next due date for a recurring task once it's marked done.
// Recurrence is stored as a compact string for round-tripping in markdown:
//   'daily'             → every day
//   'weekdays'          → Mon-Fri only
//   'weekly:MO,WE,FR'   → specific weekdays
//   'monthly:15'        → day 15 of the month
const DAY_CODES = { 0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA' };
const CODE_DAYS = Object.fromEntries(Object.entries(DAY_CODES).map(([n, c]) => [c, +n]));
const computeNextDue = (task) => {
  const r = task.recurrence;
  if (!r) return null;
  const base = task.due ? fromKey(task.due) : new Date();
  base.setHours(0, 0, 0, 0);
  if (r === 'daily') return todayKey(addDays(base, 1));
  if (r === 'weekdays') {
    let d = addDays(base, 1);
    while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
    return todayKey(d);
  }
  if (r.startsWith('weekly:')) {
    const days = r.slice(7).split(',').map(c => CODE_DAYS[c]).filter(n => n != null);
    if (!days.length) return null;
    let d = addDays(base, 1);
    let safety = 0;
    while (!days.includes(d.getDay()) && safety++ < 14) d = addDays(d, 1);
    return todayKey(d);
  }
  if (r.startsWith('monthly:')) {
    const dom = parseInt(r.slice(8), 10);
    const next = new Date(base.getFullYear(), base.getMonth() + 1, Math.min(28, dom));
    return todayKey(next);
  }
  return null;
};

const subs = new Set();
let saveStatus = 'idle'; // idle | saving | saved | error

export const PROJECT_COLORS = [
  { name: 'amber',  value: '#f0b952' },
  { name: 'green',  value: '#6ec18a' },
  { name: 'blue',   value: '#6aa9ed' },
  { name: 'red',    value: '#e26b6b' },
  { name: 'orange', value: '#e09454' },
  { name: 'violet', value: '#b598e8' },
  { name: 'pink',   value: '#e285b5' },
  { name: 'teal',   value: '#6cc9bb' },
];

export const TASK_STATES = [
  { id: 'inbox',    label: 'Inbox' },
  { id: 'todo',     label: 'Por hacer' },
  { id: 'doing',    label: 'En curso' },
  { id: 'waiting',  label: 'Esperando' },
  { id: 'done',     label: 'Hecho' },
];

// Personas asignables a tareas. Defaults seedeados; el usuario los edita en Ajustes.
const DEFAULT_ASSIGNEES = [
  { id: 'Dario',  label: 'Dario',  initials: 'D', color: '#6aa9ed' },
  { id: 'Mariel', label: 'Mariel', initials: 'M', color: '#e285b5' },
  { id: 'Nico',   label: 'Nico',   initials: 'N', color: '#6ec18a' },
  { id: 'Kevin',  label: 'Kevin',  initials: 'K', color: '#e09454' },
];

export const getAssignees = () =>
  Array.isArray(state.settings?.assignees) && state.settings.assignees.length
    ? state.settings.assignees
    : DEFAULT_ASSIGNEES;

const initialsFor = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

export const addAssignee = ({ label, color }) => {
  const name = (label || '').trim();
  if (!name) return null;
  let added = null;
  mutate(s => {
    s.settings.assignees ||= DEFAULT_ASSIGNEES.slice();
    if (s.settings.assignees.find(a => a.id.toLowerCase() === name.toLowerCase())) return;
    added = { id: name, label: name, initials: initialsFor(name), color: color || '#8a8a8a' };
    s.settings.assignees.push(added);
  });
  return added;
};

export const updateAssignee = (id, patch) => {
  mutate(s => {
    s.settings.assignees ||= DEFAULT_ASSIGNEES.slice();
    const a = s.settings.assignees.find(x => x.id === id);
    if (!a) return;
    if (patch.label) {
      a.label = patch.label.trim();
      a.initials = initialsFor(a.label);
    }
    if (patch.color) a.color = patch.color;
  });
};

export const removeAssignee = (id) => {
  mutate(s => {
    s.settings.assignees ||= DEFAULT_ASSIGNEES.slice();
    s.settings.assignees = s.settings.assignees.filter(a => a.id !== id);
    // Limpiar tareas que tenían este asignado
    for (const t of s.tasks) if (t.assignee === id) t.assignee = null;
  });
};

// ----- Fitness (nutrición, peso, gym) -----
export const ACTIVITY_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very: 1.9 };

export const defaultFitnessPlan = () => ({
  name: 'Upper/Lower 4 días — masa + tenis',
  note: 'Volviendo tras parar: arrancá con pesos cómodos (RIR 2–3) y subí de a poco semana a semana. Cuidá la zona lumbar en sentadilla y peso muerto (empezá liviano y priorizá técnica). Sugerencia de semana: Lun D1 · Mar D2 · Jue D3 · Vie D4, tenis Mié/Sáb, descanso Dom. Tocá "cómo se hace" en cada ejercicio para la técnica y el video.',
  days: [
    { name: 'Día 1 · Superior (empuje)', exercises: [
      { name: 'Press banca con mancuernas', sets: 3, reps: '8–10', cue: 'Escápulas retraídas y pegadas al banco. Bajá controlado hasta el pecho con codos a ~45°, empujá sin bloquear de golpe.', yt: 'press de banca con mancuernas técnica' },
      { name: 'Press militar (mancuernas)', sets: 3, reps: '8–10', cue: 'Core y glúteos firmes para no arquear la lumbar. Subí hasta casi extender, bajá a la altura de las orejas.', yt: 'press militar con mancuernas técnica' },
      { name: 'Aperturas / pec deck', sets: 3, reps: '12', cue: 'Codos levemente flexionados y fijos. Abrí con control sintiendo el pecho; no fuerces el hombro al final.', yt: 'aperturas con mancuernas pecho técnica' },
      { name: 'Elevaciones laterales', sets: 3, reps: '12–15', cue: 'Subí hasta la línea de los hombros con los codos guiando. Sin balanceo, bajá lento.', yt: 'elevaciones laterales técnica' },
      { name: 'Extensión de tríceps en polea', sets: 3, reps: '12', cue: 'Codos pegados al cuerpo y fijos. Extendé completo y controlá la vuelta.', yt: 'extensión de triceps en polea técnica' },
      { name: 'Face pull (hombro y postura)', sets: 3, reps: '15', cue: 'Tirá hacia la cara separando las manos, retraé escápulas. Clave para hombro sano y postura.', yt: 'face pull técnica' },
    ]},
    { name: 'Día 2 · Inferior (fuerza)', exercises: [
      { name: 'Sentadilla (o prensa si molesta lumbar)', sets: 3, reps: '8', cue: 'Pies al ancho de hombros. Bajá con el pecho arriba, rodillas siguiendo la punta del pie, a una profundidad cómoda.', yt: 'sentadilla técnica correcta' },
      { name: 'Peso muerto rumano (liviano, técnica)', sets: 3, reps: '10', cue: 'Cadera hacia atrás, espalda neutra, barra/mancuernas pegadas a las piernas. Sentí el isquio; NO redondees la lumbar.', yt: 'peso muerto rumano técnica' },
      { name: 'Zancadas', sets: 3, reps: '10 x pierna', cue: 'Paso largo, rodilla de atrás baja cerca del piso, torso erguido. Empujá con el talón delantero.', yt: 'zancadas técnica' },
      { name: 'Gemelos de pie', sets: 4, reps: '15', cue: 'Rango completo: pausá arriba 1 seg y bajá estirando bien el gemelo.', yt: 'elevación de gemelos técnica' },
      { name: 'Plancha + Pallof anti-rotación (core tenis)', sets: 3, reps: '30 s', cue: 'Plancha: cuerpo recto, glúteos y abdomen activos. Pallof: resistí la rotación de la polea sin girar el torso.', yt: 'pallof press anti rotación técnica' },
    ]},
    { name: 'Día 3 · Superior (jalón)', exercises: [
      { name: 'Dominadas asistidas / jalón al pecho', sets: 3, reps: '8–10', cue: 'Llevá los codos hacia las costillas, pecho arriba. Sin balanceo ni inercia; sentí la espalda.', yt: 'jalón al pecho técnica' },
      { name: 'Remo con mancuerna', sets: 3, reps: '10', cue: 'Espalda neutra. Tirá del codo hacia atrás y apretá la escápula; no rotes el torso.', yt: 'remo con mancuerna técnica' },
      { name: 'Press inclinado con mancuernas', sets: 3, reps: '10', cue: 'Banco a ~30°. Bajá al pecho alto con codos a 45°, empujá controlado.', yt: 'press inclinado con mancuernas técnica' },
      { name: 'Curl de bíceps', sets: 3, reps: '12', cue: 'Codos fijos al costado. Subí sin balancear el cuerpo y controlá la bajada.', yt: 'curl de biceps con mancuernas técnica' },
      { name: 'Pájaros (deltoide posterior)', sets: 3, reps: '15', cue: 'Torso inclinado, codos suaves. Abrí sintiendo la parte de atrás del hombro.', yt: 'pajaros deltoide posterior técnica' },
      { name: 'Face pull', sets: 3, reps: '15', cue: 'Igual que el Día 1: tirá hacia la cara, separá las manos y retraé escápulas.', yt: 'face pull técnica' },
    ]},
    { name: 'Día 4 · Inferior + potencia', exercises: [
      { name: 'Empuje de cadera (hip thrust)', sets: 3, reps: '10', cue: 'Apoyá la espalda alta en el banco, empujá con los talones y apretá el glúteo arriba. No hiperextiendas la lumbar.', yt: 'hip thrust técnica' },
      { name: 'Prensa', sets: 3, reps: '12', cue: 'Pies a media altura de la plataforma. Bajá controlado hasta ~90° y no bloquees las rodillas de golpe.', yt: 'prensa de piernas técnica' },
      { name: 'Step-ups', sets: 3, reps: '10 x pierna', cue: 'Subí empujando con el talón del pie que está en el escalón. Controlá la bajada, sin saltar.', yt: 'step ups al cajón técnica' },
      { name: 'Saltos al cajón (potencia, ligero)', sets: 4, reps: '3', cue: 'Aterrizá suave con rodillas flexionadas. Bajá caminando del cajón. Priorizá calidad y explosividad, no cantidad.', yt: 'salto al cajón box jump técnica' },
      { name: 'Rotaciones de cable / leñador (core tenis)', sets: 3, reps: '12 x lado', cue: 'Girá desde el tronco con los brazos extendidos, controlado. Transfiere directo al saque y la derecha de tenis.', yt: 'leñador con polea woodchopper técnica' },
      { name: 'Movilidad de cadera y tobillo', sets: 1, reps: '5–8 min', cue: 'Sentadilla profunda sostenida, rotaciones de cadera y dorsiflexión de tobillo contra la pared.', yt: 'movilidad de cadera y tobillo rutina' },
    ]},
  ],
});

// Biblioteca curada de Dario: sólo lo que come seguido, separado por momento del día.
export const defaultFoodLibrary = () => ([
  // ----- Desayuno / Merienda -----
  { id: 'u_des_tostada_3huevos', emoji: '🍳', name: 'Mi desayuno (tostada casera + 3 huevos)',            kcal: 410, protein: 24, group: 'Desayuno / Merienda' },
  { id: 'u_des_4huevos_queso',   emoji: '🍳', name: 'Desayuno: 4 huevos + tostada integral + queso protein', kcal: 370, protein: 31, group: 'Desayuno / Merienda' },
  { id: 'u_huevos_revueltos',    emoji: '🍳', name: 'Huevos revueltos (3)',                                kcal: 270, protein: 19, group: 'Desayuno / Merienda' },
  { id: 'u_banana',              emoji: '🍌', name: 'Banana',                                              kcal: 105, protein: 1,  group: 'Desayuno / Merienda' },
  { id: 'u_flan_proteico',       emoji: '🍮', name: 'Flan proteico casero (1/6)',                          kcal: 186, protein: 19, group: 'Desayuno / Merienda' },
  { id: 'u_frutos_secos',        emoji: '🥜', name: 'Puñado de frutos secos (30g)',                        kcal: 155, protein: 5,  group: 'Desayuno / Merienda' },
  { id: 'u_chocoarroz_limon',    emoji: '🍫', name: 'ChocoArroz alfajor limón (1u)',                       kcal: 99,  protein: 1,  group: 'Desayuno / Merienda' },
  // ----- Almuerzo / Cena -----
  { id: 'u_milanesas_pure',      emoji: '🍗', name: 'Almuerzo: 2 milanesas pollo + queso protein + puré calabaza/papa', kcal: 700, protein: 64, group: 'Almuerzo / Cena' },
  { id: 'u_chicken_poke',        emoji: '🥗', name: 'Chicken Poke (arroz, pollo teriyaki, palta, maíz, veggies)',       kcal: 930, protein: 40, group: 'Almuerzo / Cena' },
  { id: 'u_fajitas_pollo',       emoji: '🌯', name: '4 fajitas de pollo c/ salsa de yogur griego, cebolla y palta',     kcal: 1200,protein: 80, group: 'Almuerzo / Cena' },
  { id: 'u_hojas_verdes',        emoji: '🥬', name: 'Hojas verdes (kale, acelga, remolacha)',              kcal: 30,  protein: 2,  group: 'Almuerzo / Cena' },
  { id: 'u_papas_fritas',        emoji: '🍟', name: 'Papas fritas (porción chica)',                        kcal: 300, protein: 4,  group: 'Almuerzo / Cena' },
  { id: 'u_tarta_pollo_porcion', emoji: '🥧', name: 'Tarta de pollo, huevo y verduras (1 porción)',        kcal: 250, protein: 14, group: 'Almuerzo / Cena' },
]);

// Versión de la biblioteca curada. Subir este número fuerza un reemplazo de la
// lista vieja (genérica) por la nueva en la próxima carga, una sola vez.
export const FOOD_LIBRARY_VERSION = 3;

export const defaultFitness = () => ({
  profile: { sex: 'male', age: 30, heightCm: 175, weightKg: 75, activity: 'moderate', goal: 'gain', proteinPerKg: 1.8, surplusPct: 12 },
  days: {},        // 'YYYY-MM-DD' -> { calories, protein, activity, sleepHours, waterMl, meditationMin, habits, soreness, meals[] }
  weighIns: [],    // { id, date, kg, bodyFatPct? }
  plan: defaultFitnessPlan(),
  workoutLogs: [], // { id, date, dayIndex, dayName, entries: [{ name, sets, weight, reps }] }
  foodLibrary: defaultFoodLibrary(),
});

// ----- Mi tiempo (planificación personal, fuera del trabajo) -----
export const defaultMyTime = () => ({
  days: {},        // 'YYYY-MM-DD' -> { energy, vibes:[], blocks:[{id,time,label,emoji,category,done}], journal }
  reflections: [], // histórico opcional de descubrimientos
});

// In-memory state (mirror of server state)
export const state = {
  projects: [],
  tasks: [],
  blocks: [],
  pomodoroLog: [],
  whiteboards: [],
  activity: [],
  pomodoroSettings: { focus: 25, shortBreak: 5, longBreak: 15, longEvery: 4 },
  settings: {
    dayStartHour: 7, dayEndHour: 22, weeklyGoalHours: 35,
    userName: 'Dario', theme: 'dark',
    autoImportObsidian: true, autoImportRoot: 'Projects', autoImportDepth: 1,
  },
  fitness: defaultFitness(),
  mytime: defaultMyTime(),
  bills: [],   // cuentas por pagar: { id, name, amount, frequency, dueDay, payMethod, url, notes, paidMonths:[] }
  promos: [],  // promociones/cupones: { id, name, source, card, benefit, cadence, validUntil, usedDates:[], notes, url }
  vault: null,
  lastUsed: { projectId: null, view: 'today' },
};

let initialized = false;

export const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};

const notify = (event = 'change') => {
  for (const fn of subs) try { fn(event, state); } catch (e) { console.error(e); }
};

export const getSaveStatus = () => saveStatus;

const setSaveStatus = (s) => {
  saveStatus = s;
  notify('save-status');
};

// Debounced server persistence
const persist = debounce(async () => {
  setSaveStatus('saving');
  try {
    const payload = {
      projects: state.projects,
      tasks: state.tasks,
      blocks: state.blocks,
      pomodoroLog: state.pomodoroLog,
      whiteboards: state.whiteboards,
      activity: state.activity,
      pomodoroSettings: state.pomodoroSettings,
      settings: state.settings,
      fitness: state.fitness,
      mytime: state.mytime,
      bills: state.bills,
      promos: state.promos,
      lastUsed: state.lastUsed,
    };
    await api.putState(payload);
    setSaveStatus('saved');
    setTimeout(() => { if (saveStatus === 'saved') setSaveStatus('idle'); }, 1200);
  } catch (e) {
    console.error('save failed', e);
    setSaveStatus('error');
  }
}, 350);

export const initState = async () => {
  if (initialized) return;
  try {
    const data = await api.getState();
    Object.assign(state, data);
    // ensure required arrays exist
    state.projects ||= [];
    state.tasks ||= [];
    state.blocks ||= [];
    state.pomodoroLog ||= [];
    state.whiteboards ||= [];
    state.activity ||= [];
    state.pomodoroSettings ||= { focus: 25, shortBreak: 5, longBreak: 15, longEvery: 4 };
    state.settings ||= { dayStartHour: 7, dayEndHour: 22, weeklyGoalHours: 35, userName: 'Dario', theme: 'dark' };
    state.settings.userName ||= 'Dario';
    state.settings.theme ||= 'dark';
    if (state.settings.autoImportObsidian === undefined) state.settings.autoImportObsidian = true;
    state.settings.autoImportRoot ||= 'Projects';
    if (state.settings.autoImportDepth === undefined) state.settings.autoImportDepth = 1;
    if (state.settings.notifEnabled === undefined) state.settings.notifEnabled = true;
    if (state.settings.notifLeadMin === undefined) state.settings.notifLeadMin = 5;
    if (!Array.isArray(state.settings.assignees) || !state.settings.assignees.length) {
      state.settings.assignees = DEFAULT_ASSIGNEES.slice();
    }
    state.lastUsed ||= { projectId: null, view: 'today' };
    // Fitness slice — backfill so older state files gain it transparently
    state.fitness ||= defaultFitness();
    state.fitness.profile ||= defaultFitness().profile;
    state.fitness.days ||= {};
    if (!Array.isArray(state.fitness.weighIns)) state.fitness.weighIns = [];
    if (!state.fitness.plan || !Array.isArray(state.fitness.plan.days) || !state.fitness.plan.days.length) {
      state.fitness.plan = defaultFitnessPlan();
    }
    // Upgrade plan si es anterior a los campos de técnica/video por ejercicio
    const _ex0 = state.fitness.plan.days?.[0]?.exercises?.[0];
    if (_ex0 && !_ex0.cue) state.fitness.plan = defaultFitnessPlan();
    if (!Array.isArray(state.fitness.workoutLogs)) state.fitness.workoutLogs = [];
    if (!Array.isArray(state.fitness.foodLibrary) || !state.fitness.foodLibrary.length
        || state.fitness.foodLibraryVersion !== FOOD_LIBRARY_VERSION) {
      // Reemplaza la biblioteca vieja (genérica) por la curada de Dario, una sola vez.
      state.fitness.foodLibrary = defaultFoodLibrary();
      state.fitness.foodLibraryVersion = FOOD_LIBRARY_VERSION;
    }
    // Mi tiempo
    state.mytime ||= defaultMyTime();
    state.mytime.days ||= {};
    if (!Array.isArray(state.mytime.reflections)) state.mytime.reflections = [];
    // Cuentas por pagar + promociones
    if (!Array.isArray(state.bills)) state.bills = [];
    if (!Array.isArray(state.promos)) state.promos = [];
    // Migrate legacy whiteboards: notes[] → items[] with type='sticky'.
    // Keep this idempotent so re-loads after upgrade are safe.
    for (const wb of state.whiteboards) {
      wb.items ||= [];
      wb.connectors ||= [];
      if (Array.isArray(wb.notes) && wb.notes.length) {
        for (const n of wb.notes) {
          if (wb.items.find(i => i.id === n.id)) continue;
          wb.items.push({
            id: n.id,
            type: 'sticky',
            x: n.x || 40, y: n.y || 40,
            w: n.w || 180, h: n.h || 100,
            color: n.color || 'yellow',
            text: n.text || '',
            createdAt: n.createdAt || Date.now(),
          });
        }
        wb.notes = []; // legacy drained
      }
    }
    // Backfill task tags/subtasks/assignee (older state files don't carry them)
    for (const t of state.tasks) {
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (!Array.isArray(t.tags)) t.tags = [];
      if (t.assignee === undefined) t.assignee = null;
    }
    for (const p of state.projects) {
      if (!Array.isArray(p.resources)) p.resources = [];
    }
    initialized = true;
    notify('init');
  } catch (e) {
    console.error('initState failed', e);
    throw e;
  }
};

// Re-sincroniza el estado desde el servidor (para cuando una pestaña vuelve a foco,
// y así no pisar con datos viejos lo que se cargó en otro lado).
export const reloadState = async () => {
  try {
    const data = await api.getState();
    Object.assign(state, data);
    state.projects ||= []; state.tasks ||= []; state.blocks ||= [];
    state.pomodoroLog ||= []; state.whiteboards ||= []; state.activity ||= [];
    state.settings ||= {};
    state.fitness ||= {}; state.fitness.days ||= {};
    state.mytime ||= {}; state.mytime.days ||= {};
    notify('change');
    return true;
  } catch (e) { console.warn('reloadState failed', e); return false; }
};

export const mutate = (fn, opts = {}) => {
  const result = fn(state);
  if (opts.activity) {
    addActivity(opts.activity);
  }
  notify(opts.event || 'change');
  if (!opts.skipSave) persist();
  return result;
};

// ----- Activity log -----
export const addActivity = (entry) => {
  state.activity.unshift({
    id: uid(),
    ts: Date.now(),
    ...entry,
  });
  if (state.activity.length > 200) state.activity.length = 200;
};

// ----- Projects -----
export const findProject = (id) => state.projects.find(p => p.id === id);

export const addProject = (data) => {
  const p = {
    id: uid(),
    name: data.name || 'Proyecto sin título',
    description: data.description || '',
    goal: data.goal || '',
    status: data.status || 'active',
    health: data.health || 'on-track',
    color: data.color || PROJECT_COLORS[0].value,
    icon: data.icon || '',
    milestones: data.milestones || [],
    resources: Array.isArray(data.resources) ? data.resources : [],
    vaultFolder: data.vaultFolder || null,
    parentId: data.parentId || null,
    createdAt: Date.now(),
  };
  mutate(s => { s.projects.push(p); }, {
    activity: { type: 'project.create', text: `Creó proyecto **${p.name}**`, projectId: p.id },
  });
  return p;
};

// Helpers for hierarchy
export const childrenOf = (parentId) =>
  state.projects.filter(p => p.parentId === parentId);
export const rootProjects = () =>
  state.projects.filter(p => !p.parentId);

// Auto-import top-level Projects/* (and optionally one level of subprojects).
// Idempotent: skips already-linked folders. Returns counts.
const folderDepth = (folder, root) => {
  if (!folder || !root) return 0;
  const rel = folder.startsWith(root + '/') ? folder.slice(root.length + 1) : folder;
  return Math.max(0, rel.split('/').length - 1);
};
export const runObsidianAutoImport = async ({ silent = true } = {}) => {
  const s = state.settings || {};
  if (!state.vault?.path) return { ok: false, reason: 'no-vault' };
  const root = (s.autoImportRoot || 'Projects').replace(/^\/+|\/+$/g, '');
  const maxDepth = s.autoImportDepth ?? 1;
  let scan;
  try {
    scan = await api.listProjects(root);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const candidates = (scan.folders || [])
    .filter(f => folderDepth(f.folder, root) <= maxDepth)
    .filter(f => !state.projects.some(p => p.vaultFolder === f.folder));
  if (!candidates.length) return { ok: true, projects: 0, tasks: 0, skipped: 0 };
  // Map to API payload (preserve parent for hierarchy)
  const items = candidates.map((f, i) => ({
    folder: f.folder,
    name: f.name,
    color: f.color || PROJECT_COLORS[i % PROJECT_COLORS.length].value,
    status: f.status,
    health: f.health,
    goal: f.goal,
    description: f.description,
    parent: f.parent || null,
  }));
  try {
    const res = await api.importProjects(items);
    const out = importProjectsFromVault(res.projects || []);
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
};

// Wipe all tasks (both Tempo state AND each linked project's tasks/ folder in vault).
export const removeAllTasks = ({ alsoVault = true } = {}) => {
  // Snapshot of project folders to clear before we wipe state
  const linked = state.projects.filter(p => p.vaultFolder).map(p => ({
    folder: p.vaultFolder, name: p.name,
  }));
  const removed = state.tasks.length;
  mutate(s => {
    s.tasks = [];
    addActivity({ type: 'task.wipe', text: `Eliminó todas las tareas (${removed})` });
  });
  if (alsoVault && state.vault?.path) {
    // Push empty arrays to each linked project — server deletes orphan files
    for (const l of linked) {
      api.syncTasks(l.folder, l.name, []).catch(() => {});
    }
  }
  return { removed };
};

// Pull-from-vault refresh: re-read each linked project's tasks/ folder and make
// state.tasks match. Vault is treated as source of truth on this manual sync —
// edits/deletes done directly in Obsidian land in Tempo. Pomodoro counts stick
// because the file frontmatter carries the task id.
export const refreshTasksFromVault = async () => {
  if (!state.vault?.path) return { ok: false, reason: 'no-vault' };
  const linked = state.projects.filter(p => p.vaultFolder);
  if (!linked.length) return { ok: true, projects: 0, added: 0, removed: 0, updated: 0 };

  let added = 0, removed = 0, updated = 0;
  // Fetch in parallel
  const results = await Promise.all(linked.map(async (p) => {
    try {
      const r = await api.listVaultTasks(p.vaultFolder);
      return { project: p, tasks: r.tasks || [] };
    } catch (e) {
      return { project: p, error: e.message };
    }
  }));

  mutate(s => {
    for (const { project, tasks } of results) {
      if (!tasks) continue;
      // Existing in-state tasks for this project
      const existing = s.tasks.filter(t => t.projectId === project.id);
      const existingById = new Map(existing.filter(t => t.id).map(t => [t.id, t]));
      const seenIds = new Set();

      // Upsert from vault
      for (const v of tasks) {
        const id = v.id || uid();
        seenIds.add(id);
        const prev = existingById.get(id);
        if (prev) {
          const before = JSON.stringify(prev);
          Object.assign(prev, {
            text: v.text,
            state: v.state || 'inbox',
            priority: v.priority || 'med',
            due: v.due || null,
            followUpAt: v.followUpAt || null,
            pomodoros: v.pomodoros || 0,
            pomodorosDone: v.pomodorosDone || prev.pomodorosDone || 0,
            notes: v.notes || '',
            comments: Array.isArray(v.comments) ? v.comments : (prev.comments || []),
          });
          if (JSON.stringify(prev) !== before) updated++;
        } else {
          s.tasks.push({
            id,
            text: v.text,
            state: v.state || 'inbox',
            projectId: project.id,
            pomodoros: v.pomodoros || 0,
            pomodorosDone: v.pomodorosDone || 0,
            priority: v.priority || 'med',
            due: v.due || null,
            followUpAt: v.followUpAt || null,
            notes: v.notes || '',
            comments: Array.isArray(v.comments) ? v.comments : [],
            createdAt: Date.now(),
            order: Date.now(),
          });
          added++;
        }
      }
      // Drop in-state tasks for this project that no longer have a vault file
      const toDropIds = new Set(existing.filter(t => t.id && !seenIds.has(t.id)).map(t => t.id));
      if (toDropIds.size) {
        s.tasks = s.tasks.filter(t => !toDropIds.has(t.id));
        removed += toDropIds.size;
      }
    }
    addActivity({ type: 'vault.refresh', text: `Pull desde vault: +${added} / ~${updated} / -${removed}` });
  });
  return { ok: true, projects: linked.length, added, removed, updated };
};

// Delete every project linked to Obsidian, plus their tasks/blocks.
// Use when the user wants to start the link from scratch.
export const removeAllVaultLinkedProjects = () => {
  const ids = state.projects.filter(p => !!p.vaultFolder).map(p => p.id);
  mutate(s => {
    s.projects = s.projects.filter(p => !p.vaultFolder);
    s.tasks = s.tasks.filter(t => !ids.includes(t.projectId));
    s.blocks = s.blocks.filter(b => !ids.includes(b.projectId));
    addActivity({ type: 'project.unlink-all', text: `Eliminó ${ids.length} proyecto(s) vinculado(s) a Obsidian` });
  });
  return { removed: ids.length };
};

// Import a batch of projects (with their tasks) returned by the server's
// /api/vault/import-projects endpoint. Skips projects whose vaultFolder is already linked.
// Sorts by depth so parents land first, then resolves child parentId by parent folder.
export const importProjectsFromVault = (incoming) => {
  const created = { projects: 0, tasks: 0, skipped: 0 };
  const sorted = incoming.slice().sort(
    (a, b) => (a.folder || '').split('/').length - (b.folder || '').split('/').length);
  mutate(s => {
    for (const item of sorted) {
      const folder = item.folder;
      const existing = s.projects.find(p => p.vaultFolder === folder);
      let project = existing;
      // Resolve parentId from item.parent (folder path of parent project)
      const parentProj = item.parent
        ? s.projects.find(p => p.vaultFolder === item.parent)
        : null;
      if (!project) {
        project = {
          id: uid(),
          name: item.meta?.name || item.name || 'Proyecto',
          description: item.meta?.description || '',
          goal: item.meta?.goal || '',
          status: item.meta?.status || 'active',
          health: item.meta?.health || 'on-track',
          color: item.meta?.color || PROJECT_COLORS[0].value,
          icon: '',
          milestones: [],
          vaultFolder: folder,
          parentId: parentProj?.id || null,
          createdAt: Date.now(),
        };
        s.projects.push(project);
        created.projects++;
        addActivity({
          type: 'project.import',
          text: `Importó **${project.name}** desde Obsidian`,
          projectId: project.id,
        });
      } else {
        // Backfill parentId on existing projects so re-imports rebuild hierarchy
        if (parentProj && !project.parentId) project.parentId = parentProj.id;
        created.skipped++;
        // For already-linked projects, do NOT re-import tasks. Tempo is the source
        // of truth from this point on; the tasks/ folder gets rewritten on every
        // mutation. This way wiping tasks stays wiped across reimports.
        continue;
      }
      // Tasks: only imported on first link (new projects)
      for (const row of (item.tasks || [])) {
        s.tasks.push({
          id: uid(),
          text: row.text,
          state: row.state,
          projectId: project.id,
          pomodoros: row.pomodoros || 0,
          pomodorosDone: 0,
          priority: row.priority || 'med',
          due: row.due || null,
          createdAt: Date.now(),
          order: Date.now(),
        });
        created.tasks++;
      }
    }
  });
  return created;
};

// Build the payload that gets written to <project>/tasks/ folder
export const tasksForProject = (projectId) => {
  return state.tasks
    .filter(t => t.projectId === projectId)
    .map(t => ({
      id: t.id,
      text: t.text,
      state: t.state,
      priority: t.priority || 'med',
      due: t.due || null,
      followUpAt: t.followUpAt || null,
      recurrence: t.recurrence || null,
      pomodoros: t.pomodoros || 0,
      pomodorosDone: t.pomodorosDone || 0,
      notes: t.notes || '',
      comments: t.comments || [],
      createdAt: t.createdAt,
    }));
};

export const updateProject = (id, patch) => {
  mutate(s => {
    const p = s.projects.find(x => x.id === id);
    if (!p) return;
    const oldStatus = p.status;
    const oldHealth = p.health;
    Object.assign(p, patch, { updatedAt: Date.now() });
    if (patch.status && patch.status !== oldStatus) {
      addActivity({ type: 'project.status', text: `Cambió estado de **${p.name}** a ${p.status}`, projectId: id });
    }
    if (patch.health && patch.health !== oldHealth) {
      addActivity({ type: 'project.health', text: `Salud de **${p.name}** ahora ${p.health}`, projectId: id });
    }
  });
};

export const deleteProject = (id) => {
  mutate(s => {
    const p = s.projects.find(x => x.id === id);
    if (!p) return;
    s.projects = s.projects.filter(x => x.id !== id);
    s.tasks = s.tasks.filter(t => t.projectId !== id);
    s.blocks = s.blocks.filter(b => b.projectId !== id);
    addActivity({ type: 'project.delete', text: `Eliminó proyecto **${p.name}**` });
  });
};

// ----- Vault auto-sync (per-project, debounced) -----
const vaultSyncTimers = new Map();
const scheduleVaultSync = (projectId) => {
  if (!projectId || !state.vault?.path) return;
  const p = findProject(projectId);
  if (!p?.vaultFolder) return;
  if (vaultSyncTimers.has(projectId)) clearTimeout(vaultSyncTimers.get(projectId));
  vaultSyncTimers.set(projectId, setTimeout(async () => {
    vaultSyncTimers.delete(projectId);
    try {
      await api.syncTasks(p.vaultFolder, p.name, tasksForProject(projectId));
    } catch (e) {
      console.warn('[vault sync] failed for', p.name, e);
    }
  }, 1500));
};

// ----- Tasks -----
export const addTask = (data) => {
  const t = {
    id: uid(),
    text: data.text || '',
    state: data.state || 'inbox',
    projectId: data.projectId || null,
    pomodoros: data.pomodoros || 0,
    pomodorosDone: 0,
    priority: data.priority || 'med',
    due: data.due || null,
    followUpAt: data.followUpAt || null,
    recurrence: data.recurrence || null,
    notes: data.notes || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    subtasks: Array.isArray(data.subtasks) ? data.subtasks : [],
    comments: Array.isArray(data.comments) ? data.comments : [],
    assignee: data.assignee || null,
    createdAt: Date.now(),
    order: Date.now(),
  };
  mutate(s => { s.tasks.push(t); }, {
    activity: { type: 'task.create', text: `Nueva tarea: **${t.text || 'sin título'}**`, projectId: t.projectId, taskId: t.id },
  });
  scheduleVaultSync(t.projectId);
  return t;
};

// Append a timestamped comment to a task. Auto-syncs to the task's .md file.
export const addTaskComment = (taskId, text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  let comment;
  let projectId = null;
  mutate(s => {
    const t = s.tasks.find(x => x.id === taskId);
    if (!t) return;
    t.comments ||= [];
    comment = { id: uid(), ts: Date.now(), text: trimmed };
    t.comments.push(comment);
    projectId = t.projectId;
    addActivity({
      type: 'task.comment',
      text: `Comentó **${(t.text || 'tarea').slice(0, 40)}**: ${trimmed.slice(0, 80)}`,
      projectId, taskId,
    });
  });
  scheduleVaultSync(projectId);
  return comment;
};

export const deleteTaskComment = (taskId, commentId) => {
  let projectId = null;
  mutate(s => {
    const t = s.tasks.find(x => x.id === taskId);
    if (!t) return;
    t.comments = (t.comments || []).filter(c => c.id !== commentId);
    projectId = t.projectId;
  });
  scheduleVaultSync(projectId);
};

export const updateTask = (id, patch) => {
  let oldProjectId = null, newProjectId = null;
  let recurringClone = null;
  mutate(s => {
    const t = s.tasks.find(x => x.id === id);
    if (!t) return;
    const oldState = t.state;
    oldProjectId = t.projectId;
    Object.assign(t, patch);
    newProjectId = t.projectId;
    if (patch.state && patch.state !== oldState) {
      const stateLabel = TASK_STATES.find(x => x.id === patch.state)?.label || patch.state;
      addActivity({ type: 'task.state', text: `**${t.text || 'tarea'}** → ${stateLabel}`, projectId: t.projectId, taskId: id });
      // Recurring task: when transitioning to "done", spawn the next instance
      if (patch.state === 'done' && oldState !== 'done' && t.recurrence) {
        const nextDue = computeNextDue(t);
        if (nextDue) {
          recurringClone = {
            id: uid(),
            text: t.text,
            state: 'todo',
            projectId: t.projectId,
            pomodoros: t.pomodoros || 0,
            pomodorosDone: 0,
            priority: t.priority || 'med',
            due: nextDue,
            followUpAt: null,
            recurrence: t.recurrence,
            notes: t.notes || '',
            comments: [],
            createdAt: Date.now(),
            order: Date.now(),
          };
        }
      }
    }
  });
  if (recurringClone) {
    mutate(s => { s.tasks.push(recurringClone); }, {
      activity: { type: 'task.recurrence', text: `🔁 Próxima instancia de **${recurringClone.text}** para ${recurringClone.due}`, projectId: recurringClone.projectId, taskId: recurringClone.id },
    });
    scheduleVaultSync(recurringClone.projectId);
  }
  scheduleVaultSync(oldProjectId);
  if (newProjectId && newProjectId !== oldProjectId) scheduleVaultSync(newProjectId);
};

export const deleteTask = (id) => {
  let projectId = null;
  mutate(s => {
    const t = s.tasks.find(x => x.id === id);
    if (!t) return;
    projectId = t.projectId;
    s.tasks = s.tasks.filter(x => x.id !== id);
    addActivity({ type: 'task.delete', text: `Eliminó tarea **${t.text || 'sin título'}**`, projectId: t.projectId });
  });
  scheduleVaultSync(projectId);
};

// Clone a task into the same project. Subtasks are copied (with done reset).
// Pomodoro counts and comments do NOT carry over — a clone is a fresh start.
// New title gets a "(copia)" suffix unless a custom one is passed in.
export const duplicateTask = (id, overrides = {}) => {
  const src = state.tasks.find(x => x.id === id);
  if (!src) return null;
  const copy = {
    id: uid(),
    text: overrides.text || `${src.text || 'Tarea'} (copia)`,
    state: overrides.state || (src.state === 'done' ? 'todo' : src.state),
    projectId: src.projectId,
    pomodoros: src.pomodoros || 0,
    pomodorosDone: 0,
    priority: src.priority || 'med',
    due: overrides.due ?? src.due ?? null,
    followUpAt: src.followUpAt || null,
    recurrence: null,            // recurrence is intentionally dropped — clones aren't recurring instances
    notes: src.notes || '',
    tags: Array.isArray(src.tags) ? src.tags.slice() : [],
    subtasks: (src.subtasks || []).map(s => ({ id: uid(), text: s.text, done: false })),
    comments: [],
    assignee: src.assignee || null,
    createdAt: Date.now(),
    order: Date.now(),
  };
  mutate(s => { s.tasks.push(copy); }, {
    activity: { type: 'task.clone', text: `Clonó tarea **${copy.text}**`, projectId: copy.projectId, taskId: copy.id },
  });
  scheduleVaultSync(copy.projectId);
  return copy;
};

// Bulk move every "done" task to an "archived" state (kept in state, hidden by board).
// Returns the count moved. Activity log gets a single entry, not one per task.
export const archiveDoneTasks = (projectId = null) => {
  let count = 0;
  const touched = new Set();
  mutate(s => {
    for (const t of s.tasks) {
      if (t.state !== 'done') continue;
      if (projectId && t.projectId !== projectId) continue;
      t.state = 'archived';
      t.archivedAt = Date.now();
      count++;
      if (t.projectId) touched.add(t.projectId);
    }
    if (count > 0) {
      addActivity({ type: 'task.archive', text: `Archivó ${count} tarea(s) hechas`, projectId });
    }
  });
  for (const pid of touched) scheduleVaultSync(pid);
  return count;
};

// ----- Blocks (calendar) -----
export const addBlock = (data) => {
  const b = {
    id: uid(),
    title: data.title || '',
    date: data.date || todayKey(),
    start: data.start,
    end: data.end,
    kind: data.kind || 'work',   // 'work' | 'meeting'
    projectId: data.projectId || null,
    notes: data.notes || '',
    createdAt: Date.now(),
  };
  mutate(s => { s.blocks.push(b); }, {
    activity: { type: 'block.create', text: `Bloque: **${b.title || 'sin título'}** (${b.start}–${b.end})`, projectId: b.projectId },
  });
  return b;
};

export const updateBlock = (id, patch) => {
  mutate(s => {
    const b = s.blocks.find(x => x.id === id);
    if (b) Object.assign(b, patch);
  });
};

export const deleteBlock = (id) => {
  mutate(s => {
    s.blocks = s.blocks.filter(x => x.id !== id);
  });
};

// ----- Pomodoros -----
export const logPomodoro = (data) => {
  const p = {
    id: uid(),
    completedAt: Date.now(),
    duration: data.duration,
    taskId: data.taskId || null,
    projectId: data.projectId || null,
    type: data.type || 'focus',
  };
  mutate(s => {
    s.pomodoroLog.unshift(p);
    if (s.pomodoroLog.length > 1000) s.pomodoroLog.length = 1000;
    if (data.taskId) {
      const t = s.tasks.find(x => x.id === data.taskId);
      if (t) t.pomodorosDone = (t.pomodorosDone || 0) + 1;
    }
  }, {
    activity: { type: 'pomo', text: `Completó pomodoro 🍅 (${data.duration}m)`, projectId: data.projectId, taskId: data.taskId },
  });
};

// ----- Whiteboards -----
// Default sizes per item type — kept here so views/whiteboard.js stays slim.
const WB_DEFAULTS = {
  sticky:    { w: 180, h: 110, color: 'yellow' },
  rect:      { w: 220, h: 130, color: 'blue' },
  ellipse:   { w: 200, h: 130, color: 'green' },
  text:      { w: 200, h: 40,  color: 'plain' },
  checklist: { w: 240, h: 180, color: 'violet' },
};

export const addWhiteboard = (data = {}) => {
  const wb = {
    id: uid(),
    name: data.name || 'Pizarra',
    notes: [],          // legacy, kept empty
    items: [],
    connectors: [],
    createdAt: Date.now(),
  };
  mutate(s => { s.whiteboards.push(wb); });
  return wb;
};

export const updateWhiteboard = (id, patch) => {
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === id);
    if (wb) Object.assign(wb, patch);
  });
};

export const deleteWhiteboard = (id) => {
  mutate(s => { s.whiteboards = s.whiteboards.filter(x => x.id !== id); });
};

// ----- Whiteboard items (unified: sticky, rect, ellipse, text, checklist) -----
export const addWhiteboardItem = (wbId, data = {}) => {
  const type = data.type || 'sticky';
  const def = WB_DEFAULTS[type] || WB_DEFAULTS.sticky;
  const item = {
    id: uid(),
    type,
    x: data.x ?? 40,
    y: data.y ?? 40,
    w: data.w ?? def.w,
    h: data.h ?? def.h,
    color: data.color || def.color,
    text: data.text ?? '',
    todos: type === 'checklist' ? (data.todos || []) : undefined,
    createdAt: Date.now(),
  };
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === wbId);
    if (!wb) return;
    wb.items ||= [];
    wb.items.push(item);
  });
  return item;
};

export const updateWhiteboardItem = (wbId, itemId, patch) => {
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === wbId);
    if (!wb) return;
    const it = (wb.items || []).find(x => x.id === itemId);
    if (it) Object.assign(it, patch);
  });
};

export const deleteWhiteboardItem = (wbId, itemId) => {
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === wbId);
    if (!wb) return;
    wb.items = (wb.items || []).filter(x => x.id !== itemId);
    // Drop any connector that pointed at this item — orphaned arrows are noise.
    wb.connectors = (wb.connectors || []).filter(c => c.from !== itemId && c.to !== itemId);
  });
};

// ----- Whiteboard connectors (arrows between items) -----
export const addWhiteboardConnector = (wbId, data) => {
  if (!data?.from || !data?.to || data.from === data.to) return null;
  const conn = {
    id: uid(),
    from: data.from,
    to: data.to,
    color: data.color || 'accent',
    label: data.label || '',
    style: data.style || 'solid',
    createdAt: Date.now(),
  };
  let added = null;
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === wbId);
    if (!wb) return;
    wb.connectors ||= [];
    // Don't duplicate the same arrow direction
    if (wb.connectors.find(c => c.from === conn.from && c.to === conn.to)) return;
    wb.connectors.push(conn);
    added = conn;
  });
  return added;
};

export const updateWhiteboardConnector = (wbId, id, patch) => {
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === wbId);
    if (!wb) return;
    const c = (wb.connectors || []).find(x => x.id === id);
    if (c) Object.assign(c, patch);
  });
};

export const deleteWhiteboardConnector = (wbId, id) => {
  mutate(s => {
    const wb = s.whiteboards.find(x => x.id === wbId);
    if (!wb) return;
    wb.connectors = (wb.connectors || []).filter(x => x.id !== id);
  });
};

// Legacy shims — old callers (and any external scripts) still work.
export const addWhiteboardNote    = (wbId, note)         => addWhiteboardItem(wbId, { type: 'sticky', ...note });
export const updateWhiteboardNote = (wbId, id, patch)    => updateWhiteboardItem(wbId, id, patch);
export const deleteWhiteboardNote = (wbId, id)           => deleteWhiteboardItem(wbId, id);

// ----- Settings / Vault -----
export const updateSettings = (patch) => {
  mutate(s => { Object.assign(s.settings, patch); });
};

export const updatePomodoroSettings = (patch) => {
  mutate(s => { Object.assign(s.pomodoroSettings, patch); });
};

export const setVault = (vaultInfo) => {
  mutate(s => { s.vault = vaultInfo; }, { skipSave: true }); // server already persisted vault
};

export const setLastUsed = (patch) => {
  mutate(s => { Object.assign(s.lastUsed, patch); });
};
