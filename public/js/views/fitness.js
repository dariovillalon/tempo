// fitness.js — nutrición, peso, gym, bienestar, cuerpo, reportes y aprendizaje
// (objetivo: sumar masa muscular + rendir en tenis)

import { state, mutate, ACTIVITY_FACTORS, defaultFitnessPlan } from '../state.js';
import { todayKey, uid, escapeHtml, addDays } from '../utils.js';

// ---- UI state (sobrevive re-renders) ----
let tab = 'resumen';
let gymDayIndex = 0;
let comidaDate = null;        // null = hoy
let reportDays = 30;
let bodyView = 'front';
let showFoodForm = false;
let actIntensity = 'moderado';    // intensidad seleccionada para registrar actividad
let editPlan = false;             // modo edición del plan de gym
let showBowel = false;            // seguimiento de digestión (oculto por defecto)
const expandedEx = new Set();     // ejercicios con "cómo se hace" abierto
const expandedHabits = new Set(); // hábitos con sub-items abiertos

const F = () => state.fitness;
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const tk = () => todayKey();
// Hora de dormir (24 = medianoche, 25 = 01:00). De acá salen la rutina nocturna y el corte de cafeína.
const bedtimeHour = () => num(F().profile?.bedtimeHour, 24);
const hhmm = (h) => { const hh = (((Math.floor(h) % 24) + 24) % 24); const mm = Math.round((h - Math.floor(h)) * 60); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };
const caffeineCutoff = () => hhmm(bedtimeHour() - 8); // ~8 h antes de dormir

// Nivel de actividad SIN ejercicio (solo tu día a día). El entreno/movimiento se suma aparte por día.
const ACTIVITY_LABELS = {
  sedentary: 'Escritorio (poco movimiento)', light: 'Ligero (de pie/caminatas)', moderate: 'Activo (bastante de pie)',
  active: 'Trabajo físico', very: 'Trabajo muy físico',
};
const WATER_GOAL = 3000, SLEEP_GOAL = 7.75, MED_GOAL = 10;

// ---- info (beneficio + cómo hacerlo eficiente) ----
const INFO = {
  sleep: 'Por qué: en el sueño profundo reparás y construís músculo (pico de hormona de crecimiento) y consolidás el foco. Cómo eficiente: misma hora cada noche, 7.5–8 h, cuarto oscuro y fresco, sin pantallas 30 min antes.',
  water: 'Por qué: la hidratación sostiene fuerza, foco y recuperación; el músculo es ~75% agua. Cómo eficiente: ~3 L/día, un vaso al despertar y uno antes de cada comida; más si entrenás o hace calor. Ojo: el mate, el café y el té TAMBIÉN hidratan (lo de que "deshidratan" es un mito) — acá ya los cuento como líquido.',
  meditation: 'Por qué: 10 min/día mejoran la atención y bajan el cortisol (el estrés alto frena la ganancia muscular). Cómo eficiente: apenas te levantás, sentado, seguí la respiración; usá una guía al principio.',
  light: 'Por qué: la luz natural temprano fija tu reloj interno, te da energía y mejora el sueño de esa noche. Cómo: 5–10 min afuera o junto a la ventana en la primera hora.',
  water_am: 'Por qué: rehidratás tras la noche y arrancás el metabolismo. Cómo: un vaso grande de agua apenas te levantás.',
  mobility_am: 'Por qué: prepara articulaciones y baja la rigidez/agujetas. Cómo: gato-camello, rodillas al pecho y círculos de cadera/tobillo, 5 min suave.',
  protein_bf: 'Por qué: arranca la síntesis de proteína del día y estabiliza energía y foco. Cómo: 20–30 g (huevos, yogur griego, whey).',
  plan: 'Por qué: decidir el día evita que el día te maneje. Cómo: 5 min en "Hoy", bajá 3 tareas.',
  read: 'Por qué: corta pantallas y baja revoluciones para dormir mejor. Cómo: 20–30 min con luz cálida.',
  stretch_pm: 'Por qué: afloja las zonas cargadas y mejora la movilidad. Cómo: estirá suave lo que sentís tenso, sin llegar al dolor.',
  no_screens: 'Por qué: la luz azul retrasa la melatonina y el sueño. Cómo: cortá pantallas 30 min antes; si no, modo noche.',
  prep_tomorrow: 'Por qué: descargás la cabeza y arrancás más rápido mañana. Cómo: dejá la ropa de gym lista y la primera tarea elegida.',
  caffeine: 'Por qué: la cafeína da foco, pero su vida media es ~5–6 h: tomada tarde recorta el sueño profundo aunque te duermas igual. Cómo eficiente: hasta ~400 mg/día y cortala 8–10 h antes de dormir (para vos, antes de las 15–16 h). Truco: esperá 60–90 min tras despertarte para el primer café/mate y evitás el bajón de media mañana.',
  movement: 'Por qué: el movimiento diario (caminatas, etc.) suma gasto calórico y recuperación activa sin fatigarte para entrenar. Cómo eficiente: registrá acá lo que NO sea gym (eso va en la pestaña Gym). Las calorías son estimadas por tu peso y la intensidad.',
  creatine: 'Por qué: 3–5 g/día de creatina monohidrato es el suplemento con más evidencia para fuerza y masa. Cómo: todos los días (también los de descanso), a cualquier hora; lo que importa es la constancia, no el horario.',
};
const infoIcon = (key) => INFO[key] ? `<span class="fit-info" tabindex="0">i<span class="fit-tip">${escapeHtml(INFO[key])}</span></span>` : '';

// Tip: luz natural + vaso de agua + movilidad se hacen juntos (salí al sol con el agua y hacé la movilidad ahí).
const MORNING_HABITS = [
  { id: 'light',      label: 'Luz natural al despertar',   time: '07:00', combo: true },
  { id: 'water_am',   label: 'Vaso de agua al levantarme', time: '07:00', combo: true },
  { id: 'mobility_am',label: 'Movilidad suave 5 min',      time: '07:00', combo: true, steps: [
    { id: 'cat',   label: 'Gato-camello × 8–10' },
    { id: 'knees', label: 'Rodillas al pecho × 8 por pierna' },
    { id: 'twist', label: 'Rotación de columna (knee drops) × 6 por lado' },
    { id: 'hip',   label: 'Círculos de cadera × 8 por lado' },
    { id: 'ankle', label: 'Tobillo a la pared (dorsiflexión) × 10 por lado' },
  ]},
  { id: 'protein_bf', label: 'Desayuno proteico',          time: '07:30' },
  { id: 'meditate',   label: 'Meditación 10 min',          time: '07:45' },
  { id: 'plan',       label: 'Planifiqué el día en tempo', time: '07:55' },
];
const EVENING_HABITS = [
  { id: 'read',          label: 'Lectura 20–30 min',           before: 120 },
  { id: 'stretch_pm',    label: 'Estiramiento / movilidad',    before: 75, steps: [
    { id: 'quad',    label: 'Cuádriceps × 30 s por pierna' },
    { id: 'ham',     label: 'Isquios × 30 s por pierna' },
    { id: 'glute',   label: 'Glúteo figura-4 × 30 s por lado' },
    { id: 'cat',     label: 'Gato-camello × 8' },
    { id: 'lowback', label: 'Rodillas al pecho × 30 s (lumbar)' },
  ]},
  { id: 'no_screens',    label: 'Sin pantallas antes de dormir', before: 30 },
  { id: 'prep_tomorrow', label: 'Preparé mañana',              before: 20 },
];
const ALL_HABITS = [...MORNING_HABITS, ...EVENING_HABITS];

// ---- tips de libros (aprendizaje) ----
const TIPS = [
  { cat: 'Nutrición', text: 'Comé 1.6–2.2 g de proteína por kg al día: es el rango con más evidencia para construir músculo. Repartila en 3–4 comidas de 25–40 g.', src: 'Morton et al. (meta-análisis) · Helms, "The Muscle & Strength Pyramid"' },
  { cat: 'Nutrición', text: 'Para ganar músculo con poca grasa, mantené un superávit chico (~10–15%) y apuntá a subir 0.25–0.5% de tu peso por semana.', src: 'Helms · Renaissance Periodization' },
  { cat: 'Nutrición', text: 'Si te cuesta llegar a las calorías, sumá calorías líquidas (leche, batido con avena y maní): saturan menos que la comida sólida.', src: 'Matthews, "Bigger Leaner Stronger"' },
  { cat: 'Nutrición', text: 'No le temas a los carbohidratos: son el combustible de tus entrenos y mejoran recuperación y rendimiento.', src: 'Aragon · Schoenfeld' },
  { cat: 'Nutrición', text: 'La consistencia semanal pesa más que la perfección diaria: un día alto no arruina nada si el promedio está bien.', src: 'Matthews · Clear' },
  { cat: 'Entrenamiento', text: 'Sobrecarga progresiva: para crecer tenés que sumar peso o reps con el tiempo. Anotá tus series y superá la sesión anterior de a poco.', src: 'Schoenfeld, "Science and Development of Muscle Hypertrophy"' },
  { cat: 'Entrenamiento', text: 'Apuntá a ~10–20 series por grupo muscular por semana: es la zona donde la mayoría progresa.', src: 'Schoenfeld · Renaissance Periodization' },
  { cat: 'Entrenamiento', text: 'Entrená cerca del fallo pero dejando 1–3 reps en reserva (RIR): estimula sin quemarte ni romper la técnica.', src: 'Helms, "The Muscle & Strength Pyramid"' },
  { cat: 'Entrenamiento', text: 'Técnica antes que ego: rango completo y control valen más que el peso, sobre todo volviendo tras un parate.', src: 'Rippetoe, "Starting Strength"' },
  { cat: 'Entrenamiento', text: 'Descansá 1.5–3 min entre series pesadas: movés más peso total y eso construye más músculo.', src: 'Schoenfeld' },
  { cat: 'Sueño y recuperación', text: 'Dormí 7–9 h: en el sueño se libera hormona de crecimiento y se repara el músculo. Es tu mejor "suplemento".', src: 'Walker, "Why We Sleep"' },
  { cat: 'Sueño y recuperación', text: 'El músculo crece en el descanso: dale ~48 h a cada grupo antes de volver a entrenarlo fuerte.', src: 'Schoenfeld' },
  { cat: 'Sueño y recuperación', text: 'El estrés crónico sube el cortisol y frena las ganancias: paseos, respiración y meditación ayudan a recuperarte.', src: 'Huberman Lab' },
  { cat: 'Sueño y recuperación', text: 'Caminar suave al día siguiente de piernas baja las agujetas mejor que el reposo total (recuperación activa).', src: 'Dupuy et al.' },
  { cat: 'Hábitos', text: 'Hacé el buen hábito obvio y fácil: ropa de gym lista y botella de agua a la vista.', src: 'Clear, "Atomic Habits"' },
  { cat: 'Hábitos', text: 'Encadená un hábito nuevo a uno que ya tenés ("después del café, medito 10 min").', src: 'Clear, "Atomic Habits"' },
  { cat: 'Hábitos', text: 'Lo que se mide, mejora: por eso registrás peso, comida y entrenos. El dato te mantiene honesto.', src: 'Clear · Matthews' },
  { cat: 'Tenis', text: 'Trabajá el core rotacional (leñador, Pallof): la potencia del saque y la derecha sale del tronco, no del brazo.', src: 'Preparación física de tenis' },
  { cat: 'Tenis', text: 'Fortalecé glúteos y piernas: frenar, arrancar y cambiar de dirección dependen de ellas.', src: 'Preparación física de tenis' },
  { cat: 'Tenis', text: 'Cuidá el hombro con face pulls y manguito rotador: previene la lesión más común del tenista.', src: 'Fisioterapia deportiva' },
  { cat: 'Tenis', text: 'Dejá 24–48 h entre pierna pesada y partido para no jugar cansado y arriesgar una lesión.', src: 'Programación deportiva' },
  { cat: 'Suplementos', text: 'Creatina monohidrato 3–5 g/día: el suplemento con más evidencia para fuerza y masa, seguro y barato. Cualquier horario, todos los días (también los de descanso).', src: 'ISSN Position Stand · Kreider et al.' },
  { cat: 'Nutrición', text: 'Repartí la proteína en 3–4 tomas de ~0.4 g/kg (30–40 g) en vez de toda junta: maximiza la síntesis muscular a lo largo del día.', src: 'Schoenfeld & Aragon (2018)' },
  { cat: 'Nutrición', text: 'Apuntá a 25–35 g de fibra/día (verduras, fruta, integrales, legumbres): mejora digestión, saciedad y salud a largo plazo.', src: 'Guías dietéticas' },
  { cat: 'Suplementos', text: 'Lo básico que sí vale: creatina, suficiente proteína y vitamina D si no tomás sol. El resto (la mayoría) es marketing.', src: 'Examine.com' },
];
const tipOfDay = () => {
  const d = new Date(); const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  return TIPS[doy % TIPS.length];
};

// ---- datos ----
const getDay = (key) => F().days[key] || {};
function saveDay(date, fields) { mutate(s => { const cur = s.fitness.days[date] || {}; s.fitness.days[date] = { ...cur, ...fields }; }); }
function addWater(date, ml) { mutate(s => { const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.waterMl = Math.max(0, num(d.waterMl) + ml); }); }
function addMeditation(date, min) { mutate(s => { const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.meditationMin = Math.max(0, num(d.meditationMin) + min); }); }
function patchSup(date, key, val) { mutate(s => { const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d[key] = val; }); }
function addBowel(date, bristol) { mutate(s => { const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.bowelLog = d.bowelLog || []; d.bowelLog.push({ id: uid(), time: nowHM(), bristol: bristol || null }); }); }
function removeBowel(date, id) { mutate(s => { const d = s.fitness.days[date]; if (!d || !d.bowelLog) return; d.bowelLog = d.bowelLog.filter(e => e.id !== id); }); }
const CAFFEINE = { cafe: { mg: 95, label: 'Café', ml: 200 }, mate_medio: { mg: 110, label: 'Mate ½ termo', ml: 500 }, mate_full: { mg: 220, label: 'Mate 1L', ml: 1000 }, espresso: { mg: 63, label: 'Espresso', ml: 50 }, te: { mg: 40, label: 'Té', ml: 250 } };
// Líquido de las bebidas con cafeína (mate, café, té) — también hidrata.
function caffeineFluidMl(dayKey) {
  const log = (getDay(dayKey).caffeineLog) || [];
  return log.reduce((a, e) => a + ((CAFFEINE[e.type] && CAFFEINE[e.type].ml) || 0), 0);
}
const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function addCaffeine(date, type) {
  const c = CAFFEINE[type]; if (!c) return;
  mutate(s => { const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.caffeineLog = d.caffeineLog || []; d.caffeineLog.push({ id: uid(), type, label: c.label, mg: c.mg, time: nowHM() }); d.caffeineMg = (d.caffeineLog).reduce((a, e) => a + num(e.mg), 0); });
}
function removeCaffeine(date, id) {
  mutate(s => { const d = s.fitness.days[date]; if (!d || !d.caffeineLog) return; d.caffeineLog = d.caffeineLog.filter(e => e.id !== id); d.caffeineMg = d.caffeineLog.reduce((a, e) => a + num(e.mg), 0); });
}
const ACTIVITIES = { caminata: { met: 3.5, label: 'Caminata', emoji: '🚶' }, tenis: { met: 7, label: 'Tenis', emoji: '🎾' }, padel: { met: 6, label: 'Pádel', emoji: '🎾' }, correr: { met: 9.5, label: 'Correr', emoji: '🏃' }, bici: { met: 6, label: 'Bici', emoji: '🚴' }, otro: { met: 5, label: 'Otro', emoji: '💪' } };
const INTENSITY = { suave: { m: 0.8, label: 'Suave' }, moderado: { m: 1.0, label: 'Moderado' }, intenso: { m: 1.25, label: 'Intenso' } };
function logMovement(date, type, minutes) {
  const a = ACTIVITIES[type]; if (!a || !minutes) return;
  const w = effectiveWeight();
  const inten = INTENSITY[actIntensity] || INTENSITY.moderado;
  const kcal = Math.round(a.met * inten.m * w * (minutes / 60));
  mutate(s => { const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.activityLog = d.activityLog || []; d.activityLog.push({ id: uid(), type, label: a.label, emoji: a.emoji, minutes: num(minutes), kcal, intensity: actIntensity, intensityLabel: inten.label, time: nowHM() }); });
}
function removeMovement(date, id) {
  mutate(s => { const d = s.fitness.days[date]; if (!d || !d.activityLog) return; d.activityLog = d.activityLog.filter(e => e.id !== id); });
}
function patchHabit(date, id, checked) {
  mutate(s => {
    const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.habits = d.habits || {}; d.habits[id] = checked;
    // marcar el padre también marca/desmarca todos sus sub-items
    const h = ALL_HABITS.find(x => x.id === id);
    if (h && h.steps) for (const st of h.steps) d.habits[id + '__' + st.id] = checked;
  });
}
function patchHabitStep(date, hid, sid, checked) {
  mutate(s => {
    const d = s.fitness.days[date] || (s.fitness.days[date] = {}); d.habits = d.habits || {}; d.habits[hid + '__' + sid] = checked;
    const h = ALL_HABITS.find(x => x.id === hid);
    if (h && h.steps) d.habits[hid] = h.steps.every(st => d.habits[hid + '__' + st.id]); // padre = todos tildados
  });
}
function cycleSore(region) {
  const k = tk();
  mutate(s => { const d = s.fitness.days[k] || (s.fitness.days[k] = {}); d.soreness = d.soreness || {}; const lvl = (d.soreness[region] || 0); const nx = (lvl + 1) % 4; if (nx === 0) delete d.soreness[region]; else d.soreness[region] = nx; });
}
function addFood(f) {
  const k = tk();
  mutate(s => { const d = s.fitness.days[k] || (s.fitness.days[k] = {}); d.meals = d.meals || []; d.meals.push({ id: uid(), name: f.name, emoji: f.emoji || '', kcal: num(f.kcal), protein: num(f.protein), ts: Date.now() }); d.calories = num(d.calories) + num(f.kcal); d.protein = num(d.protein) + num(f.protein); });
}
function removeMeal(id) {
  const k = tk();
  mutate(s => { const d = s.fitness.days[k]; if (!d || !d.meals) return; const m = d.meals.find(x => x.id === id); if (!m) return; d.meals = d.meals.filter(x => x.id !== id); d.calories = Math.max(0, num(d.calories) - num(m.kcal)); d.protein = Math.max(0, num(d.protein) - num(m.protein)); });
}

// ---- cálculos ----
function targets(p) {
  const w = effectiveWeight(), h = num(p.heightCm), a = num(p.age);
  if (!w || !h || !a) return null;
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === 'female' ? -161 : 5);
  const factor = ACTIVITY_FACTORS[p.activity] || 1.55;
  const maintenance = Math.round(bmr * factor / 10) * 10;
  const goal = p.goal || 'gain';
  let target = maintenance;
  if (goal === 'gain') target = Math.round(maintenance * (1 + num(p.surplusPct, 12) / 100) / 10) * 10;
  else if (goal === 'cut') target = Math.round(maintenance * 0.85 / 10) * 10;
  return { bmr: Math.round(bmr), maintenance, target, protein: Math.round(w * num(p.proteinPerKg, 1.8)), goal };
}
function weighSorted() { return [...(F().weighIns || [])].filter(w => w.date && Number.isFinite(+w.kg)).sort((a, b) => a.date < b.date ? -1 : 1); }
// Peso para cálculos: usa tu último pesaje si existe (así no hace falta actualizar el perfil a mano).
function effectiveWeight() { const ws = weighSorted(); return ws.length ? +ws[ws.length - 1].kg : num(F().profile?.weightKg, 75); }
function trend(ws) {
  ws = ws || weighSorted();
  if (ws.length < 2) return { points: ws, ratePerWeek: null, spanDays: 0, reliable: false };
  const first = ws[0], last = ws[ws.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  // Un ritmo semanal solo es confiable con suficiente ventana de tiempo (>=10 días).
  // Con pocos días, el peso varía por agua/comida y el ritmo extrapolado engaña.
  const reliable = days >= 10 && ws.length >= 3;
  return { points: ws, ratePerWeek: days > 0 ? (last.kg - first.kg) / days * 7 : null, spanDays: Math.round(days), reliable, first, last };
}
function avgField(days, n, field) {
  const keys = Object.keys(days || {}).sort().slice(-n); let sum = 0, cnt = 0;
  for (const k of keys) { const v = num((days[k] || {})[field]); if (v > 0) { sum += v; cnt++; } }
  return cnt ? sum / cnt : null;
}
function avgIntake(days, n) {
  const tkey = todayKey(); // excluir el día de hoy (está incompleto)
  const keys = Object.keys(days || {}).filter(kk => kk !== tkey).sort().slice(-n); let cal = 0, prot = 0, cnt = 0;
  for (const k of keys) { const d = days[k]; if (d && (num(d.calories) || num(d.protein))) { cal += num(d.calories); prot += num(d.protein); cnt++; } }
  return cnt ? { calories: Math.round(cal / cnt), protein: Math.round(prot / cnt), count: cnt } : null;
}
const fmtTime = (ts) => { if (!ts) return ''; const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
// Alerta de ritmo de comida según la hora del día (no molesta si vas en buen ritmo).
function todayPaceAlert(dayKey, t) {
  if (!t) return null;
  const cal = num(getDay(dayKey).calories);
  const now = new Date(); const hour = now.getHours() + now.getMinutes() / 60;
  const dayStart = 8, eatEnd = 21;
  if (hour < dayStart + 1.5) return null; // muy temprano
  const frac = Math.min(1, Math.max(0, (hour - dayStart) / (eatEnd - dayStart)));
  const expected = t.target * frac;
  if (cal >= t.target) return { level: 'ok', text: `✅ Llegaste a tu objetivo de hoy (${cal}/${t.target} kcal).` };
  if (cal >= expected * 0.85) return null; // buen ritmo, sin alerta
  const faltan = Math.round(t.target - cal);
  if (hour >= 18.5) return { level: 'warn', text: `Queda poco día y vas en ${cal}/${t.target} kcal. Te faltan ~${faltan} para llegar — meté una comida grande o un snack calórico (batido, maní, frutos secos).` };
  if (hour >= 12.5) return { level: 'info', text: `Para esta hora convendría ir cerca de ${Math.round(expected)} kcal y vas en ${cal}. Sumá algo en el almuerzo/merienda para no quedar corto al final.` };
  return { level: 'info', text: `Vas algo lento para tu objetivo (${cal}/${t.target} kcal). Aprovechá las próximas comidas.` };
}
// Aviso si pasaron muchas horas sin comer.
function mealGapAlert(dayKey) {
  const meals = getDay(dayKey).meals || [];
  if (!meals.length) return null;
  const hour = new Date().getHours();
  if (hour < 9 || hour >= 22) return null;
  const last = Math.max(...meals.map(m => m.ts || 0));
  const hrs = (Date.now() - last) / 3600000;
  if (hrs >= 5) return { level: 'info', text: `Hace ~${Math.round(hrs)} h que no registrás una comida. Si querés llegar a tu objetivo (o vas a entrenar), buen momento para comer algo.` };
  return null;
}

// ---- Plan de comidas (qué comer ahora y a qué hora) ----
const MEAL_SLOTS = [
  { id: 'desayuno', label: 'Desayuno', hour: 8 },
  { id: 'almuerzo', label: 'Almuerzo', hour: 13 },
  { id: 'merienda', label: 'Merienda', hour: 17 },
  { id: 'cena', label: 'Cena', hour: 21 },
];
const MEAL_IDEAS = [
  { name: 'Tostadas integrales + 3 huevos + palta', kcal: 500, protein: 28, slots: ['desayuno'] },
  { name: 'Yogur griego + avena + banana + maní', kcal: 520, protein: 30, slots: ['desayuno', 'merienda'] },
  { name: 'Omelette de 3 huevos + queso + pan', kcal: 480, protein: 32, slots: ['desayuno', 'cena'] },
  { name: 'Pollo a la plancha + arroz + ensalada', kcal: 620, protein: 50, slots: ['almuerzo', 'cena'] },
  { name: 'Carne magra + papa + verduras', kcal: 650, protein: 48, slots: ['almuerzo', 'cena'] },
  { name: 'Atún + arroz + ensalada', kcal: 520, protein: 42, slots: ['almuerzo', 'cena'] },
  { name: 'Salmón + boniato + brócoli', kcal: 600, protein: 42, slots: ['almuerzo', 'cena'] },
  { name: 'Wrap integral de pollo + queso', kcal: 560, protein: 38, slots: ['almuerzo', 'cena'] },
  { name: 'Lentejas + arroz + huevo', kcal: 600, protein: 32, slots: ['almuerzo', 'cena'] },
  { name: 'Batido (leche+banana+avena+maní+whey)', kcal: 550, protein: 40, slots: ['merienda', 'snack'] },
  { name: 'Yogur griego + frutos secos', kcal: 300, protein: 20, slots: ['merienda', 'snack'] },
  { name: 'Queso + nueces + fruta', kcal: 320, protein: 14, slots: ['merienda', 'snack'] },
  { name: 'Fruta + mantequilla de maní', kcal: 250, protein: 8, slots: ['snack'] },
];
function nextMealPlan(dayKey, t) {
  if (!t) return null;
  const d = getDay(dayKey);
  const remKcal = Math.max(0, t.target - num(d.calories));
  const remProt = Math.max(0, t.protein - num(d.protein));
  const now = new Date(); const hour = now.getHours() + now.getMinutes() / 60;
  let upcoming = MEAL_SLOTS.filter(s => s.hour >= hour - 1);
  if (!upcoming.length) upcoming = [{ id: 'snack', label: 'Snack', hour: Math.min(22, Math.ceil(hour)) }];
  const slotsLeft = upcoming.length;
  return { remKcal, remProt, next: upcoming[0], slotsLeft, perKcal: Math.round(remKcal / slotsLeft / 10) * 10, perProt: Math.round(remProt / slotsLeft), upcoming };
}
// Pool = ideas generales + tus comidas guardadas (Mis comidas / Para sumar masa).
function ideaPool() {
  const fl = (F().foodLibrary || []).filter(x => x.group === 'Mis comidas' || x.group === 'Para sumar masa');
  return [...fl.map(x => ({ name: x.name, kcal: num(x.kcal), protein: num(x.protein), emoji: x.emoji, mine: true })), ...MEAL_IDEAS];
}
function pickIdeas(slotId, perKcal, perProt) {
  let pool = ideaPool().filter(m => !m.slots || m.slots.includes(slotId));
  if (pool.length < 3) pool = ideaPool();
  return pool.map(m => ({ m, score: Math.abs(m.kcal - perKcal) - (m.protein >= perProt * 0.8 ? 80 : 0) - (m.mine ? 40 : 0) }))
    .sort((a, b) => a.score - b.score).slice(0, 3).map(x => x.m);
}
let lastDietaIdeas = [], lastRepeatMeals = [];
function logMealIdea(idea) {
  const k = tk();
  mutate(s => { const d = s.fitness.days[k] || (s.fitness.days[k] = {}); d.meals = d.meals || []; d.meals.push({ id: uid(), name: idea.name, emoji: idea.emoji || '🍽️', kcal: num(idea.kcal), protein: num(idea.protein), ts: Date.now() }); d.calories = num(d.calories) + num(idea.kcal); d.protein = num(d.protein) + num(idea.protein); });
}
// Por qué recomiendo esta opción ahora.
function whyFor(idea, perKcal, perProt) {
  const bits = []; const n = (idea.name || '').toLowerCase();
  if (idea.protein >= perProt) bits.push('cubre la proteína que te falta');
  else if (idea.protein >= perProt * 0.7) bits.push('buen aporte de proteína');
  if (Math.abs(idea.kcal - perKcal) <= perKcal * 0.2) bits.push('encaja con las calorías que te quedan');
  else if (idea.kcal < perKcal) bits.push('liviana, te deja margen');
  if (/salm|at[uú]n|pescado|sardina|sushi/.test(n)) bits.push('omega-3 (corazón y anti-edad)');
  else if (/yogur|leche|queso|ricota/.test(n)) bits.push('calcio + proteína');
  else if (/ensalada|verdura|br[oó]coli|palta|fruta|banana/.test(n)) bits.push('fibra y micronutrientes');
  else if (/avena|integral|arroz|papa|boniato/.test(n)) bits.push('carbos para energía/recuperación');
  else if (/nueces|man[ií]/.test(n)) bits.push('grasas buenas (vit. E)');
  return bits.length ? bits.join(' · ') : 'opción equilibrada para este momento';
}
// Análisis de balance de la semana: detecta grupos que faltan (incluye foco anti-edad).
const NUTRIENT_GROUPS = [
  { id: 'verduras', label: 'verduras / hojas verdes', kw: ['ensalada', 'verdura', 'vegetal', 'brócoli', 'brocoli', 'espinaca', 'rúcula', 'rucula', 'tomate', 'zanahoria', 'kale'], tip: 'Sumá verduras de hoja (espinaca, rúcula, kale): hierro, folato y antioxidantes que frenan el envejecimiento.' },
  { id: 'fruta', label: 'frutas', kw: ['fruta', 'banana', 'manzana', 'berries', 'frutilla', 'arándano', 'arandano', 'naranja', 'kiwi'], tip: 'Sumá fruta, sobre todo berries/arándanos: vitamina C y polifenoles (anti-edad).' },
  { id: 'pescado', label: 'pescado graso', kw: ['salmón', 'salmon', 'atún', 'atun', 'sardina', 'pescado', 'trucha', 'sushi'], tip: 'Pescado graso 2×/semana (salmón, sardinas): omega-3, clave para corazón, cerebro y anti-inflamación.' },
  { id: 'lacteos', label: 'lácteos', kw: ['yogur', 'queso', 'leche', 'ricota'], tip: 'Lácteos/yogur: calcio y proteína para huesos y músculo.' },
  { id: 'legumbres', label: 'legumbres', kw: ['lenteja', 'garbanzo', 'poroto', 'legumbre'], tip: 'Legumbres 1–2×/semana: fibra, hierro vegetal y saciedad.' },
  { id: 'frutos_secos', label: 'frutos secos', kw: ['nueces', 'maní', 'mani', 'almendra', 'frutos secos'], tip: 'Un puñado de nueces/almendras: grasas buenas y vitamina E (anti-edad).' },
];
function balanceCheck() {
  const f = F(); const cutoff = todayKey(addDays(new Date(), -6));
  const names = [];
  for (const [dk, d] of Object.entries(f.days || {})) { if (dk < cutoff) continue; for (const m of (d.meals || [])) names.push((m.name || '').toLowerCase()); }
  if (!names.length) return [{ level: 'info', text: 'Registrá tus comidas unos días y acá te marco si te falta algún grupo (verduras, pescado, etc.) y qué sumar para una dieta balanceada y anti-edad.' }];
  const text = names.join(' | ');
  const out = [];
  for (const g of NUTRIENT_GROUPS) if (!g.kw.some(w => text.includes(w))) out.push({ level: 'warn', text: `Esta semana no registré ${g.label}. ${g.tip}` });
  if (!out.length) out.push({ level: 'ok', text: 'Buena variedad esta semana 👌. Mantené el pescado graso, las hojas verdes y los berries por el lado anti-edad.' });
  out.push({ level: 'info', text: 'Extra anti-edad: aceite de oliva extra virgen, té verde y un cuadradito de chocolate amargo (>70%) suman antioxidantes.' });
  return out;
}
// Calorías quemadas por ejercicio en un día (actividades cargadas + sesiones de gym).
// Se SUMAN al objetivo del día para mantener el superávit (el factor de actividad del perfil es sin ejercicio).
// Total de series de gym registradas en un día (escala el gasto con lo que realmente hiciste).
function gymSetsForDay(dayKey) {
  let sets = 0;
  for (const l of (F().workoutLogs || [])) {
    if (l.date !== dayKey) continue;
    for (const e of (l.entries || [])) sets += (e.setLog ? e.setLog.length : num(e.sets));
  }
  return sets;
}
function exerciseKcal(dayKey) {
  const f = F(); const d = f.days[dayKey] || {}; const w = effectiveWeight();
  let k = (d.activityLog || []).reduce((a, e) => a + num(e.kcal), 0);
  // Gym: ~por serie (incluye descanso, MET ~5). Si hacés medio plan, suma la mitad.
  k += gymSetsForDay(dayKey) * Math.round(5 * w * 3.5 / 60);
  return Math.round(k);
}
// Meta de agua dinámica: base por peso + extra por ejercicio (más si es aeróbico/intenso) + transpiración declarada.
const SWEAT_RATE = { suave: 6, moderado: 9, intenso: 12 }; // ml por minuto de actividad
function waterGoalFor(dayKey) {
  const f = F(); const w = effectiveWeight();
  const base = Math.max(2500, Math.round(35 * w / 50) * 50);
  const d = f.days[dayKey] || {};
  let extra = 0;
  for (const e of (d.activityLog || [])) extra += Math.round(num(e.minutes) * (SWEAT_RATE[e.intensity] || 8));
  extra += gymSetsForDay(dayKey) * 22; // gym: ~por serie, escala con lo que hiciste
  extra += num(d.sweatExtra); // "transpiré mucho / calor"
  return { goal: Math.round((base + extra) / 50) * 50, base, extra: Math.round(extra / 50) * 50 };
}
// Objetivo de calorías para un día puntual = base + ejercicio de ese día.
function dayTargets(dayKey) {
  const t = targets(F().profile); if (!t) return null;
  const ex = exerciseKcal(dayKey);
  return { ...t, exercise: ex, baseTarget: t.target, baseMaintenance: t.maintenance, target: t.target + ex, maintenance: t.maintenance + ex };
}

function lastWorkout() { return [...(F().workoutLogs || [])].sort((a, b) => a.date < b.date ? 1 : -1)[0] || null; }
function trainingSuggestions() {
  const lw = lastWorkout(); const blocks = [];
  blocks.push({ title: '☀️ Apenas te levantes', items: [
    { time: '07:00', text: 'Luz natural 5–10 min + un vaso de agua.' },
    { time: '07:15', text: 'Movilidad suave: gato-camello, rodillas al pecho, círculos de cadera y tobillo (5 min).' },
    { time: '07:45', text: 'Meditación 10 min antes de arrancar el día.' },
  ]});
  if (lw) {
    const name = (lw.dayName || '').toLowerCase();
    const daysAgo = Math.round((new Date(tk()) - new Date(lw.date)) / 86400000);
    const when = daysAgo <= 0 ? 'hoy' : daysAgo === 1 ? 'ayer' : `hace ${daysAgo} días`;
    let items;
    if (name.includes('inferior') || name.includes('potencia')) items = [
      { time: '07:20', text: 'Cuádriceps/isquios/glúteos: estiramiento suave 8–10 min (sin rebotes).' },
      { time: 'mediodía', text: 'Caminata ligera 15–20 min: baja agujetas mejor que el reposo total.' },
      { time: '21:45', text: 'Foam roll de cuádriceps y glúteos + estiramiento lumbar.' },
      { time: 'ojo', text: 'Dejá ~24–48 h antes de un partido de tenis para no jugar con las piernas cargadas.' },
    ];
    else if (name.includes('empuje')) items = [
      { time: '07:20', text: 'Movilidad torácica + estiramiento de pecho en el marco de la puerta (2×30 s).' },
      { time: 'tarde', text: 'Face pulls con banda 2×15 para cuidar el hombro.' },
      { time: '21:45', text: 'Estiramiento suave de hombros y cuello; aflojá trapecios.' },
    ];
    else if (name.includes('jalón') || name.includes('jalon')) items = [
      { time: '07:20', text: 'Movilidad torácica + estiramiento de dorsal y bíceps (2×30 s).' },
      { time: 'tarde', text: 'Colgarte de la barra 2×20–30 s para descomprimir la columna.' },
      { time: '21:45', text: 'Estiramiento de antebrazos (clave para el tenis).' },
    ];
    else items = [
      { time: '07:20', text: 'Estiramiento general suave 8–10 min de lo que sientas cargado.' },
      { time: '21:45', text: 'Foam roll + movilidad de las zonas trabajadas.' },
    ];
    blocks.push({ title: `🧘 Recuperación de tu último entreno (${escapeHtml(lw.dayName || '—')}, ${when})`, items });
  }
  const bt = bedtimeHour();
  blocks.push({ title: '🌙 Antes de dormir', items: [
    { time: hhmm(bt - 2), text: 'Lectura 20–30 min, luz baja, sin pantallas de trabajo.' },
    { time: hhmm(bt - 0.5), text: 'Estiramiento ligero de cadera y zona lumbar.' },
    { time: hhmm(bt), text: `Acostarte ~${hhmm(bt)}, misma hora siempre: el sueño es el mayor motor de masa y recuperación.` },
  ]});
  return blocks;
}

function recommendations() {
  const f = F(); const p = f.profile; const t = targets(p); const out = [];
  if (!t) { out.push({ level: 'info', text: 'Completá tu perfil (peso, altura, edad) en Perfil para calcular tus metas.' }); return out; }
  const tr = trend();
  if (tr.ratePerWeek == null) out.push({ level: 'info', text: 'Cargá al menos 2 pesajes con varios días de diferencia para evaluar tu tendencia.' });
  else if (!tr.reliable) out.push({ level: 'info', text: `Llevás ${tr.spanDays} día(s) de pesajes. Pesate durante ~2 semanas para calcular bien el ritmo (de un día a otro el peso varía por agua y comida).` });
  else {
    const r = tr.ratePerWeek, w = num(p.weightKg), lo = w * 0.0025, hi = w * 0.005, sg = r >= 0 ? '+' : '';
    if (r < lo) out.push({ level: 'warn', text: `Casi estancado (${sg}${r.toFixed(2)} kg/sem). Para sumar masa, subí ~200–300 kcal/día.` });
    else if (r > hi) out.push({ level: 'warn', text: `Subís rápido (+${r.toFixed(2)} kg/sem); puede ser grasa. Bajá ~150–200 kcal/día.` });
    else out.push({ level: 'ok', text: `Ritmo ideal de masa magra (+${r.toFixed(2)} kg/sem). Mantené las calorías.` });
  }
  const a = avgIntake(f.days, 7);
  if (a) {
    if (a.calories < t.maintenance) out.push({ level: 'warn', text: `Promedio ${a.calories} kcal, bajo tu mantenimiento (${t.maintenance}). Así no sumás: apuntá a ${t.target}.` });
    else if (a.calories < t.target - 100) out.push({ level: 'info', text: `Sobre mantenimiento pero bajo el objetivo (${t.target}). Sumá ~${t.target - a.calories} kcal/día.` });
    else out.push({ level: 'ok', text: `Calorías en superávit (prom ${a.calories}). Bien.` });
    if (a.protein < t.protein * 0.9) out.push({ level: 'warn', text: `Proteína baja (prom ${a.protein} g vs ${t.protein} g). Sumá una fuente proteica por comida.` });
    else out.push({ level: 'ok', text: `Proteína en objetivo (prom ${a.protein} g). Clave para el músculo.` });
  } else out.push({ level: 'info', text: 'Registrá tus comidas unos días (pestaña Comidas) para ajustar calorías y proteína.' });
  const sleep = avgField(f.days, 7, 'sleepHours');
  if (sleep != null) {
    if (sleep < 7) out.push({ level: 'warn', text: `Dormís ${sleep.toFixed(1)} h prom. Apuntá a 7.5–8: con poco sueño cae la recuperación y la síntesis muscular.` });
    else out.push({ level: 'ok', text: `Sueño en buen rango (${sleep.toFixed(1)} h prom).` });
  }
  const dHoy = getDay(tk());
  const totalCaf = num(dHoy.caffeineMg);
  const cutoff = caffeineCutoff();
  const lateCaf = (dHoy.caffeineLog || []).find(e => e.time && e.time >= cutoff);
  if (totalCaf > 400) out.push({ level: 'warn', text: `Cafeína alta hoy (${totalCaf} mg). Pasando ~400 mg puede ponerte ansioso y afectar el sueño.` });
  if (lateCaf) out.push({ level: 'warn', text: `Tomaste cafeína a las ${lateCaf.time}. Como te dormís ${hhmm(bedtimeHour())}, conviene cortarla antes de las ${cutoff} (su vida media es ~5–6 h) para no recortar tu sueño profundo.` });
  return out;
}

// ---- charts ----
const fmtDay = (key) => { if (!key) return ''; const [, m, d] = key.split('-'); return `${d}/${m}`; };
function chartLine(series, opts = {}) {
  const pts = series.filter(s => Number.isFinite(s.value));
  if (pts.length < 2) return '<div class="muted text-xs">Pocos datos todavía (cargá al menos 2).</div>';
  const W = 600, H = 150, padL = 32, padR = 14, padT = 14, padB = 20;
  const vals = pts.map(p => p.value); let min = Math.min(...vals), max = Math.max(...vals);
  if (opts.refValue != null) { min = Math.min(min, opts.refValue); max = Math.max(max, opts.refValue); }
  const span = (max - min) || 1;
  const x = i => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = v => H - padB - ((v - min) / span) * (H - padT - padB);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.6" fill="${opts.color || 'var(--accent)'}"/>`).join('');
  const ref = opts.refValue != null ? `<line x1="${padL}" x2="${W - padR}" y1="${y(opts.refValue).toFixed(1)}" y2="${y(opts.refValue).toFixed(1)}" stroke="var(--text-4)" stroke-dasharray="4 4"/>` : '';
  const dec = opts.dec ?? 0;
  return `<svg viewBox="0 0 ${W} ${H}" class="fit-chart">
    <text x="2" y="${(y(max) + 3).toFixed(1)}" class="fit-chart-lbl">${(+max).toFixed(dec)}</text>
    <text x="2" y="${(y(min) + 3).toFixed(1)}" class="fit-chart-lbl">${(+min).toFixed(dec)}</text>${ref}
    <path d="${d}" fill="none" stroke="${opts.color || 'var(--accent)'}" stroke-width="2"/>${dots}
    <text x="${padL}" y="${H - 5}" class="fit-chart-lbl">${escapeHtml(pts[0].label)}</text>
    <text x="${W - padR}" y="${H - 5}" text-anchor="end" class="fit-chart-lbl">${escapeHtml(pts[pts.length - 1].label)}</text>
  </svg>`;
}
function chartBars(series, opts = {}) {
  const pts = series.filter(s => Number.isFinite(s.value));
  if (!pts.length) return '<div class="muted text-xs">Sin datos en el período.</div>';
  const W = 600, H = 150, padL = 32, padR = 14, padT = 14, padB = 20;
  const max = Math.max(...pts.map(p => p.value), opts.refValue || 0) || 1;
  const bw = (W - padL - padR) / pts.length;
  const y = v => H - padB - (v / max) * (H - padT - padB);
  const bars = pts.map((p, i) => { const h = (H - padB) - y(p.value); const under = opts.refValue != null && p.value < opts.refValue; return `<rect x="${(padL + i * bw + bw * 0.15).toFixed(1)}" y="${y(p.value).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${under ? 'var(--red)' : (opts.color || 'var(--accent)')}"/>`; }).join('');
  const ref = opts.refValue != null ? `<line x1="${padL}" x2="${W - padR}" y1="${y(opts.refValue).toFixed(1)}" y2="${y(opts.refValue).toFixed(1)}" stroke="var(--text-4)" stroke-dasharray="4 4"/><text x="${W - padR}" y="${(y(opts.refValue) - 3).toFixed(1)}" text-anchor="end" class="fit-chart-lbl">obj ${opts.refValue}</text>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="fit-chart"><text x="2" y="12" class="fit-chart-lbl">${max.toFixed(0)}</text>${ref}${bars}<text x="${padL}" y="${H - 5}" class="fit-chart-lbl">${escapeHtml(pts[0].label)}</text><text x="${W - padR}" y="${H - 5}" text-anchor="end" class="fit-chart-lbl">${escapeHtml(pts[pts.length - 1].label)}</text></svg>`;
}

// ---- body map ----
const SOREL = { 0: 'rgba(255,255,255,0.05)', 1: 'rgba(240,185,82,0.55)', 2: 'rgba(224,148,84,0.75)', 3: 'rgba(226,107,107,0.85)' };
const SIL = `<g fill="var(--surface-2)" stroke="var(--border-2)" stroke-width="1.2">
  <circle cx="70" cy="22" r="11"/><rect x="52" y="40" width="36" height="66" rx="12"/>
  <rect x="28" y="44" width="14" height="58" rx="7"/><rect x="98" y="44" width="14" height="58" rx="7"/>
  <rect x="50" y="104" width="16" height="74" rx="8"/><rect x="74" y="104" width="16" height="74" rx="8"/></g>`;
const lbl = (x, y, t) => `<text x="${x}" y="${y + 2}" class="fit-zlbl">${t}</text>`;
// FRONT: la persona nos mira → su DERECHA está a la izquierda del dibujo.
const FRONT = [
  ['hombros_der',     f => `<ellipse cx="50" cy="50" rx="11" ry="7" fill="${f}"/>${lbl(50, 50, 'D')}`],
  ['hombros_izq',     f => `<ellipse cx="90" cy="50" rx="11" ry="7" fill="${f}"/>${lbl(90, 50, 'I')}`],
  ['pecho',           f => `<rect x="55" y="54" width="30" height="22" rx="6" fill="${f}"/>`],
  ['biceps_der',      f => `<ellipse cx="39" cy="72" rx="7" ry="13" fill="${f}"/>${lbl(39, 72, 'D')}`],
  ['biceps_izq',      f => `<ellipse cx="101" cy="72" rx="7" ry="13" fill="${f}"/>${lbl(101, 72, 'I')}`],
  ['abdominales',     f => `<rect x="58" y="78" width="24" height="26" rx="5" fill="${f}"/>`],
  ['antebrazos_der',  f => `<ellipse cx="32" cy="98" rx="6" ry="14" fill="${f}"/>${lbl(32, 98, 'D')}`],
  ['antebrazos_izq',  f => `<ellipse cx="108" cy="98" rx="6" ry="14" fill="${f}"/>${lbl(108, 98, 'I')}`],
  ['cuadriceps_der',  f => `<rect x="52" y="108" width="14" height="38" rx="6" fill="${f}"/>${lbl(59, 128, 'D')}`],
  ['cuadriceps_izq',  f => `<rect x="74" y="108" width="14" height="38" rx="6" fill="${f}"/>${lbl(81, 128, 'I')}`],
];
// BACK: vemos su espalda → su DERECHA está a la derecha del dibujo.
const BACK = [
  ['trapecios',     f => `<ellipse cx="70" cy="46" rx="16" ry="8" fill="${f}"/>`],
  ['espalda',       f => `<rect x="54" y="54" width="32" height="24" rx="6" fill="${f}"/>`],
  ['triceps_izq',   f => `<ellipse cx="39" cy="72" rx="7" ry="13" fill="${f}"/>${lbl(39, 72, 'I')}`],
  ['triceps_der',   f => `<ellipse cx="101" cy="72" rx="7" ry="13" fill="${f}"/>${lbl(101, 72, 'D')}`],
  ['lumbares',      f => `<rect x="60" y="80" width="20" height="16" rx="4" fill="${f}"/>`],
  ['gluteos_izq',   f => `<ellipse cx="62" cy="102" rx="9" ry="8" fill="${f}"/>${lbl(62, 102, 'I')}`],
  ['gluteos_der',   f => `<ellipse cx="78" cy="102" rx="9" ry="8" fill="${f}"/>${lbl(78, 102, 'D')}`],
  ['isquios_izq',   f => `<rect x="52" y="112" width="14" height="30" rx="6" fill="${f}"/>${lbl(59, 128, 'I')}`],
  ['isquios_der',   f => `<rect x="74" y="112" width="14" height="30" rx="6" fill="${f}"/>${lbl(81, 128, 'D')}`],
  ['gemelos_izq',   f => `<rect x="53" y="150" width="12" height="26" rx="5" fill="${f}"/>${lbl(59, 164, 'I')}`],
  ['gemelos_der',   f => `<rect x="75" y="150" width="12" height="26" rx="5" fill="${f}"/>${lbl(81, 164, 'D')}`],
];
const REGION_LABEL = {
  hombros_der: 'Hombro derecho', hombros_izq: 'Hombro izquierdo', pecho: 'Pecho',
  biceps_der: 'Bíceps derecho', biceps_izq: 'Bíceps izquierdo', abdominales: 'Abdominales',
  antebrazos_der: 'Antebrazo derecho', antebrazos_izq: 'Antebrazo izquierdo',
  cuadriceps_der: 'Cuádriceps derecho', cuadriceps_izq: 'Cuádriceps izquierdo',
  trapecios: 'Trapecios', espalda: 'Espalda', triceps_der: 'Tríceps derecho', triceps_izq: 'Tríceps izquierdo',
  lumbares: 'Lumbares', gluteos_der: 'Glúteo derecho', gluteos_izq: 'Glúteo izquierdo',
  isquios_der: 'Isquio derecho', isquios_izq: 'Isquio izquierdo', gemelos_der: 'Gemelo derecho', gemelos_izq: 'Gemelo izquierdo',
};
const baseRegion = (r) => r.replace(/_(der|izq)$/, '');
function bodyMapSVG(view, sore) {
  const zones = (view === 'front' ? FRONT : BACK).map(([r, fn]) => `<g class="fit-zone" data-region="${r}">${fn(SOREL[sore[r] || 0])}</g>`).join('');
  return `<svg viewBox="0 0 140 190" class="fit-body-svg">${SIL}${zones}</svg>`;
}
const SORE_TIPS = {
  lumbares: 'Lumbar cargada: evitá peso muerto/sentadilla pesada hoy. Hacé gato-camello, rodillas al pecho y movilidad de cadera. Si el dolor es agudo o irradia a la pierna, frená.',
  isquios: 'Isquios cargados: estiramiento suave y caminata; evitá rumano pesado hasta que aflojen.',
  cuadriceps: 'Cuádriceps cargados: foam roll + caminata ligera; ojo antes de un partido de tenis.',
  gemelos: 'Gemelos cargados: estirá contra la pared y movilidad de tobillo; importan para frenar y arrancar en la cancha.',
  hombros: 'Hombro cargado: priorizá face pulls y movilidad; evitá press pesado por encima de la cabeza hoy. Si es el del lado de tu derecha de tenis, cuidalo extra.',
  pecho: 'Pecho cargado: estiramiento en el marco de la puerta; bajá volumen de empuje si sigue.',
  espalda: 'Espalda cargada: colgarte de la barra para descomprimir + movilidad torácica.',
  gluteos: 'Glúteo cargado: estiramiento de glúteo (figura 4) y caminata suave.',
  trapecios: 'Trapecios cargados: aflojá cuello/hombros con movilidad suave y respiración.',
  biceps: 'Bíceps cargado: estiramiento suave; no fuerces jalones pesados hoy.',
  triceps: 'Tríceps cargado: estiramiento por encima de la cabeza; cuidá los empujes.',
  antebrazos: 'Antebrazo cargado: clave para el tenis (codo de tenista). Estirá muñeca/antebrazo, masajeá suave y evitá agarres intensos; si es el de tu mano dominante, no fuerces.',
  abdominales: 'Core cargado: trabajo liviano de movilidad; el core se recupera rápido.',
};

// ---- bodies ----
// Opciones proteicas para cerrar el día (merienda/cena).
const CLOSE_IDEAS = [
  { name: 'Yogur griego (170 g) + 30 g de maní', k: 320, p: 24 },
  { name: 'Batido: whey + banana + leche', k: 350, p: 35 },
  { name: 'Pechuga de pollo (200 g) + 1 taza de arroz', k: 520, p: 52 },
  { name: 'Atún (1 lata) + 2 huevos + pan', k: 420, p: 42 },
  { name: 'Requesón/ricota (200 g) + frutos rojos', k: 280, p: 28 },
  { name: 'Caseína o barra de proteína', k: 200, p: 25 },
];
// Tarjeta "cómo cerrar el día": calcula lo que falta y sugiere comidas para llegar.
function closeTheDayCard(k, t) {
  const d = getDay(k); const cal = num(d.calories), prot = num(d.protein);
  const gapCal = t.target - cal, gapProt = t.protein - prot;
  if (gapCal <= 120 && gapProt <= 6)
    return `<div class="card"><div class="card-title">Cierre del día</div><div class="fit-alert ok">✅ Llegaste a tus objetivos de hoy (${cal}/${t.target} kcal · ${prot}/${t.protein} g proteína). Buenísimo.</div></div>`;
  // Prioriza opciones cuya proteína se acerca a lo que falta.
  const ideas = [...CLOSE_IDEAS].sort((a, b) => Math.abs(a.p - Math.max(0, gapProt)) - Math.abs(b.p - Math.max(0, gapProt))).slice(0, 4);
  const items = ideas.map(o => `<div class="fit-move"><div class="fit-move-n">${escapeHtml(o.name)}</div><div class="fit-move-cue">~${o.k} kcal · ${o.p} g proteína</div></div>`).join('');
  return `<div class="card"><div class="card-title">Cómo cerrar el día</div>
    <div class="fit-alert info">Te faltan <b>~${Math.max(0, Math.round(gapCal))} kcal</b> y <b>~${Math.max(0, Math.round(gapProt))} g de proteína</b>. Elegí 1–2 de estas para llegar:</div>
    ${items}</div>`;
}
// Cuenta días consecutivos (hacia atrás) que cumplen una condición. Hoy incompleto no rompe la racha.
function streakDays(predFn) {
  const days = F().days || {};
  let count = 0;
  for (let i = 0; i < 400; i++) {
    const rec = days[todayKey(addDays(new Date(), -i))];
    const ok = rec && predFn(rec);
    if (ok) count++;
    else if (i === 0) continue;
    else break;
  }
  return count;
}
function streakCard(k, t) {
  const protStreak = t ? streakDays(r => num(r.protein) >= t.protein * 0.9) : 0;
  const logStreak = streakDays(r => num(r.calories) > 0);
  const weekAgo = todayKey(addDays(new Date(), -6));
  const trainings = (F().workoutLogs || []).filter(l => l.date >= weekAgo).length;
  return `<div class="card"><div class="card-title">Tu racha</div>
    <div class="fit-grid">
      <div class="fit-tile"><div class="fit-tile-lbl">🔥 Proteína seguida</div><div class="fit-tile-val">${protStreak}<span> días</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">🏋️ Entrenos (7 días)</div><div class="fit-tile-val">${trainings}</div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">📋 Registro seguido</div><div class="fit-tile-val">${logStreak}<span> días</span></div></div>
    </div>
    ${protStreak >= 3 ? `<div class="fit-alert ok" style="margin-top:10px">💪 ${protStreak} días seguidos cumpliendo proteína. ¡No cortes la racha!</div>` : ''}
  </div>`;
}
// Aviso de día de partido (tenis/pádel). Se setea desde la pestaña Gym (F().nextMatch).
function matchAdvice(k) {
  const nm = F().nextMatch;
  if (!nm || nm < k) return '';
  const tomorrow = todayKey(addDays(new Date(), 1));
  if (nm === k) return `<div class="card"><div class="card-title">🎾 Hoy jugás tenis/pádel</div><div class="fit-alert info">Sumá ~50–80 g de carbohidratos 2–3 h antes (pasta, arroz, fruta), hidratá bien y hacé el calentamiento de movilidad. Dejá el gym de piernas pesado para otro día.</div></div>`;
  if (nm === tomorrow) return `<div class="card"><div class="card-title">🎾 Mañana jugás</div><div class="fit-alert info">Hoy evitá piernas pesadas (sentadilla/peso muerto al límite) para no jugar con las piernas cargadas. Cargá bien los carbohidratos y dormí 8 h.</div></div>`;
  return `<div class="card"><div class="card-title">🎾 Próximo partido</div><div class="muted text-xs">Jugás el ${fmtDay(nm)}. Te aviso los ajustes el día antes.</div></div>`;
}
function bodyResumen() {
  const f = F(), p = f.profile, k = tk(), t = dayTargets(k), today = getDay(k), tr = trend();
  const lastKg = tr.points.length ? tr.points[tr.points.length - 1].kg : (num(p.weightKg) || null);
  const tiles = t ? `
    <div class="fit-grid">
      <div class="fit-tile"><div class="fit-tile-lbl">Objetivo diario${t.exercise > 0 ? ` · +${t.exercise} ejerc.` : ''}</div><div class="fit-tile-val">${t.target}<span> kcal</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Proteína</div><div class="fit-tile-val">${t.protein}<span> g</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Peso actual</div><div class="fit-tile-val">${lastKg != null ? (+lastKg).toFixed(1) : '—'}<span> kg</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Sueño (anoche)</div><div class="fit-tile-val">${today.sleepHours ? num(today.sleepHours) : '—'}<span> h</span></div></div>
    </div>` : `<div class="card"><div class="muted">Completá tu perfil (peso, altura, edad) para ver tus metas.</div><button class="btn btn-primary btn-sm" id="fit-go-perfil" style="margin-top:10px">Ir a Perfil</button></div>`;
  const cal = num(today.calories), prot = num(today.protein);
  const _al = []; if (t) { const pa = todayPaceAlert(k, t); if (pa) _al.push(pa); const ga = mealGapAlert(k); if (ga) _al.push(ga); }
  const warn = _al.map(a => `<div class="fit-alert ${a.level}">${escapeHtml(a.text)}</div>`).join('');
  const hoy = t ? `
    <div class="card"><div class="card-title">Hoy</div>
      <div class="fit-prog-row"><span>Calorías</span><strong>${cal} / ${t.target} kcal</strong></div>${bar(cal, t.target, 'var(--accent)')}
      ${t.exercise > 0 ? `<div class="muted text-xs" style="margin-top:3px">Base ${t.baseTarget} + ${t.exercise} kcal que entrenaste/te moviste hoy</div>` : ''}
      <div class="fit-prog-row" style="margin-top:10px"><span>Proteína</span><strong>${prot} / ${t.protein} g</strong></div>${bar(prot, t.protein, 'var(--green)')}
      <div class="fit-prog-row" style="margin-top:10px"><span>Hidratación</span><strong>${((num(today.waterMl) + caffeineFluidMl(k)) / 1000).toFixed(1)} / ${(waterGoalFor(k).goal / 1000).toFixed(1)} L</strong></div>${bar(num(today.waterMl) + caffeineFluidMl(k), waterGoalFor(k).goal, 'var(--blue)')}
      ${warn}
      <div class="row gap-6" style="margin-top:14px"><button class="btn btn-secondary btn-sm" id="fit-go-comidas">+ Registrar comida</button><button class="btn btn-secondary btn-sm" id="fit-go-bienestar">Bienestar de hoy</button></div>
    </div>` : '';
  const np = t ? nextMealPlan(k, t) : null;
  let nextCard = '';
  if (np && np.remKcal > 50) {
    const top = pickIdeas(np.next.id, np.perKcal, np.perProt)[0];
    const hh = String(np.next.hour).padStart(2, '0');
    nextCard = `<div class="card fit-next"><div class="row" style="justify-content:space-between;align-items:center;gap:10px"><div><div class="fit-next-t">🍽️ Próximo: ${np.next.label} · ~${hh}:00</div><div class="muted text-xs">~${np.perKcal} kcal · ${np.perProt} g prot${top ? ` · ej: ${escapeHtml(top.name)}` : ''}</div></div><button class="btn btn-secondary btn-sm" id="fit-go-dieta">Ver opciones</button></div></div>`;
  }
  const tip = tipOfDay();
  const tipCard = `<div class="card fit-tip-card"><div class="fit-tip-cat">💡 Tip del día · ${escapeHtml(tip.cat)}</div><div class="fit-tip-text">${escapeHtml(tip.text)}</div><div class="fit-tip-src">${escapeHtml(tip.src)}</div></div>`;
  const recs = recommendations();
  const recsHtml = `<div class="card"><div class="card-title">Recomendaciones</div><div class="fit-rec">${recs.map(r => `<div class="fit-rec-item ${r.level}">${escapeHtml(r.text)}</div>`).join('')}</div></div>`;
  const bienestar = t ? daySummaryTable(k) : '';
  const cierre = t ? closeTheDayCard(k, t) : '';
  return tiles + matchAdvice(k) + hoy + bienestar + cierre + streakCard(k, t) + nextCard + tipCard + recsHtml;
}

function wellnessTrackCard(k) {
  const d = getDay(k), f = F();
  const sleepAvg = avgField(f.days, 7, 'sleepHours'), med = num(d.meditationMin), water = num(d.waterMl);
  const caf = num(d.caffeineMg), cafLog = d.caffeineLog || [];
  const cafLate = cafLog.find(e => e.time && e.time >= caffeineCutoff());
  const wg = waterGoalFor(k), sweatOn = num(d.sweatExtra) > 0;
  const cafFluid = caffeineFluidMl(k), hyd = water + cafFluid;
  return `
    <div class="card"><div class="card-title">Bienestar de hoy</div>
      <div class="fit-well-grid">
        <div class="fit-well"><div class="fit-well-lbl">😴 Sueño (anoche) ${infoIcon('sleep')}</div>
          <div class="row gap-6"><input type="number" step="0.25" class="input" id="fit-sleep" placeholder="horas" value="${d.sleepHours != null ? d.sleepHours : ''}"><button class="btn btn-secondary btn-sm" id="fit-sleep-save">Guardar</button></div>
          <div class="muted text-xs">Objetivo 7.5–8 h · prom 7d: ${sleepAvg != null ? sleepAvg.toFixed(1) + ' h' : '—'}</div></div>
        <div class="fit-well"><div class="fit-well-lbl">💧 Hidratación ${infoIcon('water')}</div>
          <div class="fit-well-val">${(hyd / 1000).toFixed(2)} <span>/ ${(wg.goal / 1000).toFixed(1)} L</span></div>${bar(hyd, wg.goal, 'var(--blue)')}
          ${cafFluid > 0 ? `<div class="muted text-xs" style="margin-top:3px">${(water / 1000).toFixed(2)} L de agua + ${(cafFluid / 1000).toFixed(2)} L de mate/café</div>` : ''}
          ${wg.extra > 0 ? `<div class="muted text-xs" style="margin-top:3px">Meta sube +${wg.extra} ml por ejercicio/calor</div>` : ''}
          <div class="row gap-6" style="margin-top:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" id="fit-water-250">+ Vaso</button><button class="btn btn-ghost btn-sm" id="fit-water-500">+500</button><button class="btn btn-ghost btn-sm" id="fit-water-minus">−</button><button class="btn btn-ghost btn-sm ${sweatOn ? 'fit-on' : ''}" id="fit-sweat">🥵 Transpiré ${sweatOn ? '✓' : ''}</button></div></div>
        <div class="fit-well"><div class="fit-well-lbl">🧘 Meditación ${infoIcon('meditation')}</div>
          <div class="fit-well-val">${med} <span>/ ${MED_GOAL} min</span></div>${bar(med, MED_GOAL, 'var(--violet)')}
          <div class="row gap-6" style="margin-top:8px"><button class="btn btn-ghost btn-sm" id="fit-med-10">+10</button><button class="btn btn-ghost btn-sm" id="fit-med-5">+5</button><button class="btn btn-ghost btn-sm" id="fit-med-reset">Reset</button></div></div>
        <div class="fit-well"><div class="fit-well-lbl">☕ Cafeína ${infoIcon('caffeine')}</div>
          <div class="fit-well-val">${caf} <span>mg ${cafLate ? '· ⚠️ tarde' : ''}</span></div>
          <div class="row gap-6" style="margin-top:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" data-caf="cafe">+ Café</button><button class="btn btn-ghost btn-sm" data-caf="mate_medio">+ Mate ½</button><button class="btn btn-ghost btn-sm" data-caf="mate_full">+ Mate 1L</button><button class="btn btn-ghost btn-sm" data-caf="espresso">+ Esp.</button><button class="btn btn-ghost btn-sm" data-caf="te">+ Té</button></div>
          ${cafLog.length ? `<div class="fit-caf-log">${cafLog.map(e => `<span class="fit-caf-item">${escapeHtml(e.time)} ${escapeHtml(e.label)} ${e.mg}mg <b data-cafdel="${e.id}">✕</b></span>`).join('')}</div>` : ''}
        </div>
      </div></div>`;
}
function supCard(k) {
  const d = getDay(k), tBien = dayTargets(k);
  let protAdvice = '';
  if (tBien) {
    const rem = tBien.protein - num(d.protein);
    protAdvice = rem <= 10
      ? `Hoy ya vas en ${num(d.protein)}/${tBien.protein} g de proteína con la comida — el batido es opcional, no te hace falta.`
      : `Te faltan ~${Math.round(rem)} g de proteína (${num(d.protein)}/${tBien.protein} g). Un batido (~25–40 g) ayuda; si igual vas a comer algo proteico, no hace falta.`;
  }
  return `<div class="card"><div class="card-title">Suplementos de hoy</div>
      <label class="fit-habit"><input type="checkbox" data-sup="creatine" ${d.creatine ? 'checked' : ''}><span>💊 Creatina (5 g)</span>${infoIcon('creatine')}</label>
      <label class="fit-habit"><input type="checkbox" data-sup="proteinShake" ${d.proteinShake ? 'checked' : ''}><span>🥤 Proteína (batido / whey)</span></label>
      ${protAdvice ? `<div class="fit-alert info" style="margin-top:8px">${escapeHtml(protAdvice)}</div>` : ''}
    </div>`;
}
// Tabla-resumen de bienestar del día (prolija, solo lectura) para la pestaña Resumen.
// No repite calorías/proteína/hidratación (ya están con barras en la tarjeta "Hoy").
function daySummaryTable(k) {
  const f = F(), d = getDay(k);
  const med = num(d.meditationMin);
  const caf = num(d.caffeineMg); const cafLate = (d.caffeineLog || []).some(e => e.time && e.time >= caffeineCutoff());
  const sleepAvg = avgField(f.days, 7, 'sleepHours');
  const ex = exerciseKcal(k);
  const chk = (b) => b ? '✅' : '◻️';
  const row = (icon, label, val, extra, ok) => `<tr><td class="fit-tl">${icon} ${label}</td><td class="fit-tv">${val}</td><td class="muted fit-te">${extra || ''}</td><td class="fit-tk">${ok || ''}</td></tr>`;
  return `<div class="card"><div class="card-title">Bienestar de hoy</div>
    <table class="fit-table">
      ${row('😴', 'Sueño', d.sleepHours ? num(d.sleepHours) + ' h' : '—', sleepAvg != null ? 'prom 7d ' + sleepAvg.toFixed(1) + ' h' : 'obj 7.5–8 h', (num(d.sleepHours) >= 7.5) ? '✅' : '')}
      ${row('🧘', 'Meditación', med + ' / ' + MED_GOAL + ' min', '', med >= MED_GOAL ? '✅' : '')}
      ${row('☕', 'Cafeína', caf + ' mg', cafLate ? '⚠️ tarde para dormir' : '', '')}
      ${row('🏃', 'Movimiento', ex + ' kcal', '', ex > 0 ? '✅' : '')}
      ${row('💊', 'Creatina', chk(d.creatine), '', '')}
      ${row('🥤', 'Proteína (supp.)', chk(d.proteinShake), '', '')}
    </table>
    <button class="btn btn-secondary btn-sm" id="fit-go-bienestar2" style="margin-top:10px">Cargar bienestar / suplementos</button>
  </div>`;
}
// Seguimiento de digestión (discreto, colapsado por defecto). Útil para ver si la dieta te cae bien.
function bowelCard(k) {
  const d = getDay(k); const log = d.bowelLog || [];
  if (!showBowel) {
    return `<div class="card fit-bowel"><button class="fit-bowel-toggle" id="fit-bowel-open">🚽 Digestión <span class="muted text-xs">— seguimiento ${log.length ? '· hoy ' + log.length : ''} · ▸</span></button></div>`;
  }
  const f = F(); let days7 = 0, total7 = 0;
  for (let i = 0; i < 7; i++) { const rec = (f.days || {})[todayKey(addDays(new Date(), -i))]; if (rec) { days7++; total7 += (rec.bowelLog || []).length; } }
  const avg = days7 ? (total7 / days7).toFixed(1) : '—';
  return `<div class="card fit-bowel"><button class="fit-bowel-toggle" id="fit-bowel-open"><span class="card-title" style="margin:0">🚽 Digestión ▾</span></button>
    <div class="fit-well-val" style="margin-top:6px">${log.length} <span>hoy · prom 7d ${avg}/día</span></div>
    <div class="row gap-6" style="margin-top:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-secondary btn-sm" id="fit-bowel-add">+ Registrar (ahora)</button>
      <span class="muted text-xs">o tipo (Bristol 1–7):</span>
      ${[1, 2, 3, 4, 5, 6, 7].map(n => `<button class="btn btn-ghost btn-sm" data-bowel-b="${n}">${n}</button>`).join('')}
    </div>
    ${log.length ? `<div class="fit-caf-log" style="margin-top:8px">${log.map(e => `<span class="fit-caf-item">${escapeHtml(e.time || '')}${e.bristol ? ' · tipo ' + e.bristol : ''} <b data-boweldel="${e.id}">✕</b></span>`).join('')}</div>` : ''}
    <div class="muted text-xs" style="margin-top:8px">Escala Bristol: 1–2 duro (constipación), 3–4 ideal, 5–7 blando. Te ayuda a ver si la fibra/hidratación van bien.</div>
  </div>`;
}
function bodyBienestar() {
  const k = tk(), d = getDay(k);
  const track = wellnessTrackCard(k);
  const sup = supCard(k);
  const habit = (h) => {
    const open = expandedHabits.has(h.id);
    const ht = h.time || (h.before != null ? hhmm(bedtimeHour() - h.before / 60) : '');
    const sub = (open && h.steps) ? `<div class="fit-substeps">${h.steps.map(stp => `<label class="fit-substep"><input type="checkbox" data-step="${h.id}|${stp.id}" ${(d.habits && d.habits[h.id + '__' + stp.id]) ? 'checked' : ''}><span>${escapeHtml(stp.label)}</span></label>`).join('')}</div>` : '';
    return `<div class="fit-habit-wrap"><div class="fit-habit-line">
        <label class="fit-habit"><input type="checkbox" data-habit="${h.id}" ${(d.habits && d.habits[h.id]) ? 'checked' : ''}><span class="fit-habit-time">${ht}</span><span>${escapeHtml(h.label)}</span>${infoIcon(h.id)}</label>
        ${h.steps ? `<button class="fit-hab-toggle" data-habtoggle="${h.id}" title="Ver pasos">${open ? '▾' : '▸'}</button>` : ''}
      </div>${sub}</div>`;
  };
  const routine = `<div class="card"><div class="card-title">Rutina del día</div><div class="fit-routine">
      <div><div class="fit-routine-h">Mañana</div>${MORNING_HABITS.map(habit).join('')}</div>
      <div><div class="fit-routine-h">Noche</div>${EVENING_HABITS.map(habit).join('')}</div></div></div>`;
  const acts = d.activityLog || [];
  const totMin = acts.reduce((a, e) => a + num(e.minutes), 0), totKcal = acts.reduce((a, e) => a + num(e.kcal), 0);
  const movement = `<div class="card"><div class="card-title">Movimiento / actividad de hoy ${infoIcon('movement')}</div>
      <div class="row gap-6" style="margin-top:6px;flex-wrap:wrap;align-items:center">
        <span class="muted text-xs">Intensidad:</span>
        ${Object.keys(INTENSITY).map(i => `<button class="fit-day-tab ${actIntensity === i ? 'active' : ''}" data-inten="${i}">${INTENSITY[i].label}</button>`).join('')}
      </div>
      <div class="row gap-6" style="margin-top:10px;flex-wrap:wrap;align-items:center">
        <input type="number" class="input" id="fit-act-min" value="30" style="width:74px"><span class="muted text-xs">min</span>
        ${Object.keys(ACTIVITIES).map(t => `<button class="btn btn-ghost btn-sm" data-act="${t}">${ACTIVITIES[t].emoji} ${ACTIVITIES[t].label}</button>`).join('')}
      </div>
      ${acts.length ? `<div class="fit-caf-log" style="margin-top:12px">${acts.map(e => `<span class="fit-caf-item">${escapeHtml(e.time)} ${e.emoji || ''} ${escapeHtml(e.label)}${e.intensityLabel ? ' (' + escapeHtml(e.intensityLabel) + ')' : ''} · ${e.minutes} min · ${e.kcal} kcal <b data-actdel="${e.id}">✕</b></span>`).join('')}<div class="muted text-xs" style="margin-top:5px">Total: ${totMin} min · ~${totKcal} kcal</div></div>` : '<div class="muted text-xs" style="margin-top:10px">Elegí intensidad, poné los minutos y tocá la actividad. Ej: tenis 90 min intenso. (El gym lo registrás en su pestaña.)</div>'}
    </div>`;
  const blocks = trainingSuggestions();
  const sug = `<div class="card"><div class="card-title">Sugerencias de hoy · según lo que entrenaste</div>${blocks.map(b => `<div class="fit-sug-block"><div class="fit-sug-title">${b.title}</div>${b.items.map(it => `<div class="fit-sug-item"><span class="fit-sug-time">${escapeHtml(it.time)}</span><span>${escapeHtml(it.text)}</span></div>`).join('')}</div>`).join('')}</div>`;
  return track + sup + movement + routine + sug + bowelCard(k);
}

function bodyCuerpo() {
  const k = tk(), d = getDay(k), sore = d.soreness || {};
  const active = Object.keys(sore).filter(r => sore[r] > 0);
  const lvlTxt = { 1: 'leve', 2: 'moderada', 3: 'fuerte' };
  const maps = `
    <div class="card"><div class="card-title">¿Qué sentís cargado hoy?</div>
      <div class="muted text-xs">Tocá una zona para marcar la intensidad (de nuevo para subir: leve → moderada → fuerte → limpiar). <b>D</b> = tu lado derecho · <b>I</b> = izquierdo (separados para tu derecha de tenis).</div>
      <div class="fit-body-wrap">
        <div class="fit-body-col"><div class="fit-body-cap">Frente</div>${bodyMapSVG('front', sore)}</div>
        <div class="fit-body-col"><div class="fit-body-cap">Espalda</div>${bodyMapSVG('back', sore)}</div>
      </div>
      <div class="fit-legend"><span><i style="background:${SOREL[1]}"></i>leve</span><span><i style="background:${SOREL[2]}"></i>moderada</span><span><i style="background:${SOREL[3]}"></i>fuerte</span></div>
    </div>`;
  const summary = active.length ? `
    <div class="card"><div class="card-title">Zonas marcadas y qué hacer</div>
      ${active.map(r => `<div class="fit-sore-row"><div class="fit-sore-name"><span class="fit-sore-dot" style="background:${SOREL[sore[r]]}"></span>${escapeHtml(REGION_LABEL[r] || r)} <span class="muted text-xs">(${lvlTxt[sore[r]]})</span></div><div class="fit-sore-tip">${escapeHtml(SORE_TIPS[baseRegion(r)] || 'Estiramiento suave, movilidad y caminata. Si duele de forma aguda, no lo entrenes hoy.')}</div></div>`).join('')}
      <button class="btn btn-ghost btn-sm" id="fit-sore-clear" style="margin-top:10px">Limpiar zonas</button></div>` : '<div class="card"><div class="muted text-xs">Sin zonas marcadas. Si terminás el entreno con algo cargado, marcalo acá y te doy la recuperación.</div></div>';
  return maps + summary;
}

function bodyDieta() {
  const k = tk(), t = dayTargets(k);
  if (!t) return '<div class="card"><div class="muted">Completá tu perfil (peso, altura, edad) para armar tu plan de comidas.</div><button class="btn btn-primary btn-sm" id="fit-go-perfil" style="margin-top:10px">Ir a Perfil</button></div>';
  const plan = nextMealPlan(k, t);
  const head = `<div class="card"><div class="card-title">Lo que te queda hoy</div>
    <div class="fit-grid">
      <div class="fit-tile"><div class="fit-tile-lbl">Calorías restantes</div><div class="fit-tile-val">${plan.remKcal}<span> kcal</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Proteína restante</div><div class="fit-tile-val">${plan.remProt}<span> g</span></div></div>
    </div></div>`;
  const balanceCard = `<div class="card"><div class="card-title">Balance de la semana</div><div class="fit-rec">${balanceCheck().map(r => `<div class="fit-rec-item ${r.level}">${escapeHtml(r.text)}</div>`).join('')}</div></div>`;
  // repetir algo que ya comiste hoy
  const seen = new Set(); lastRepeatMeals = [];
  for (const m of (getDay(k).meals || [])) { const key = (m.name || '').toLowerCase(); if (seen.has(key)) continue; seen.add(key); lastRepeatMeals.push({ name: m.name, emoji: m.emoji, kcal: m.kcal, protein: m.protein }); }
  const repeatCard = lastRepeatMeals.length ? `<div class="card"><div class="card-title">¿Repetir algo de hoy?</div>
    <div class="muted text-xs" style="margin-bottom:8px">Repetir es lo más fácil de sostener y sirve para llegar a tus números. El único pero: si comés siempre lo mismo perdés variedad de micronutrientes — alterná y mirá el balance de abajo.</div>
    ${lastRepeatMeals.map((m, i) => `<div class="fit-sug"><div class="fit-sug-main"><span class="fit-sug-emoji">${m.emoji || '🍽️'}</span><div><div class="fit-sug-label">${escapeHtml(m.name)}</div><div class="fit-sug-meta">${m.kcal} kcal · ${m.protein} g prot</div></div></div><button class="btn btn-ghost btn-sm" data-logrepeat="${i}">+ Repetir</button></div>`).join('')}
  </div>` : '';
  if (plan.remKcal <= 50) {
    lastDietaIdeas = [];
    return head + `<div class="card"><div class="card-title">Próxima comida</div><div class="fit-alert ok">Ya cubriste tu objetivo de hoy 💪. Si tenés hambre real, algo liviano y proteico (yogur griego, fruta).</div></div>` + balanceCard;
  }
  const hh = String(plan.next.hour).padStart(2, '0');
  lastDietaIdeas = pickIdeas(plan.next.id, plan.perKcal, plan.perProt);
  const nextCard = `<div class="card">
    <div class="card-title">Próxima comida: ${plan.next.label} · ~${hh}:00</div>
    <div class="muted text-xs" style="margin-bottom:8px">Apuntá a ~${plan.perKcal} kcal y ~${plan.perProt} g de proteína. Elegí una:</div>
    ${lastDietaIdeas.map((it, i) => `<div class="fit-sug"><div class="fit-sug-main"><span class="fit-sug-emoji">🍽️</span><div><div class="fit-sug-label">${escapeHtml(it.name)}</div><div class="fit-sug-meta">${it.kcal} kcal · ${it.protein} g prot</div><div class="fit-why">↳ ${escapeHtml(whyFor(it, plan.perKcal, plan.perProt))}</div></div></div><button class="btn btn-ghost btn-sm" data-logidea="${i}">+ Comí esto</button></div>`).join('')}
    <div class="muted text-xs" style="margin-top:8px">También podés sumar algo de tus alimentos en la pestaña Comidas.</div>
  </div>`;
  const rest = plan.upcoming.length > 1 ? `<div class="card"><div class="card-title">Cómo repartir el resto del día</div>${plan.upcoming.map(s => `<div class="fit-prog-row"><span>${s.label} · ~${String(s.hour).padStart(2, '0')}:00</span><strong>~${plan.perKcal} kcal · ${plan.perProt} g</strong></div>`).join('')}<div class="muted text-xs" style="margin-top:6px">Reparto parejo de lo que te queda. Si entrenás más tarde, te sube el objetivo y se recalcula.</div></div>` : '';
  return head + nextCard + repeatCard + rest + balanceCard;
}

function bodyComidas() {
  const f = F(), k = tk(), today = getDay(k), t = targets(f.profile), tDay = dayTargets(k);
  const meals = today.meals || [];
  const groups = [...new Set(f.foodLibrary.map(x => x.group))];
  const grid = groups.map(g => `
    <div class="fit-food-group"><div class="fit-food-gh">${escapeHtml(g)}</div><div class="fit-food-grid">
      ${f.foodLibrary.filter(x => x.group === g).map(x => `<button class="fit-food" data-food="${x.id}"><span class="fit-food-emoji">${x.emoji || '🍽️'}</span><span class="fit-food-name">${escapeHtml(x.name)}</span><span class="fit-food-macros">${x.kcal} kcal · ${x.protein} g</span></button>`).join('')}
    </div></div>`).join('');
  const customForm = showFoodForm ? `
    <div class="fit-food-form">
      <input type="text" class="input" id="ff-emoji" placeholder="🍽️" maxlength="2" style="width:54px">
      <input type="text" class="input" id="ff-name" placeholder="Nombre" style="flex:2">
      <input type="number" class="input" id="ff-kcal" placeholder="kcal" style="width:80px">
      <input type="number" class="input" id="ff-prot" placeholder="prot g" style="width:80px">
      <button class="btn btn-primary btn-sm" id="ff-add">Guardar</button>
    </div>` : '';
  const mealsSorted = [...meals].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const mealsList = mealsSorted.length ? mealsSorted.map(m => `<div class="fit-meal"><span class="fit-meal-time">${m.ts ? fmtTime(m.ts) : '—'}</span><span class="fit-meal-name">${m.emoji || '🍽️'} ${escapeHtml(m.name)}</span><span class="muted text-xs">${m.kcal} kcal · ${m.protein} g</span><button class="btn btn-ghost btn-sm" data-del-meal="${m.id}">✕</button></div>`).join('') : '<div class="muted text-xs">Tocá un alimento arriba para sumarlo al día.</div>';
  const totals = tDay ? `<div class="fit-prog-row"><span>Hoy</span><strong>${num(today.calories)} / ${tDay.target} kcal · ${num(today.protein)} / ${tDay.protein} g prot</strong></div>${bar(num(today.calories), tDay.target, 'var(--accent)')}${tDay.exercise > 0 ? `<div class="muted text-xs" style="margin-top:3px">Base ${tDay.baseTarget} + ${tDay.exercise} kcal de ejercicio de hoy</div>` : ''}` : `<div class="fit-prog-row"><span>Hoy</span><strong>${num(today.calories)} kcal · ${num(today.protein)} g prot</strong></div>`;

  const pickCard = `<div class="card"><div class="row" style="justify-content:space-between;align-items:center"><div class="card-title" style="margin:0">Elegí lo que comiste</div><button class="btn btn-ghost btn-sm" id="fit-food-toggle">${showFoodForm ? 'Cerrar' : '+ Alimento propio'}</button></div>${customForm}${grid}</div>`;
  const dayCard = `<div class="card"><div class="card-title">Comidas de hoy</div>${totals}<div class="fit-meals" style="margin-top:10px">${mealsList}</div></div>`;

  // entrada manual para días pasados / ajuste
  const date = comidaDate || k; const cur = getDay(date);
  const manual = `<div class="card"><div class="card-title">Ajuste manual / día anterior</div>
      <div class="field-row">
        <div class="field"><label>Fecha</label><input type="date" class="input" id="fit-c-date" value="${date}"></div>
        <div class="field"><label>Calorías</label><input type="number" class="input" id="fit-c-cal" value="${cur.calories != null ? cur.calories : ''}"></div>
        <div class="field"><label>Proteína</label><input type="number" class="input" id="fit-c-prot" value="${cur.protein != null ? cur.protein : ''}"></div>
      </div>
      <button class="btn btn-secondary btn-sm" id="fit-c-save">Guardar día</button>
      <div class="muted text-xs" style="margin-top:6px">Usalo para cargar a mano un día sin detallar alimentos. Para hoy, mejor usá los botones de arriba.</div></div>`;
  const optCard = `<div class="card"><div class="card-title">Opciones saludables para vos</div>
    <div class="fit-rec">
      <div class="fit-rec-item ok">Tu desayuno (tostada integral casera + 3 huevos, ~410 kcal · 24 g prot) está muy bien: integral, con semillas (omega-3 y fibra) y huevos (proteína completa + colina).</div>
      <div class="fit-rec-item info">Para sumar masa, subí la proteína del desayuno a ~35–40 g: 1 huevo más, o un lado de yogur griego / vaso de leche / ricota.</div>
      <div class="fit-rec-item info">Agregá la banana que ya tenés a mano: carbohidrato y energía para el gym y el tenis.</div>
      <div class="fit-rec-item info">Solés quedar corto de lácteos y fruta/verdura: apuntá a una fruta por comida y un lácteo proteico al día (yogur griego, ricota).</div>
      <div class="fit-rec-item info">¿Te cuesta llegar a las calorías? El batido (leche + banana + avena + maní + whey) son calorías líquidas fáciles. Lo cargué abajo en "Para sumar masa".</div>
    </div></div>`;
  return pickCard + dayCard + optCard + manual;
}

function bodyPeso() {
  const f = F(), tr = trend(), list = [...(f.weighIns || [])].sort((a, b) => a.date < b.date ? 1 : -1);
  const rate = (tr.ratePerWeek == null || !tr.reliable) ? 'midiendo…' : `${tr.ratePerWeek >= 0 ? '+' : ''}${tr.ratePerWeek.toFixed(2)} kg/sem`;
  const form = `<div class="card"><div class="card-title">Nuevo pesaje</div>
      <div class="row gap-6 fit-quick"><input type="date" class="input" id="fit-w-date" value="${tk()}"><input type="number" step="0.1" class="input" id="fit-w-kg" placeholder="kg"><input type="number" step="0.1" class="input" id="fit-w-bf" placeholder="% grasa"><input type="number" step="0.1" class="input" id="fit-w-muscle" placeholder="músculo kg"><button class="btn btn-primary" id="fit-w-save">Agregar</button></div>
      <div class="muted text-xs" style="margin-top:8px">Pesate cada 2–3 días, a la mañana en ayunas. % grasa y músculo son opcionales (balanza inteligente) y alimentan los reportes. <b>Truco:</b> mandame la captura de tu balanza (Zepp Life u otra) por acá y lo cargo yo con todos los datos.</div></div>`;
  const w = effectiveWeight(), lo = w * 0.0025, hi = w * 0.005;
  let rateNote = '', rateLvl = 'info';
  if (tr.ratePerWeek != null && !tr.reliable) {
    rateNote = `📏 Llevás ${tr.spanDays} día(s) de pesajes. Necesito ~2 semanas para darte un ritmo real — de un día a otro el peso varía por agua y comida, así que no cambies nada todavía.`;
    rateLvl = 'info';
  } else if (tr.ratePerWeek != null) {
    const r = tr.ratePerWeek, band = `+${lo.toFixed(2)}–${hi.toFixed(2)} kg/sem`;
    if (r < 0) { rateNote = `⚠️ Vas bajando (${r.toFixed(2)} kg/sem). Para sumar masa querés ${band}: subí un poco las calorías.`; rateLvl = 'warn'; }
    else if (r < lo * 0.6) { rateNote = `Vas lento para bulk (+${r.toFixed(2)} kg/sem). El rango ideal es ${band}: podés sumar ~100–200 kcal.`; rateLvl = 'info'; }
    else if (r > hi * 1.6) { rateNote = `Vas rápido (+${r.toFixed(2)} kg/sem): a este ritmo sumás más grasa. Ideal ${band}.`; rateLvl = 'warn'; }
    else { rateNote = `✅ Buen ritmo de lean bulk (vas +${r.toFixed(2)} kg/sem, ideal ${band}).`; rateLvl = 'ok'; }
  }
  const chart = `<div class="card"><div class="fit-prog-row"><span class="card-title" style="margin:0">Tendencia de peso</span><strong>${rate}</strong></div><div style="margin-top:10px">${chartLine(tr.points.map(p => ({ label: fmtDay(p.date), value: +p.kg })), { color: 'var(--accent)', dec: 1 })}</div>${rateNote ? `<div class="fit-alert ${rateLvl}" style="margin-top:10px">${escapeHtml(rateNote)}</div>` : ''}</div>`;
  const rows = list.length ? list.map(w => `<div class="fit-hist-row"><div class="fit-hist-date">${fmtDay(w.date)}</div><div class="fit-hist-main"><strong>${(+w.kg).toFixed(1)} kg</strong>${w.bodyFatPct != null ? ` · ${(+w.bodyFatPct).toFixed(1)}% grasa` : ''}${w.muscleKg != null ? ` · ${(+w.muscleKg).toFixed(1)} kg músc` : ''}</div><div class="fit-hist-actions"><button class="btn btn-ghost btn-sm" data-del-weight="${w.id}">✕</button></div></div>`).join('') : '<div class="muted text-xs">Sin pesajes todavía.</div>';
  return form + chart + `<div class="card"><div class="card-title">Pesajes</div><div class="fit-hist">${rows}</div></div>`;
}

// Calentamiento de movilidad (antes de entrenar o jugar). Guía, no se registra.
const WARMUP = [
  { name: "Movilidad de cadera — world's greatest stretch", cue: 'Zancada larga + rotás el torso hacia la pierna de adelante. 5 por lado.', yt: 'worlds greatest stretch' },
  { name: 'Movilidad torácica — libro abierto', cue: 'De costado en el piso, abrí el brazo de arriba girando el tronco. 8 por lado.', yt: 'open book thoracic mobility exercise' },
  { name: 'Dislocaciones de hombro con palo o banda', cue: 'Pasá un palo/banda de adelante hacia atrás por encima de la cabeza, brazos estirados. 10 lentas.', yt: 'shoulder dislocates band' },
  { name: 'Face pulls con banda (activación)', cue: 'Tirá la banda hacia la cara separando los codos. Despierta el hombro posterior. 15.', yt: 'band face pull' },
  { name: 'Sentadilla profunda con balanceo', cue: 'Bajá a sentadilla profunda y balanceá suave abriendo las caderas. 30 seg.', yt: 'prying goblet squat mobility' },
];
// Ejercicios de core/rotación para tenis y pádel (sí se registran como serie).
const CORE_POOL = [
  { name: 'Pallof press (anti-rotación)', sets: 3, reps: '12/lado', cue: 'En polea o banda al costado, llevá las manos al frente sin dejar que el torso gire. Core fuerte = saque y derecha más potentes.', yt: 'pallof press technique' },
  { name: 'Leñador en polea (woodchopper)', sets: 3, reps: '12/lado', cue: 'En diagonal de arriba hacia abajo, girando desde tronco y cadera (no los brazos). Imita el golpe de tenis.', yt: 'cable woodchopper exercise' },
  { name: 'Lanzamiento rotacional de balón', sets: 3, reps: '8/lado', cue: 'Lanzá un balón medicinal contra la pared rotando el tronco con potencia. Explosividad del saque.', yt: 'rotational medicine ball throw tennis' },
  { name: 'Plancha lateral', sets: 3, reps: '30s/lado', cue: 'Cuerpo en línea, cadera arriba. Estabilidad lateral para frenar y cambiar de dirección.', yt: 'side plank technique' },
];
// Devuelve 2 ejercicios de core distintos según el día.
const coreForDay = (i) => [CORE_POOL[(i * 2) % CORE_POOL.length], CORE_POOL[(i * 2 + 1) % CORE_POOL.length]];
// Tope de repeticiones objetivo (para sobrecarga progresiva). Ignora ejercicios por tiempo (30s).
const repTargetHi = (reps) => { const s = String(reps); if (/\d\s*s/i.test(s)) return null; const nums = (s.match(/\d+/g) || []).map(Number); return nums.length ? Math.max(...nums) : null; };
// Rutina dedicada de movilidad + hombro + estiramientos (días libres o post-partido).
const MOBILITY_ROUTINE = [
  { name: 'Libro abierto (columna torácica)', cue: '8 por lado, lento, siguiendo la mano con la mirada.', yt: 'open book thoracic mobility exercise' },
  { name: '90/90 de cadera', cue: 'Sentado, girá ambas rodillas de un lado al otro. 8 por lado.', yt: '90 90 hip mobility drill' },
  { name: 'Estiramiento de flexor de cadera', cue: 'Zancada, metés la cadera adelante. 30 seg por lado. Clave si estás mucho sentado.', yt: 'hip flexor stretch' },
  { name: 'Manguito rotador — rotación externa con banda', cue: 'Codo pegado al cuerpo, rotás el antebrazo hacia afuera. 15 por lado. Previene la lesión típica del tenista.', yt: 'external rotation band rotator cuff' },
  { name: 'Estiramiento de antebrazo y muñeca', cue: '30 seg por lado, palma hacia arriba y abajo. Previene codo de tenista.', yt: 'forearm wrist stretch tennis elbow' },
  { name: 'Movilidad de tobillo a la pared', cue: 'Rodilla hacia la pared sin levantar el talón. 10 por lado. Mejora las frenadas.', yt: 'ankle mobility wall drill' },
  { name: 'Estiramiento figura-4 (glúteo / piriforme)', cue: '30 seg por lado, acostado, tirando de la pierna hacia el pecho.', yt: 'figure 4 glute stretch' },
];

function bodyGym() {
  const f = F(), plan = f.plan || defaultFitnessPlan(), day = plan.days[gymDayIndex] || plan.days[0];
  const head = `<div class="card"><div class="card-title">${escapeHtml(plan.name)}</div><div class="muted text-xs">${escapeHtml(plan.note)}</div>
      <div class="fit-day-tabs">${plan.days.map((dd, i) => `<button class="fit-day-tab ${i === gymDayIndex ? 'active' : ''}" data-gymday="${i}">${escapeHtml(dd.name.split(' · ')[0])}</button>`).join('')}</div>
      <button class="btn btn-ghost btn-sm" id="fit-plan-edit" style="margin-top:8px">${editPlan ? '← Volver al registro' : '✏️ Editar plan'}</button></div>`;
  // Modo edición: editar nombre del día, ejercicios, series y reps.
  if (editPlan) {
    const editor = `<div class="card"><div class="card-title">✏️ Editar plan — día actual</div>
      <label class="muted text-xs">Nombre del día</label>
      <input class="input" id="ep-dayname" value="${escapeHtml(day.name)}" style="margin:4px 0 12px">
      <div class="muted text-xs" style="margin-bottom:6px">Ejercicio · series · reps</div>
      ${day.exercises.map((ex, i) => `<div class="ep-row" data-ei="${i}">
          <input class="input ep-name" value="${escapeHtml(ex.name)}" placeholder="Ejercicio">
          <input class="input ep-sets" type="number" inputmode="numeric" value="${ex.sets || 3}" title="series">
          <input class="input ep-reps" value="${escapeHtml(String(ex.reps || ''))}" placeholder="reps" title="reps">
          <button class="btn btn-ghost btn-sm" data-ep-del="${i}" title="Quitar">✕</button>
        </div>`).join('')}
      <button class="btn btn-secondary btn-sm" id="ep-add" style="margin-top:10px">+ Agregar ejercicio</button>
      <div class="row gap-6" style="margin-top:16px"><button class="btn btn-primary btn-sm" id="ep-save">Guardar plan</button><button class="btn btn-ghost btn-sm" id="ep-cancel">Cancelar</button></div>
      <div class="muted text-xs" style="margin-top:8px">Editás el día seleccionado arriba. Cambiá de día con los botones para editar otro.</div></div>`;
    return head + editor;
  }
  const renderEx = (ex, i) => {
    const last = lastWeightFor(ex.name), exKey = gymDayIndex + ':' + i, open = expandedEx.has(exKey);
    const ls = lastSessionFor(ex.name);
    const yt = ex.yt ? `https://www.youtube.com/results?search_query=${encodeURIComponent(ex.yt)}` : null;
    const nSets = Math.min(4, ex.sets || 3);
    const setRows = Array.from({ length: nSets }, (_, s) => `<div class="fit-set"><span class="fit-set-n">S${s + 1}</span><input type="number" step="0.5" inputmode="decimal" class="input fit-set-in" data-f="w" placeholder="${last != null ? last + 'kg' : 'kg'}"><input type="number" inputmode="numeric" class="input fit-set-in" data-f="r" placeholder="reps"></div>`).join('');
    return `<div class="fit-ex">
      <div class="fit-ex-top">
        <div class="fit-ex-name">${escapeHtml(ex.name)}<span class="muted text-xs"> · meta ${ex.sets}×${escapeHtml(String(ex.reps))}</span></div>
        ${ex.cue ? `<button class="fit-how" data-how="${exKey}">${open ? '▾' : '▸'} cómo</button>` : ''}
      </div>
      ${ls ? (() => {
        const hi = repTargetHi(ex.reps);
        const up = (hi && ls.reps && ls.reps >= hi);
        return `<div class="fit-ex-last ${up ? 'fit-ex-up' : ''}">📈 Última (${fmtDay(ls.date)}): <strong>${escapeHtml(ls.txt)}</strong> · ${up ? `⬆️ cumpliste las reps — subí ~2.5 kg` : '🎯 igualá o superá'}</div>`;
      })() : ''}
      <div class="fit-sets" data-name="${escapeHtml(ex.name)}">${setRows}${nSets < 4 ? '<button class="fit-addset" data-addset="1">+ serie</button>' : ''}</div>
      ${open && ex.cue ? `<div class="fit-ex-how"><p>${escapeHtml(ex.cue)}</p>${yt ? `<a href="${yt}" target="_blank" rel="noopener" class="fit-yt">▶ Ver en YouTube</a>` : ''}</div>` : ''}
    </div>`;
  };
  const ytLink = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const moveItem = (m) => `<div class="fit-move"><div class="fit-move-n">${escapeHtml(m.name)} <a href="${ytLink(m.yt)}" target="_blank" rel="noopener" class="fit-yt-mini">▶</a></div><div class="fit-move-cue">${escapeHtml(m.cue)}</div></div>`;
  const warmup = `<div class="card"><div class="card-title">🔥 Calentamiento · 5 min (antes de entrenar o jugar)</div><div class="muted text-xs" style="margin-bottom:8px">Movilidad dinámica para cadera, columna y hombro.</div>${WARMUP.map(moveItem).join('')}</div>`;
  const mobility = `<div class="card"><div class="card-title">🤸 Movilidad & tenis (días libres o post-partido)</div><div class="muted text-xs" style="margin-bottom:8px">~10 min de movilidad, cuidado de hombro y estiramientos. Suma flexibilidad y previene lesiones.</div>${MOBILITY_ROUTINE.map(moveItem).join('')}</div>`;
  const matchSetter = `<div class="card"><div class="card-title">🎾 Próximo partido (tenis / pádel)</div>
    <div class="row gap-6"><input type="date" class="input" id="fit-match-date" value="${f.nextMatch || ''}"><button class="btn btn-secondary btn-sm" id="fit-match-save">Guardar</button>${f.nextMatch ? `<button class="btn btn-ghost btn-sm" id="fit-match-clear">Quitar</button>` : ''}</div>
    <div class="muted text-xs" style="margin-top:6px">Marcá cuándo jugás: te ajusto los avisos en el Resumen (carbos e hidratación el día del partido, no piernas pesadas el día antes).</div></div>`;
  const mainRows = day.exercises.map(renderEx).join('');
  const core = coreForDay(gymDayIndex);
  const coreRows = `<div class="fit-section-h">🎾 Core / rotación (tenis y pádel)</div>` + core.map((ex, idx) => renderEx(ex, day.exercises.length + idx)).join('');
  const log = `<div class="card"><div class="card-title">Registrar sesión — ${escapeHtml(day.name)}</div><div class="muted text-xs" style="margin-bottom:6px">Cargá kg y reps de cada serie. Dejá vacías las que no hagas: cuento las que llenes (hasta 4).</div>${mainRows}${coreRows}<button class="btn btn-primary btn-sm" id="fit-gym-save" style="margin-top:12px">Guardar sesión</button></div>`;
  const logs = [...(f.workoutLogs || [])].sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 12);
  const hist = logs.length ? logs.map(l => `<div class="fit-log"><div class="fit-log-head"><strong>${fmtDay(l.date)}</strong> · ${escapeHtml(l.dayName || '')}<button class="btn btn-ghost btn-sm" data-del-log="${l.id}" style="float:right">✕</button></div><div class="fit-log-body">${(l.entries || []).map(e => {
    const sets = e.setLog || ((num(e.weight) || e.reps) ? [{ weight: e.weight, reps: e.reps }] : []);
    const txt = sets.map(s => `${num(s.weight) ? s.weight : '–'}×${(s.reps != null && s.reps !== '') ? s.reps : '–'}`).join('  ');
    return `<div class="fit-log-ex"><span class="fit-log-exn">${escapeHtml(e.name.split(' (')[0])}</span> <strong>${sets.length} ser</strong> <span class="muted">${escapeHtml(txt)}</span></div>`;
  }).join('')}</div></div>`).join('') : '<div class="muted text-xs">Todavía no registraste sesiones.</div>';
  return head + matchSetter + warmup + log + `<div class="card"><div class="card-title">Sesiones recientes</div><div class="fit-logs">${hist}</div></div>` + mobility;
}

function bodyReportes() {
  const f = F(), cutoff = todayKey(addDays(new Date(), -(reportDays - 1)));
  const ws = weighSorted().filter(w => w.date >= cutoff);
  const dayKeys = Object.keys(f.days).filter(kk => kk >= cutoff).sort();
  const t = targets(f.profile);
  const sel = `<div class="fit-period">${[14, 30, 90].map(n => `<button class="fit-day-tab ${reportDays === n ? 'active' : ''}" data-period="${n}">${n} días</button>`).join('')}</div>`;

  const calSeries = dayKeys.filter(kk => num(f.days[kk].calories) > 0).map(kk => ({ label: fmtDay(kk), value: num(f.days[kk].calories) }));
  const protSeries = dayKeys.filter(kk => num(f.days[kk].protein) > 0).map(kk => ({ label: fmtDay(kk), value: num(f.days[kk].protein) }));
  const weightSeries = ws.map(w => ({ label: fmtDay(w.date), value: +w.kg }));
  const bfSeries = ws.filter(w => w.bodyFatPct != null).map(w => ({ label: fmtDay(w.date), value: +w.bodyFatPct }));
  const muscleSeries = ws.filter(w => w.muscleKg != null || w.bodyFatPct != null).map(w => ({ label: fmtDay(w.date), value: w.muscleKg != null ? +(+w.muscleKg).toFixed(1) : +(w.kg * (1 - w.bodyFatPct / 100)).toFixed(1) }));
  const fatSeries = ws.filter(w => w.bodyFatPct != null).map(w => ({ label: fmtDay(w.date), value: +(w.kg * (w.bodyFatPct / 100)).toFixed(1) }));
  const sleepSeries = dayKeys.filter(kk => num(f.days[kk].sleepHours) > 0).map(kk => ({ label: fmtDay(kk), value: num(f.days[kk].sleepHours) }));

  const card = (title, body, sub) => `<div class="card"><div class="card-title">${title}${sub ? ` <span class="muted text-xs">${sub}</span>` : ''}</div><div style="margin-top:8px">${body}</div></div>`;

  // stats de adherencia + promedios
  const tkey = todayKey();
  const calDays = dayKeys.filter(kk => kk !== tkey && num(f.days[kk].calories) > 0); // excluye hoy (incompleto)
  const logged = dayKeys.filter(kk => num(f.days[kk].calories) > 0).length;
  const avgCal = calDays.length ? Math.round(calDays.reduce((a, kk) => a + num(f.days[kk].calories), 0) / calDays.length) : null;
  const avgProt = calDays.length ? Math.round(calDays.reduce((a, kk) => a + num(f.days[kk].protein), 0) / calDays.length) : null;
  const protOk = t ? dayKeys.filter(kk => num(f.days[kk].protein) >= t.protein * 0.9).length : 0;
  const calOk = t ? calDays.filter(kk => num(f.days[kk].calories) >= t.target * 0.92).length : 0;
  const sessions = (f.workoutLogs || []).filter(l => l.date >= cutoff).length;
  const sleepAvg = avgField(f.days, reportDays, 'sleepHours');
  const waterAvg = avgField(f.days, reportDays, 'waterMl');
  const pct = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
  const stats = `<div class="card"><div class="card-title">Resumen del período</div><div class="fit-grid">
      <div class="fit-tile"><div class="fit-tile-lbl">Cal promedio</div><div class="fit-tile-val">${avgCal != null ? avgCal : '—'}<span> kcal</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Proteína prom</div><div class="fit-tile-val">${avgProt != null ? avgProt : '—'}<span> g</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Días registrados</div><div class="fit-tile-val">${logged}</div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Sesiones de gym</div><div class="fit-tile-val">${sessions}</div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Sueño prom</div><div class="fit-tile-val">${sleepAvg != null ? sleepAvg.toFixed(1) : '—'}<span> h</span></div></div>
      <div class="fit-tile"><div class="fit-tile-lbl">Agua prom</div><div class="fit-tile-val">${waterAvg != null ? (waterAvg / 1000).toFixed(1) : '—'}<span> L</span></div></div>
    </div></div>`;

  // adherencia (% de días que cumpliste)
  let adher = '';
  if (t && logged > 0) {
    const aRow = (label, n, d, color) => `<div class="fit-prog-row" style="margin-top:8px"><span>${label}</span><strong>${n}/${d} días · ${pct(n, d)}%</strong></div>${bar(pct(n, d), 100, color)}`;
    adher = `<div class="card"><div class="card-title">Adherencia</div>
      ${aRow('Proteína en objetivo', protOk, logged, 'var(--green)')}
      ${aRow('Calorías en superávit', calOk, calDays.length || logged, 'var(--accent)')}
    </div>`;
  }

  // balance energético + ritmo estimado
  let balance = '';
  if (t && avgCal != null) {
    const surplus = avgCal - t.maintenance;
    const kgWeek = surplus * 7 / 7700; // ~7700 kcal por kg (estimación)
    const sg = surplus >= 0 ? '+' : '';
    const lvl = surplus < 0 ? 'warn' : (surplus > 600 ? 'warn' : 'ok');
    const msg = surplus < 0
      ? `Comés en promedio ${sg}${surplus} kcal vs tu mantenimiento (${t.maintenance}). Estás por debajo: así no sumás masa, subí las calorías.`
      : `Superávit promedio de ${sg}${surplus} kcal/día (comés ${avgCal}, mantenés con ${t.maintenance}). Ritmo teórico ~${kgWeek >= 0 ? '+' : ''}${kgWeek.toFixed(2)} kg/sem.`;
    balance = `<div class="card"><div class="card-title">Balance energético</div><div class="fit-alert ${lvl}">${msg}</div></div>`;
  }

  // composición corporal (cambio en el período)
  let comp = '';
  const wsC = ws.filter(w => w.muscleKg != null || w.bodyFatPct != null);
  if (wsC.length >= 2) {
    const mk = (w) => w.muscleKg != null ? +w.muscleKg : (w.bodyFatPct != null ? w.kg * (1 - w.bodyFatPct / 100) : null);
    const fk = (w) => w.bodyFatPct != null ? w.kg * (w.bodyFatPct / 100) : null;
    const a0 = wsC[0], a1 = wsC[wsC.length - 1];
    const dM = (mk(a0) != null && mk(a1) != null) ? mk(a1) - mk(a0) : null;
    const dF = (fk(a0) != null && fk(a1) != null) ? fk(a1) - fk(a0) : null;
    const dW = +a1.kg - +a0.kg;
    const sgn = (v) => v >= 0 ? '+' : '';
    let verdict = '';
    if (dM != null && dF != null) {
      if (dM > 0 && dF <= 0.2) verdict = `<div class="fit-alert ok" style="margin-top:10px">✅ Recomposición ideal: ganás músculo casi sin grasa.</div>`;
      else if (dF > Math.abs(dM)) verdict = `<div class="fit-alert warn" style="margin-top:10px">⚠️ Sumaste más grasa que músculo: bajá un poco el superávit.</div>`;
      else verdict = `<div class="fit-alert info" style="margin-top:10px">Vas sumando ambos; lo bueno es que el músculo crezca más que la grasa.</div>`;
    }
    comp = `<div class="card"><div class="card-title">Composición corporal <span class="muted text-xs">${fmtDay(a0.date)} → ${fmtDay(a1.date)}</span></div>
      <div class="fit-grid">
        <div class="fit-tile"><div class="fit-tile-lbl">Δ Peso</div><div class="fit-tile-val">${sgn(dW)}${dW.toFixed(1)}<span> kg</span></div></div>
        ${dM != null ? `<div class="fit-tile"><div class="fit-tile-lbl">Δ Músculo</div><div class="fit-tile-val">${sgn(dM)}${dM.toFixed(1)}<span> kg</span></div></div>` : ''}
        ${dF != null ? `<div class="fit-tile"><div class="fit-tile-lbl">Δ Grasa</div><div class="fit-tile-val">${sgn(dF)}${dF.toFixed(1)}<span> kg</span></div></div>` : ''}
      </div>${verdict}
    </div>`;
  }

  return sel + stats + adher + balance + comp
    + card('Peso (kg)', chartLine(weightSeries, { color: 'var(--accent)', dec: 1 }))
    + card('% Grasa corporal', chartLine(bfSeries, { color: 'var(--red)', dec: 1 }), 'cargá el % en Peso')
    + card('Músculo (kg)', chartLine(muscleSeries, { color: 'var(--green)', dec: 1 }), 'de tu balanza o estimado')
    + card('Grasa (kg)', chartLine(fatSeries, { color: 'var(--orange)', dec: 1 }))
    + card('Calorías por día', chartBars(calSeries, { color: 'var(--accent)', refValue: t ? t.target : null }))
    + card('Proteína por día (g)', chartBars(protSeries, { color: 'var(--green)', refValue: t ? t.protein : null }))
    + card('Sueño por noche (h)', chartBars(sleepSeries, { color: 'var(--blue)', refValue: 7.5 }));
}

function bodyAprende() {
  const cats = [...new Set(TIPS.map(t => t.cat))];
  const tod = tipOfDay();
  const todCard = `<div class="card fit-tip-card"><div class="fit-tip-cat">💡 Tip del día · ${escapeHtml(tod.cat)}</div><div class="fit-tip-text">${escapeHtml(tod.text)}</div><div class="fit-tip-src">${escapeHtml(tod.src)}</div></div>`;
  const intro = `<div class="card"><div class="card-title">Aprendé de a poco</div><div class="muted text-xs">Principios sacados de libros y evidencia de salud, entrenamiento y nutrición. Leé uno por día y aplicalo.</div></div>`;
  const body = cats.map(c => `<div class="card"><div class="card-title">${escapeHtml(c)}</div>${TIPS.filter(t => t.cat === c).map(t => `<div class="fit-learn"><div class="fit-learn-text">${escapeHtml(t.text)}</div><div class="fit-learn-src">📖 ${escapeHtml(t.src)}</div></div>`).join('')}</div>`).join('');
  return todCard + intro + body;
}

function bodyPerfil() {
  const p = F().profile;
  const opt = (v, c, l) => `<option value="${v}" ${v === c ? 'selected' : ''}>${l}</option>`;
  return `<div class="card"><div class="card-title">Tu perfil</div>
      <div class="muted text-xs" style="margin-bottom:12px">Estos datos calculan tus metas. Actualizá tu peso cuando cambie (o cargalo en Peso). <b>Importante:</b> el nivel de actividad es tu día a día <b>sin</b> ejercicio — el gym y las actividades que cargás se suman solas al objetivo de cada día.</div>
      <div class="field-row"><div class="field"><label>Sexo</label><select class="select" id="fp-sex">${opt('male', p.sex, 'Hombre')}${opt('female', p.sex, 'Mujer')}</select></div><div class="field"><label>Edad</label><input type="number" class="input" id="fp-age" value="${p.age ?? ''}"></div></div>
      <div class="field-row"><div class="field"><label>Altura (cm)</label><input type="number" class="input" id="fp-height" value="${p.heightCm ?? ''}"></div><div class="field"><label>Peso (kg)</label><input type="number" step="0.1" class="input" id="fp-weight" value="${p.weightKg ?? ''}"></div></div>
      <div class="field-row"><div class="field"><label>Nivel de actividad (sin ejercicio)</label><select class="select" id="fp-act">${Object.keys(ACTIVITY_LABELS).map(k => opt(k, p.activity, ACTIVITY_LABELS[k])).join('')}</select></div><div class="field"><label>Objetivo</label><select class="select" id="fp-goal">${opt('gain', p.goal, 'Sumar masa muscular')}${opt('maintain', p.goal, 'Mantener')}${opt('cut', p.goal, 'Bajar grasa')}</select></div></div>
      <div class="field-row"><div class="field"><label>Proteína (g/kg)</label><input type="number" step="0.1" class="input" id="fp-prot" value="${p.proteinPerKg ?? 1.8}"></div><div class="field"><label>Superávit (%)</label><input type="number" class="input" id="fp-surplus" value="${p.surplusPct ?? 12}"></div></div>
      <div class="field-row"><div class="field"><label>Hora de dormir <span class="muted text-xs">— ajusta rutina nocturna y corte de cafeína</span></label><select class="select" id="fp-bedtime">${[[22, '22:00'], [23, '23:00'], [24, '00:00'], [25, '01:00'], [26, '02:00']].map(([v, l]) => opt(v, p.bedtimeHour ?? 24, l)).join('')}</select></div><div class="field"></div></div>
      <button class="btn btn-primary btn-sm" id="fp-save">Guardar perfil</button></div>`;
}

const bar = (val, goal, color) => { const pct = goal ? Math.min(100, Math.round(val / goal * 100)) : 0; return `<div class="fit-bar"><div class="fit-bar-fill" style="width:${pct}%;background:${color}"></div></div>`; };
const lastWeightFor = (exName) => {
  const logs = [...(F().workoutLogs || [])].sort((a, b) => a.date < b.date ? 1 : -1);
  for (const l of logs) {
    const e = (l.entries || []).find(x => x.name === exName);
    if (!e) continue;
    const sets = e.setLog || (num(e.weight) ? [{ weight: e.weight }] : []);
    const w = Math.max(0, ...sets.map(s => num(s.weight)));
    if (w > 0) return w;
  }
  return null;
};
// Última sesión registrada de un ejercicio (para sobrecarga progresiva).
const lastSessionFor = (exName) => {
  const logs = [...(F().workoutLogs || [])].sort((a, b) => a.date < b.date ? 1 : -1);
  for (const l of logs) {
    const e = (l.entries || []).find(x => x.name === exName);
    if (!e) continue;
    const sets = e.setLog || ((num(e.weight) || e.reps) ? [{ weight: e.weight, reps: e.reps }] : []);
    if (!sets.length) continue;
    const txt = sets.map(s => `${num(s.weight) ? s.weight : '–'}×${(s.reps != null && s.reps !== '') ? s.reps : '–'}`).join('  ');
    const top = Math.max(0, ...sets.map(s => num(s.weight)));
    const reps = Math.max(0, ...sets.map(s => num(s.reps)));
    return { date: l.date, txt, top, reps };
  }
  return null;
};

// Plan semanal de comidas + lista de compras, según el objetivo del perfil.
function bodyPlan() {
  const f = F(), t = targets(f.profile);
  if (!t) return '<div class="card"><div class="muted">Completá tu perfil (peso, altura, edad) para armar tu plan.</div><button class="btn btn-primary btn-sm" id="fit-go-perfil" style="margin-top:10px">Ir a Perfil</button></div>';
  const meal = (name, k, p) => `<div class="fit-move"><div class="fit-move-n">${escapeHtml(name)}</div><div class="fit-move-cue">~${k} kcal · ${p} g proteína</div></div>`;
  const dayMeals = [
    ['🍳 Desayuno — 3 huevos + 2 tostadas integrales + palta + fruta', 550, 28],
    ['🥣 Media mañana — yogur griego + avena + banana + maní', 520, 30],
    ['🍗 Almuerzo — pollo o carne magra (200 g) + arroz o papa + ensalada', 650, 50],
    ['🥤 Pre-gym (días de gym) — batido whey + banana + leche', 350, 35],
    ['🐟 Cena — pescado o carne (180 g) + boniato + verduras', 600, 42],
  ];
  const totK = dayMeals.reduce((a, m) => a + m[1], 0), totP = dayMeals.reduce((a, m) => a + m[2], 0);
  const plan = `<div class="card"><div class="card-title">Día tipo (≈ tu objetivo)</div>
    <div class="muted text-xs" style="margin-bottom:8px">Tu objetivo: ~${t.target} kcal · ${t.protein} g proteína. Este día suma ~${totK} kcal y ${totP} g. Los días sin gym, sacá el batido pre-gym (~−350 kcal).</div>
    ${dayMeals.map(m => meal(m[0], m[1], m[2])).join('')}</div>`;
  const swaps = `<div class="card"><div class="card-title">Cómo variar (mismo aporte)</div>
    <div class="fit-move"><div class="fit-move-n">Proteínas</div><div class="fit-move-cue">Pollo · carne magra · pescado · atún · huevos · yogur griego · whey. Rotá para no aburrirte.</div></div>
    <div class="fit-move"><div class="fit-move-n">Carbohidratos</div><div class="fit-move-cue">Arroz · papa/boniato · avena · pasta · pan integral · fruta.</div></div>
    <div class="fit-move"><div class="fit-move-n">Grasas</div><div class="fit-move-cue">Palta · maní/almendras · aceite de oliva · huevo entero.</div></div>
    <div class="fit-move"><div class="fit-move-n">Verduras (a voluntad)</div><div class="fit-move-cue">Hojas verdes · tomate · zanahoria · brócoli · zapallo.</div></div></div>`;
  const SHOP = [
    ['Proteínas', 'Huevos (2 docenas) · pechuga de pollo (1.5 kg) · carne magra (1 kg) · pescado o atún (4 latas / 800 g) · yogur griego (1 kg)'],
    ['Carbohidratos', 'Avena (500 g) · arroz (1 kg) · papa/boniato (2 kg) · pan integral · pasta (500 g) · fruta (bananas, manzanas)'],
    ['Grasas', 'Palta (3-4) · maní o almendras (250 g) · aceite de oliva'],
    ['Verduras', 'Hojas verdes (kale/acelga/espinaca) · tomate · zanahoria · brócoli'],
    ['Suplementos', 'Creatina (5 g/día) · whey (opcional, para cerrar la proteína)'],
  ];
  const shop = `<div class="card"><div class="card-title">🛒 Lista de compras (1 semana)</div>
    ${SHOP.map(s => `<div class="fit-move"><div class="fit-move-n">${escapeHtml(s[0])}</div><div class="fit-move-cue">${escapeHtml(s[1])}</div></div>`).join('')}
    <div class="muted text-xs" style="margin-top:8px">Cantidades aproximadas para 1 persona en fase de volumen. Ajustá según lo que ya tengas.</div></div>`;
  return plan + swaps + shop;
}
const TABS = [['resumen', 'Resumen'], ['dieta', 'Dieta'], ['plan', 'Plan'], ['comidas', 'Comidas'], ['bienestar', 'Bienestar'], ['cuerpo', 'Cuerpo'], ['peso', 'Peso'], ['gym', 'Gym'], ['reportes', 'Reportes'], ['perfil', 'Perfil']];
const bodyFor = (id) => ({ resumen: bodyResumen, dieta: bodyDieta, plan: bodyPlan, bienestar: bodyBienestar, cuerpo: bodyCuerpo, comidas: bodyComidas, peso: bodyPeso, gym: bodyGym, reportes: bodyReportes, perfil: bodyPerfil }[id] || bodyResumen)();

// ---- wiring ----
function wire(root) {
  const $ = (s) => root.querySelector(s);
  const all = (s) => Array.from(root.querySelectorAll(s));
  const k = tk();
  all('.fit-tab').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; renderFitness(root); }));

  // Resumen
  $('#fit-go-perfil')?.addEventListener('click', () => { tab = 'perfil'; renderFitness(root); });
  $('#fit-go-comidas')?.addEventListener('click', () => { tab = 'comidas'; renderFitness(root); });
  $('#fit-go-bienestar')?.addEventListener('click', () => { tab = 'bienestar'; renderFitness(root); });
  $('#fit-go-bienestar2')?.addEventListener('click', () => { tab = 'bienestar'; renderFitness(root); });
  $('#fit-go-dieta')?.addEventListener('click', () => { tab = 'dieta'; renderFitness(root); });
  // Dieta: registrar una opción sugerida
  all('[data-logidea]').forEach(b => b.addEventListener('click', () => { const it = lastDietaIdeas[+b.dataset.logidea]; if (it) logMealIdea(it); }));
  all('[data-logrepeat]').forEach(b => b.addEventListener('click', () => { const it = lastRepeatMeals[+b.dataset.logrepeat]; if (it) logMealIdea(it); }));

  // Bienestar
  $('#fit-sleep-save')?.addEventListener('click', () => saveDay(k, { sleepHours: num($('#fit-sleep').value) }));
  $('#fit-water-250')?.addEventListener('click', () => addWater(k, 250));
  $('#fit-water-500')?.addEventListener('click', () => addWater(k, 500));
  $('#fit-water-minus')?.addEventListener('click', () => addWater(k, -250));
  $('#fit-sweat')?.addEventListener('click', () => saveDay(k, { sweatExtra: num(getDay(k).sweatExtra) > 0 ? 0 : 750 }));
  $('#fit-med-10')?.addEventListener('click', () => addMeditation(k, 10));
  $('#fit-med-5')?.addEventListener('click', () => addMeditation(k, 5));
  $('#fit-med-reset')?.addEventListener('click', () => saveDay(k, { meditationMin: 0 }));
  all('[data-caf]').forEach(b => b.addEventListener('click', () => addCaffeine(k, b.dataset.caf)));
  all('[data-cafdel]').forEach(b => b.addEventListener('click', () => removeCaffeine(k, b.dataset.cafdel)));
  all('[data-inten]').forEach(b => b.addEventListener('click', () => { actIntensity = b.dataset.inten; renderFitness(root); }));
  all('[data-act]').forEach(b => b.addEventListener('click', () => { const min = num(root.querySelector('#fit-act-min')?.value, 0); logMovement(k, b.dataset.act, min); }));
  all('[data-actdel]').forEach(b => b.addEventListener('click', () => removeMovement(k, b.dataset.actdel)));
  all('[data-sup]').forEach(c => c.addEventListener('change', () => patchSup(k, c.dataset.sup, c.checked)));
  $('#fit-bowel-open')?.addEventListener('click', () => { showBowel = !showBowel; renderFitness(root); });
  $('#fit-bowel-add')?.addEventListener('click', () => addBowel(k, null));
  all('[data-bowel-b]').forEach(b => b.addEventListener('click', () => addBowel(k, +b.dataset.bowelB)));
  all('[data-boweldel]').forEach(b => b.addEventListener('click', () => removeBowel(k, b.dataset.boweldel)));
  all('[data-habit]').forEach(c => c.addEventListener('change', () => patchHabit(k, c.dataset.habit, c.checked)));
  all('[data-habtoggle]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.habtoggle; if (expandedHabits.has(id)) expandedHabits.delete(id); else expandedHabits.add(id); renderFitness(root); }));
  all('[data-step]').forEach(c => c.addEventListener('change', () => { const [hid, sid] = c.dataset.step.split('|'); patchHabitStep(k, hid, sid, c.checked); }));

  // Cuerpo
  all('[data-region]').forEach(g => g.addEventListener('click', () => cycleSore(g.dataset.region)));
  $('#fit-sore-clear')?.addEventListener('click', () => saveDay(k, { soreness: {} }));

  // Comidas
  all('[data-food]').forEach(b => b.addEventListener('click', () => { const food = F().foodLibrary.find(x => x.id === b.dataset.food); if (food) addFood(food); }));
  all('[data-del-meal]').forEach(b => b.addEventListener('click', () => removeMeal(b.dataset.delMeal)));
  $('#fit-food-toggle')?.addEventListener('click', () => { showFoodForm = !showFoodForm; renderFitness(root); });
  $('#ff-add')?.addEventListener('click', () => {
    const name = $('#ff-name').value.trim(); const kcal = num($('#ff-kcal').value); const protein = num($('#ff-prot').value);
    if (!name || !kcal) return;
    mutate(s => { s.fitness.foodLibrary.push({ id: 'u_' + uid(), emoji: $('#ff-emoji').value.trim() || '🍽️', name, kcal, protein, group: 'Otros' }); });
    showFoodForm = false;
  });
  $('#fit-c-date')?.addEventListener('change', (e) => { comidaDate = e.target.value; renderFitness(root); });
  $('#fit-c-save')?.addEventListener('click', () => { const date = $('#fit-c-date').value || k; saveDay(date, { calories: num($('#fit-c-cal').value), protein: num($('#fit-c-prot').value) }); comidaDate = null; });

  // Peso
  $('#fit-w-save')?.addEventListener('click', () => {
    const date = $('#fit-w-date').value || k, kg = num($('#fit-w-kg').value), bf = $('#fit-w-bf').value, mus = $('#fit-w-muscle').value;
    if (!kg) return;
    mutate(s => { s.fitness.weighIns = (s.fitness.weighIns || []).filter(w => w.date !== date); s.fitness.weighIns.push({ id: uid(), date, kg, bodyFatPct: bf ? num(bf) : null, muscleKg: mus ? num(mus) : null }); });
  });
  all('[data-del-weight]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.delWeight; mutate(s => { s.fitness.weighIns = (s.fitness.weighIns || []).filter(w => w.id !== id); }); }));

  // Gym
  all('[data-gymday]').forEach(b => b.addEventListener('click', () => { gymDayIndex = +b.dataset.gymday; renderFitness(root); }));
  $('#fit-match-save')?.addEventListener('click', () => { const v = $('#fit-match-date')?.value; if (v) mutate(s => { s.fitness.nextMatch = v; }); });
  $('#fit-match-clear')?.addEventListener('click', () => mutate(s => { delete s.fitness.nextMatch; }));
  $('#fit-plan-edit')?.addEventListener('click', () => { editPlan = !editPlan; renderFitness(root); });
  if (editPlan) {
    const ensure = (s) => { if (!s.fitness.plan) s.fitness.plan = JSON.parse(JSON.stringify(defaultFitnessPlan())); return s.fitness.plan; };
    const collect = () => {
      const exs = [];
      all('.ep-row').forEach(r => {
        const name = (r.querySelector('.ep-name')?.value || '').trim();
        if (!name) return;
        const sets = num(r.querySelector('.ep-sets')?.value, 3) || 3;
        const reps = (r.querySelector('.ep-reps')?.value || '').trim() || '10';
        const old = ((F().plan?.days?.[gymDayIndex]?.exercises) || [])[+r.dataset.ei] || {};
        exs.push({ name, sets, reps, cue: old.cue || '', yt: old.yt || name });
      });
      const dn = ($('#ep-dayname')?.value || '').trim();
      mutate(s => { const d = ensure(s).days[gymDayIndex]; d.exercises = exs; if (dn) d.name = dn; });
    };
    $('#ep-add')?.addEventListener('click', () => { collect(); mutate(s => { ensure(s).days[gymDayIndex].exercises.push({ name: 'Nuevo ejercicio', sets: 3, reps: '10', cue: '', yt: '' }); }); renderFitness(root); });
    all('[data-ep-del]').forEach(b => b.addEventListener('click', () => { collect(); const idx = +b.dataset.epDel; mutate(s => { ensure(s).days[gymDayIndex].exercises.splice(idx, 1); }); renderFitness(root); }));
    $('#ep-save')?.addEventListener('click', () => { collect(); editPlan = false; renderFitness(root); });
    $('#ep-cancel')?.addEventListener('click', () => { editPlan = false; renderFitness(root); });
  }
  all('[data-how]').forEach(b => b.addEventListener('click', () => { const key = b.dataset.how; if (expandedEx.has(key)) expandedEx.delete(key); else expandedEx.add(key); renderFitness(root); }));
  // + serie: agrega una fila al DOM sin re-render (preserva lo ya tipeado)
  all('[data-addset]').forEach(b => b.addEventListener('click', () => {
    const cont = b.closest('.fit-sets'); if (!cont) return;
    const n = cont.querySelectorAll('.fit-set').length; if (n >= 4) return;
    const div = document.createElement('div');
    div.className = 'fit-set';
    div.innerHTML = `<span class="fit-set-n">S${n + 1}</span><input type="number" step="0.5" inputmode="decimal" class="input fit-set-in" data-f="w" placeholder="kg"><input type="number" inputmode="numeric" class="input fit-set-in" data-f="r" placeholder="reps">`;
    cont.insertBefore(div, b);
    if (n + 1 >= 4) b.remove();
  }));
  $('#fit-gym-save')?.addEventListener('click', () => {
    const plan = F().plan, day = plan.days[gymDayIndex], entries = [];
    all('.fit-sets').forEach(cont => {
      const name = cont.dataset.name;
      const setLog = [];
      cont.querySelectorAll('.fit-set').forEach(rowEl => {
        const w = rowEl.querySelector('[data-f="w"]')?.value || '';
        const r = rowEl.querySelector('[data-f="r"]')?.value || '';
        if (w || r) setLog.push({ weight: w ? num(w) : null, reps: r || null });
      });
      if (setLog.length) entries.push({ name, setLog });
    });
    if (!entries.length) return;
    mutate(s => { s.fitness.workoutLogs = s.fitness.workoutLogs || []; s.fitness.workoutLogs.push({ id: uid(), date: k, dayIndex: gymDayIndex, dayName: day.name, entries }); });
  });
  all('[data-del-log]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.delLog; mutate(s => { s.fitness.workoutLogs = (s.fitness.workoutLogs || []).filter(l => l.id !== id); }); }));

  // Reportes
  all('[data-period]').forEach(b => b.addEventListener('click', () => { reportDays = +b.dataset.period; renderFitness(root); }));

  // Perfil
  $('#fp-save')?.addEventListener('click', () => {
    mutate(s => Object.assign(s.fitness.profile, {
      sex: $('#fp-sex').value, age: num($('#fp-age').value) || null, heightCm: num($('#fp-height').value) || null,
      weightKg: num($('#fp-weight').value) || null, activity: $('#fp-act').value, goal: $('#fp-goal').value,
      proteinPerKg: num($('#fp-prot').value, 1.8), surplusPct: num($('#fp-surplus').value, 12),
      bedtimeHour: num($('#fp-bedtime').value, 24),
    }));
    tab = 'resumen';
  });
}

export function renderFitness(root) {
  root.innerHTML = `
    <div class="fit">
      <div class="fit-head"><div><div class="fit-title">Fitness</div><div class="muted text-xs">Masa muscular + tenis · comida, peso, gym, bienestar y reportes</div></div></div>
      <div class="fit-tabs">${TABS.map(([id, lbl]) => `<button class="fit-tab ${tab === id ? 'active' : ''}" data-tab="${id}">${lbl}</button>`).join('')}</div>
      <div class="fit-body">${bodyFor(tab)}</div>
    </div>`;
  wire(root);
}
