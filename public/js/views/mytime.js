// mytime.js — "Mi tiempo": planificación personal fuera del trabajo.
// Le decís cómo venís (energía + ganas) y te sugiere actividades para armar tu día,
// con un espacio para ir descubriendo qué te gusta (anti-workaholic).

import { state, mutate } from '../state.js';
import { todayKey, uid, escapeHtml, addDays } from '../utils.js';

const M = () => state.mytime;
const dayOf = (k) => M().days[k] || {};

const VIBES = [
  { id: 'tranqui',  label: 'Tranqui / descansar', emoji: '🌙' },
  { id: 'social',   label: 'Social',              emoji: '🫂' },
  { id: 'activo',   label: 'Activo / mover',      emoji: '⚡' },
  { id: 'recuperar',label: 'Bajo desgaste',       emoji: '🌊' },
  { id: 'creativo', label: 'Creativo',            emoji: '🎨' },
  { id: 'aire',     label: 'Aire libre',          emoji: '🌿' },
  { id: 'aprender', label: 'Aprender / curiosear',emoji: '🧠' },
  { id: 'aventura', label: 'Aventura / novedad',  emoji: '✨' },
  { id: 'cuidarme', label: 'Cuidarme / ordenar',  emoji: '🧘' },
];
const ENERGY = [['low', 'Baja'], ['med', 'Media'], ['high', 'Alta']];
const erank = (e) => ({ low: 1, med: 2, high: 3 }[e] || 2);

const ACTS = [
  { id: 'leer', label: 'Leer un libro', emoji: '📖', cat: 'Recarga', vibes: ['tranqui', 'aprender'], energy: 'low', mins: 45 },
  { id: 'siesta', label: 'Siesta o NSDR 20 min', emoji: '😴', cat: 'Recarga', vibes: ['tranqui', 'cuidarme'], energy: 'low', mins: 20 },
  { id: 'peli', label: 'Ver una peli o serie', emoji: '🎬', cat: 'Recarga', vibes: ['tranqui'], energy: 'low', mins: 120 },
  { id: 'album', label: 'Escuchar un álbum entero sin hacer nada', emoji: '🎧', cat: 'Recarga', vibes: ['tranqui', 'creativo'], energy: 'low', mins: 40 },
  { id: 'bano', label: 'Baño o ducha larga sin apuro', emoji: '🛁', cat: 'Recarga', vibes: ['tranqui', 'cuidarme'], energy: 'low', mins: 30 },
  { id: 'desconectar', label: '2 horas sin celular', emoji: '📵', cat: 'Recarga', vibes: ['tranqui', 'cuidarme'], energy: 'low', mins: 120 },
  { id: 'journaling', label: 'Escribir cómo te sentís (journaling)', emoji: '📝', cat: 'Recarga', vibes: ['tranqui', 'creativo', 'cuidarme'], energy: 'low', mins: 20 },
  { id: 'amigos', label: 'Juntada con amigos', emoji: '🍻', cat: 'Vínculos', vibes: ['social'], energy: 'med', mins: 180 },
  { id: 'llamar', label: 'Llamar a alguien que hace rato no hablás', emoji: '📞', cat: 'Vínculos', vibes: ['social', 'cuidarme'], energy: 'low', mins: 30 },
  { id: 'asado', label: 'Organizar un asado o cena', emoji: '🔥', cat: 'Vínculos', vibes: ['social', 'creativo'], energy: 'med', mins: 240 },
  { id: 'cafe', label: 'Café con alguien', emoji: '☕', cat: 'Vínculos', vibes: ['social', 'tranqui'], energy: 'low', mins: 60 },
  { id: 'musica', label: 'Música en vivo o un bar nuevo', emoji: '🎶', cat: 'Vínculos', vibes: ['social', 'aventura'], energy: 'med', mins: 180 },
  { id: 'pareja', label: 'Plan con tu pareja / una cita', emoji: '❤️', cat: 'Vínculos', vibes: ['social', 'tranqui'], energy: 'med', mins: 150 },
  { id: 'tenis', label: 'Jugar al tenis', emoji: '🎾', cat: 'Movimiento', vibes: ['activo'], energy: 'high', mins: 90 },
  { id: 'correr', label: 'Salir a correr al aire libre', emoji: '🏃', cat: 'Movimiento', vibes: ['activo', 'aire'], energy: 'high', mins: 40 },
  { id: 'bici', label: 'Andar en bici', emoji: '🚴', cat: 'Movimiento', vibes: ['activo', 'aire'], energy: 'med', mins: 60 },
  { id: 'hike', label: 'Caminata / hike', emoji: '🥾', cat: 'Movimiento', vibes: ['activo', 'aire', 'aventura'], energy: 'med', mins: 120 },
  { id: 'natacion', label: 'Nadar', emoji: '🏊', cat: 'Movimiento', vibes: ['activo'], energy: 'med', mins: 45 },
  { id: 'deporte_nuevo', label: 'Probar un deporte nuevo', emoji: '🤸', cat: 'Movimiento', vibes: ['activo', 'aventura'], energy: 'high', mins: 90 },
  { id: 'instrumento', label: 'Tocar / aprender un instrumento', emoji: '🎸', cat: 'Creatividad', vibes: ['creativo', 'aprender'], energy: 'med', mins: 45 },
  { id: 'foto', label: 'Salir a sacar fotos', emoji: '📷', cat: 'Creatividad', vibes: ['creativo', 'aire'], energy: 'med', mins: 90 },
  { id: 'cocinar', label: 'Cocinar una receta nueva', emoji: '🍳', cat: 'Creatividad', vibes: ['creativo', 'tranqui'], energy: 'med', mins: 75 },
  { id: 'escribir', label: 'Escribir algo (idea, blog, cuento)', emoji: '✍️', cat: 'Creatividad', vibes: ['creativo', 'aprender'], energy: 'med', mins: 60 },
  { id: 'manos', label: 'Proyecto manual (armar/reparar algo)', emoji: '🛠️', cat: 'Creatividad', vibes: ['creativo'], energy: 'med', mins: 90 },
  { id: 'parque', label: 'Ir a un parque o plaza', emoji: '🌳', cat: 'Naturaleza', vibes: ['aire', 'tranqui'], energy: 'low', mins: 60 },
  { id: 'playa', label: 'Día de playa / río', emoji: '🏖️', cat: 'Naturaleza', vibes: ['aire', 'tranqui'], energy: 'low', mins: 240 },
  { id: 'atardecer', label: 'Ver el atardecer en un lugar lindo', emoji: '🌅', cat: 'Naturaleza', vibes: ['aire', 'tranqui'], energy: 'low', mins: 45 },
  { id: 'picnic', label: 'Picnic', emoji: '🧺', cat: 'Naturaleza', vibes: ['aire', 'social'], energy: 'low', mins: 120 },
  { id: 'documental', label: 'Ver un documental de algo nuevo', emoji: '🎥', cat: 'Curiosidad', vibes: ['aprender', 'tranqui'], energy: 'low', mins: 90 },
  { id: 'museo', label: 'Ir a un museo o muestra', emoji: '🖼️', cat: 'Curiosidad', vibes: ['aprender', 'aventura'], energy: 'med', mins: 120 },
  { id: 'podcast', label: 'Podcast nuevo mientras caminás', emoji: '🎙️', cat: 'Curiosidad', vibes: ['aprender', 'aire'], energy: 'low', mins: 45 },
  { id: 'clase', label: 'Probar una clase suelta (cerámica, baile…)', emoji: '🎟️', cat: 'Curiosidad', vibes: ['aprender', 'aventura', 'creativo'], energy: 'med', mins: 90 },
  { id: 'barrio', label: 'Explorar un barrio que no conocés', emoji: '🗺️', cat: 'Aventura', vibes: ['aventura', 'aire'], energy: 'med', mins: 120 },
  { id: 'escapada', label: 'Escapada de un día a otro lugar', emoji: '🚗', cat: 'Aventura', vibes: ['aventura', 'aire'], energy: 'med', mins: 480 },
  { id: 'resto', label: 'Probar un restaurante nuevo', emoji: '🍽️', cat: 'Aventura', vibes: ['aventura', 'social'], energy: 'low', mins: 120 },
  { id: 'algo_nuevo', label: 'Hacer algo que nunca hiciste', emoji: '✨', cat: 'Aventura', vibes: ['aventura'], energy: 'med', mins: 90 },
  { id: 'ordenar', label: 'Ordenar un espacio que te molesta', emoji: '🧹', cat: 'Cuidarme', vibes: ['cuidarme'], energy: 'med', mins: 45 },
  { id: 'semana', label: 'Pensar tu semana personal (no laboral)', emoji: '🗓️', cat: 'Cuidarme', vibes: ['cuidarme', 'tranqui'], energy: 'low', mins: 30 },
  { id: 'meditar', label: 'Meditar 10–15 min', emoji: '🧘', cat: 'Cuidarme', vibes: ['cuidarme', 'tranqui'], energy: 'low', mins: 15 },
  // Bajo desgaste — complementan el deporte sin sobrecargarte
  { id: 'golf', label: 'Jugar al golf', emoji: '⛳', cat: 'Movimiento suave', vibes: ['recuperar', 'aire', 'social'], energy: 'low', mins: 240 },
  { id: 'yoga', label: 'Yoga o movilidad', emoji: '🧘', cat: 'Movimiento suave', vibes: ['recuperar', 'cuidarme'], energy: 'low', mins: 45 },
  { id: 'nat_suave', label: 'Nadar suave / flotar', emoji: '🏊', cat: 'Movimiento suave', vibes: ['recuperar', 'aire'], energy: 'low', mins: 40 },
  { id: 'caminata_larga', label: 'Caminata larga sin apuro', emoji: '🚶', cat: 'Movimiento suave', vibes: ['recuperar', 'aire', 'tranqui'], energy: 'low', mins: 60 },
  { id: 'sup', label: 'Kayak o SUP tranquilo', emoji: '🛶', cat: 'Movimiento suave', vibes: ['recuperar', 'aire', 'aventura'], energy: 'med', mins: 90 },
  { id: 'vela', label: 'Salir a navegar / vela', emoji: '⛵', cat: 'Aventura', vibes: ['recuperar', 'aire', 'aventura'], energy: 'med', mins: 240 },
  { id: 'pesca', label: 'Ir a pescar', emoji: '🎣', cat: 'Naturaleza', vibes: ['recuperar', 'aire', 'tranqui'], energy: 'low', mins: 180 },
  { id: 'spa', label: 'Spa / masaje', emoji: '💆', cat: 'Recuperación', vibes: ['recuperar', 'cuidarme', 'tranqui'], energy: 'low', mins: 90 },
  { id: 'sauna', label: 'Sauna + pileta', emoji: '♨️', cat: 'Recuperación', vibes: ['recuperar', 'cuidarme', 'tranqui'], energy: 'low', mins: 60 },
  // Sin límite de presupuesto — experiencias
  { id: 'coach', label: 'Clase particular con coach (tenis, etc.)', emoji: '🏅', cat: 'Experiencia', vibes: ['activo', 'aprender'], energy: 'high', mins: 90 },
  { id: 'curso', label: 'Curso de algo (cocina, fotografía, vela…)', emoji: '🎓', cat: 'Experiencia', vibes: ['aprender', 'aventura', 'creativo'], energy: 'med', mins: 120 },
  { id: 'show', label: 'Ir a un show / concierto / partido', emoji: '🎫', cat: 'Experiencia', vibes: ['social', 'aventura'], energy: 'med', mins: 180 },
  { id: 'resto_top', label: 'Cena en un restaurante top', emoji: '🍷', cat: 'Experiencia', vibes: ['social', 'aventura', 'tranqui'], energy: 'low', mins: 150 },
  { id: 'escapada_premium', label: 'Escapada de finde a otro lugar', emoji: '🧳', cat: 'Experiencia', vibes: ['aventura', 'aire', 'recuperar'], energy: 'med', mins: 480 },
  { id: 'viaje_corto', label: 'Viaje corto a otra ciudad', emoji: '✈️', cat: 'Experiencia', vibes: ['aventura', 'aire'], energy: 'med', mins: 480 },
  { id: 'gym', label: 'Ir al gym', emoji: '🏋️', cat: 'Movimiento', vibes: ['activo'], energy: 'high', mins: 60 },
];

// Cómo hacer cada actividad para que de verdad relaje (no que la "tachés").
const HOW = {
  leer: 'Cel en modo avión o en otra habitación. Un solo libro, sin apuro.',
  siesta: 'Sin culpa. Tapate los ojos, alarma a 20 min así no te pasás.',
  peli: 'Elegí antes qué ver para no perder 20 min buscando. Cel lejos.',
  album: 'Auriculares, ojos cerrados, no hagas nada más. Es el plan, no el fondo.',
  bano: 'Sin cel adentro. Agua caliente, luz baja, que sea un ritual.',
  desconectar: 'Cel en un cajón u otro cuarto. Avisá antes si esperás algo importante.',
  journaling: 'A mano si podés, sin pensar si está bien. Nadie lo va a leer.',
  amigos: 'Cel en el bolsillo en silencio. La presencia real es la recarga.',
  llamar: 'Llamá, no mensajes. 10 min de voz valen más que media hora de chat.',
  asado: 'Delegá algo, no controles todo. El plan es disfrutar, no producir.',
  cafe: 'Cel boca abajo en la mesa. Escuchá más de lo que hablás.',
  musica: 'Viví el show, no lo filmes. Dejate llevar.',
  pareja: 'Sin pantallas los dos. Algo simple pero presente.',
  tenis: 'Entrá en calor bien. Si venís cargado, bajá intensidad (lo ves en Fitness).',
  correr: 'A veces sin auriculares: escuchá tu respiración. Ritmo cómodo, no PR.',
  bici: 'Ruta tranquila, parate a mirar algo lindo. No es entrenamiento.',
  hike: 'Agua, sin apuro. Parate en los miradores y respirá.',
  natacion: 'Nadá tranquilo, contá brazadas. Meditación en movimiento.',
  deporte_nuevo: 'Andá sin expectativa de ser bueno. Lo nuevo es el punto.',
  instrumento: 'Sin meta de rendir. 20 min de tocar lo que salga ya alcanza.',
  foto: 'Caminá buscando luz, no likes. Una foto que te guste a vos.',
  cocinar: 'Música de fondo, receta nueva, sin apuro. Disfrutá el proceso.',
  escribir: 'No edites mientras escribís. Largá lo que salga, después ves.',
  manos: 'Algo con las manos baja la cabeza. No importa si queda perfecto.',
  parque: 'Dejá el cel en el bolsillo o en casa. Sentate, mirá, no scrollees.',
  playa: 'Cel en la mochila. Agua, sol, nada que resolver.',
  atardecer: 'Llegá 10 min antes, sentate y solo mirá. Sin filmar.',
  picnic: 'Algo rico, una manta, alguien que quieras. Sin pantallas.',
  documental: 'Uno solo, elegido antes. Cel lejos para no partir la atención.',
  museo: 'Sin apuro, parate en lo que te llame. No tenés que ver todo.',
  podcast: 'Caminá mientras escuchás: te despeja y suma dos cosas en una.',
  clase: 'Andá curioso, no a ser el mejor. Probar es el objetivo.',
  barrio: 'No uses el mapa todo el tiempo. Perdete un poco a propósito.',
  escapada: 'Reservá lo justo, dejá huecos para improvisar. Modo no-trabajo.',
  resto: 'Andá con hambre y curiosidad. Pedí algo que nunca probaste.',
  algo_nuevo: 'Que te dé un poco de nervios sano: es señal de que sirve.',
  ordenar: 'Un solo espacio, 45 min, música. Ordenar afuera ordena adentro.',
  semana: 'Planeá lo personal, no el trabajo. ¿Qué querés para vos esta semana?',
  meditar: 'Sentado, ojos cerrados, seguí la respiración. Si te distraés, volvés.',
  golf: 'Ritmo lento, caminá la cancha. Social y al aire libre, no competencia.',
  yoga: 'Seguí tu respiración, no fuerces. 30–45 min suaves alcanzan.',
  nat_suave: 'Nadá lento o flotá. Recuperación, no entrenamiento.',
  caminata_larga: 'Sin destino fijo, ritmo charla. Dejá que la cabeza divague.',
  sup: 'Aguas tranquilas, sin apuro. Equilibrio + calma.',
  vela: 'Dejate llevar por el viento, desconectá del reloj.',
  pesca: 'La gracia es la espera y el silencio, no cuánto pescás.',
  spa: 'Apagá el cel en la entrada. Date permiso de no hacer nada.',
  sauna: 'Hidratate, alterná calor y pileta. Sin pantallas adentro.',
  coach: 'Pedile que te corrija la técnica: mejorás sin sobreentrenar.',
  curso: 'Elegí algo que SIEMPRE quisiste probar, no algo "útil".',
  show: 'Viví el momento, guardá el cel. La memoria queda igual.',
  resto_top: 'Reservá, sin apuro. Es una experiencia, no solo comer.',
  escapada_premium: 'Lugar tranquilo, plan suelto. Volvé descansado, no agotado.',
  viaje_corto: 'Liviano de equipaje y de agenda. Improvisá.',
  gym: 'Calentá bien, registrá tus series en Fitness y no te sobrecargues. Si venís cargado, bajá el volumen.',
};
const complementFor = (a) => {
  if (a.vibes.includes('activo')) return 'Para no sobrecargarte, después sumá algo de bajo desgaste: estiramiento, sauna o una caminata suave.';
  if (a.cat === 'Vínculos') return 'Combinalo con aire libre (un parque, una caminata) para que sea más tranqui y presente.';
  if (a.cat === 'Recarga' || a.cat === 'Recuperación' || a.cat === 'Movimiento suave') return 'Si te quedan ganas, sumá un toque creativo o un vínculo (un café con alguien). Y si solo querés descansar, está perfecto.';
  if (a.cat === 'Naturaleza') return 'Llevá un libro o algo para journaling: aire libre + escribir baja muchísimo las revoluciones.';
  if (a.cat === 'Creatividad' || a.cat === 'Curiosidad') return 'Dejá el cel en otro cuarto para entrar en flow de verdad.';
  if (a.cat === 'Experiencia') return 'Dejá huecos en el día alrededor: la idea es disfrutarlo sin correr.';
  return 'Hacelo sin apuro y sin el cel encima — esa es la diferencia entre pasar el tiempo y disfrutarlo.';
};
const isWeekend = (k) => { const wd = new Date(k + 'T12:00:00').getDay(); return wd === 0 || wd === 6; };

const PROMPTS = [
  '¿Qué actividad te hizo perder la noción del tiempo últimamente?',
  'Si tuvieras un día entero sin obligaciones ni culpa, ¿qué harías?',
  '¿Qué hacías de chico/adolescente que te encantaba y dejaste?',
  '¿Qué te da energía en vez de quitártela?',
  '¿A quién admirás por cómo vive (no por lo que logró)? ¿Qué le copiarías?',
  '¿Qué cosa te dio curiosidad este mes y no llegaste a probar?',
  'Cuando descansás de verdad, ¿qué estás haciendo?',
  '¿Qué te gustaría poder decir que hiciste dentro de un año?',
];
const promptOfDay = () => { const d = new Date(); const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); return PROMPTS[doy % PROMPTS.length]; };

// ---- mutaciones ----
function setEnergy(k, e) { mutate(s => { const d = s.mytime.days[k] || (s.mytime.days[k] = {}); d.energy = e; }); }
function toggleVibe(k, v) { mutate(s => { const d = s.mytime.days[k] || (s.mytime.days[k] = {}); d.vibes = d.vibes || []; d.vibes = d.vibes.includes(v) ? d.vibes.filter(x => x !== v) : [...d.vibes, v]; }); }
function addBlock(k, act) { mutate(s => { const d = s.mytime.days[k] || (s.mytime.days[k] = {}); d.blocks = d.blocks || []; d.blocks.push({ id: uid(), time: '', label: act.label, emoji: act.emoji, category: act.cat, done: false }); }); }
function addManual(k, label, time) { if (!label) return; mutate(s => { const d = s.mytime.days[k] || (s.mytime.days[k] = {}); d.blocks = d.blocks || []; d.blocks.push({ id: uid(), time: time || '', label, emoji: '•', category: 'Propio', done: false }); }); }
function setBlockTime(k, id, time) { mutate(s => { const d = s.mytime.days[k]; if (!d) return; const b = (d.blocks || []).find(x => x.id === id); if (b) b.time = time; }); }
function toggleBlock(k, id) { mutate(s => { const d = s.mytime.days[k]; if (!d) return; const b = (d.blocks || []).find(x => x.id === id); if (b) b.done = !b.done; }); }
function removeBlock(k, id) { mutate(s => { const d = s.mytime.days[k]; if (!d) return; d.blocks = (d.blocks || []).filter(x => x.id !== id); }); }
function setJournal(k, txt) { mutate(s => { const d = s.mytime.days[k] || (s.mytime.days[k] = {}); d.journal = txt; }); }

// ---- sugerencias ----
function suggestions(d) {
  const vibes = d.vibes || [];
  const en = d.energy || 'med';
  let list = ACTS.filter(a => erank(a.energy) <= erank(en) && (!vibes.length || a.vibes.some(v => vibes.includes(v))));
  // priorizar por cantidad de "ganas" que matchean
  list = list.map(a => ({ a, score: a.vibes.filter(v => vibes.includes(v)).length })).sort((x, y) => y.score - x.score).map(x => x.a);
  return list.slice(0, 12);
}

// Balance de la semana: cuántos días te hiciste tiempo y cuántas cosas cumpliste.
function weekBalance() {
  const days = M().days || {};
  let plannedDays = 0, doneCount = 0;
  for (let i = 0; i < 7; i++) {
    const rec = days[todayKey(addDays(new Date(), -i))];
    if (rec && (rec.blocks || []).length) plannedDays++;
    if (rec) doneCount += (rec.blocks || []).filter(b => b.done).length;
  }
  if (!plannedDays && !doneCount) return '';
  const tip = plannedDays < 2
    ? 'Esta semana casi no te tomaste tiempo. Elegí una idea de abajo y ponele hora — aunque sea 30 min.'
    : '💪 Te estás haciendo tiempo para vos. Seguí así.';
  return `<div class="card"><div class="card-title">Tu semana para vos</div><div class="fit-grid">
    <div class="fit-tile"><div class="fit-tile-lbl">Días con plan propio</div><div class="fit-tile-val">${plannedDays}<span> / 7</span></div></div>
    <div class="fit-tile"><div class="fit-tile-lbl">Cosas hechas para vos</div><div class="fit-tile-val">${doneCount}</div></div>
  </div><div class="mt-balance" style="margin-top:10px">${tip}</div></div>`;
}
// Si ya entrenó o está cargado (datos de Fitness), empujar bajo desgaste.
function recoveryNudge(k) {
  const ff = state.fitness || {};
  const fd = (ff.days || {})[k] || {};
  const trainedToday = (ff.workoutLogs || []).some(l => l.date === k) || (fd.activityLog || []).length > 0;
  const sore = Object.keys(fd.soreness || {}).length > 0;
  if (!trainedToday && !sore) return '';
  const why = sore ? 'venís con zonas cargadas' : 'ya entrenaste hoy';
  return `<div class="card"><div class="mt-balance">🌊 Como ${why}, hoy te conviene algo de <b>bajo desgaste</b> para recuperar: sauna o spa, caminata suave, nadar tranquilo, yoga o navegar. Tocá "Bajo desgaste" en Ganas y mirá las ideas.</div></div>`;
}

export function renderMyTime(root) {
  const k = todayKey();
  const d = dayOf(k);
  const vibes = d.vibes || [];
  const en = d.energy || 'med';

  const balanceTip = vibes.includes('activo') ? `<div class="mt-balance">🌊 Te encanta el deporte pero te sobrecargás. Sumá algo de <b>bajo desgaste</b> (golf, vela, nadar suave, spa) para seguir activo sin quemarte. Toqué la opción "Bajo desgaste" arriba y mirá las ideas.</div>` : '';
  const intro = `<div class="card mt-intro"><div class="mt-intro-t">Esto es <b>tu</b> tiempo, no una to-do list.</div><div class="muted text-xs">Sos de laburar de más — acá reconectás con qué te gusta. El presupuesto no es límite: si una experiencia (un curso, una escapada, un coach) suma, va. Vale también elegir "no hacer nada productivo".</div>${balanceTip}</div>`;

  const mood = `<div class="card">
    <div class="card-title">¿Cómo venís hoy?</div>
    <div class="mt-row"><span class="muted text-xs" style="width:64px">Energía</span>${ENERGY.map(([id, lab]) => `<button class="fit-day-tab ${en === id ? 'active' : ''}" data-energy="${id}">${lab}</button>`).join('')}</div>
    <div class="mt-row" style="margin-top:10px;align-items:flex-start"><span class="muted text-xs" style="width:64px;padding-top:6px">Ganas</span><div class="mt-vibes">${VIBES.map(v => `<button class="mt-chip ${vibes.includes(v.id) ? 'active' : ''}" data-vibe="${v.id}">${v.emoji} ${v.label}</button>`).join('')}</div></div>
  </div>`;

  const sug = suggestions(d);
  const sugCard = `<div class="card">
    <div class="card-title">Ideas para vos ${vibes.length || en !== 'med' ? '' : '<span class="muted text-xs">— elegí energía y ganas arriba para afinar</span>'}</div>
    <div class="mt-sugs">${sug.map(a => `<div class="mt-sug"><div class="mt-sug-main"><span class="mt-sug-emoji">${a.emoji}</span><div><div class="mt-sug-label">${escapeHtml(a.label)}</div><div class="mt-sug-meta">${escapeHtml(a.cat)} · ~${a.mins} min</div></div></div><button class="btn btn-ghost btn-sm" data-add="${a.id}">+ Al plan</button></div>`).join('')}</div>
    <button class="btn btn-secondary btn-sm" id="mt-surprise" style="margin-top:10px">🎲 Sorprendeme (elegí por mí)</button>
  </div>`;

  const blocks = [...(d.blocks || [])].sort((a, b) => (a.time || '99') < (b.time || '99') ? -1 : 1);
  const planRows = blocks.length ? blocks.map(b => `<div class="mt-block ${b.done ? 'done' : ''}">
      <input type="time" class="input mt-btime" data-btime="${b.id}" value="${b.time || ''}">
      <input type="checkbox" data-bdone="${b.id}" ${b.done ? 'checked' : ''}>
      <span class="mt-block-label">${b.emoji || '•'} ${escapeHtml(b.label)}</span>
      <button class="btn btn-ghost btn-sm" data-bdel="${b.id}">✕</button>
    </div>`).join('') : '<div class="muted text-xs">Tu plan está vacío. Sumá ideas de arriba o escribí la tuya abajo.</div>';
  const planCard = `<div class="card">
    <div class="card-title">Tu plan de hoy</div>
    <div class="mt-plan">${planRows}</div>
    <div class="row gap-6" style="margin-top:12px"><input type="text" class="input" id="mt-label" placeholder="Algo que quieras hacer…" style="flex:1"><input type="time" class="input" id="mt-time" style="width:110px"><button class="btn btn-primary btn-sm" id="mt-add">+ Agregar</button></div>
  </div>`;

  const journalCard = `<div class="card">
    <div class="card-title">Para pensar / conocerte</div>
    <div class="mt-prompt">💭 ${escapeHtml(promptOfDay())}</div>
    <textarea class="textarea" id="mt-journal" placeholder="Escribí lo que se te venga, sin filtro…" style="min-height:90px;margin-top:8px">${d.journal ? escapeHtml(d.journal) : ''}</textarea>
    <div class="muted text-xs" style="margin-top:6px">Se guarda solo. Con el tiempo, releer esto te va a mostrar patrones de lo que te hace bien.</div>
  </div>`;

  root.innerHTML = `<div class="fit">
    <div class="fit-head"><div><div class="fit-title">Mi tiempo</div><div class="muted text-xs">Tu tiempo personal, fuera del trabajo</div></div></div>
    ${intro}${recoveryNudge(k)}${weekBalance()}${mood}${sugCard}${planCard}${journalCard}
  </div>`;

  // wiring
  const $ = (s) => root.querySelector(s);
  const all = (s) => Array.from(root.querySelectorAll(s));
  all('[data-energy]').forEach(b => b.addEventListener('click', () => setEnergy(k, b.dataset.energy)));
  all('[data-vibe]').forEach(b => b.addEventListener('click', () => toggleVibe(k, b.dataset.vibe)));
  all('[data-add]').forEach(b => b.addEventListener('click', () => { const a = ACTS.find(x => x.id === b.dataset.add); if (a) addBlock(k, a); }));
  all('[data-btime]').forEach(i => i.addEventListener('change', () => setBlockTime(k, i.dataset.btime, i.value)));
  all('[data-bdone]').forEach(c => c.addEventListener('change', () => toggleBlock(k, c.dataset.bdone)));
  all('[data-bdel]').forEach(b => b.addEventListener('click', () => removeBlock(k, b.dataset.bdel)));
  $('#mt-surprise')?.addEventListener('click', () => { if (sug.length) addBlock(k, sug[Math.floor(Math.random() * sug.length)]); });
  $('#mt-add')?.addEventListener('click', () => { addManual(k, $('#mt-label').value.trim(), $('#mt-time').value); });
  $('#mt-journal')?.addEventListener('change', (e) => setJournal(k, e.target.value));
}
