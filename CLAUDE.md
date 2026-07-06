# Tempo — contexto para Claude Code

App personal de Dario: dashboard local-first de productividad + fitness (comidas, entrenos,
pesajes con OCR de Zepp, pomodoro, agenda, cuentas, notas del vault de Obsidian).
**Un solo usuario.** UI en español rioplatense (voseo: "Probá", "Cargá").

## Arquitectura (no cambiar sin razón fuerte)

- **Sin build, sin frameworks.** `server.js` (~2.500 líneas, Node ESM, solo builtins `node:` +
  `pg` lazy). Frontend: ES modules servidos desde `public/js/` — imports relativos CON `.js`.
- **Estado = un solo blob JSON.** Local: `data/state.json` (escritura atómica tmp+rename).
  Nube: fila `kv` en Postgres/Neon cuando hay `DATABASE_URL`. Deploy web en Render
  (https://tempo-kqoo.onrender.com), auto-deploy al pushear a `main`.
- Vistas en `public/js/views/*.js`: exportan `render<Nombre>(root)`, re-render completo vía
  `root.innerHTML` + wiring de listeners. Mutaciones SIEMPRE por `mutate(fn)` de `state.js`
  (notifica + persiste con debounce 350ms). Campos top-level nuevos del estado deben agregarse
  a `buildPayload()` en `state.js` o no se persisten.
- Helpers: `utils.js` (`escapeHtml`, `sanitizeUrl`, `todayKey`, `pomodoroStreak`, `uid`…),
  `components/toast.js` (`toast(msg, kind, opts)` — opts.actionLabel/onAction/duration).

## Locking optimista (contrato — respetarlo en TODO cambio de persistencia)

- `rev` (entero monotónico) vive DENTRO del blob. `PUT /api/state` manda `{ state, rev }`;
  el server responde **409** si `rev` es viejo (CAS en SQL para pg, mutex en proceso para archivo).
- El cliente trackea `serverRev` (state.js); ante 409 recarga y avisa; NUNCA reintenta un 409.
- Endpoints del server que bumpean rev por su cuenta (vault connect/disconnect, import)
  DEVUELVEN el rev nuevo y el cliente lo sincroniza con `syncServerRev()`.
- Scripts `*-nube.mjs`: transacción `BEGIN` / `SELECT … FOR UPDATE` / mutar /
  `rev = (rev|0)+1` / `UPDATE` / `COMMIT` en UN client de `pool.connect()`.
  Se pueden correr con la web abierta.

## Secretos y entorno

- Secretos en `.env` (gitignoreado; plantilla en `.env.example`): SMTP_* y TEMPO_PASSWORD.
  `server.js` lo carga al inicio; el entorno real siempre gana.
- **NO poner `DATABASE_URL` en `.env`** — el server local debe seguir usando `data/state.json`.
  Los scripts de nube leen la URL desde `data/.cloud-url`.
- El loader ignora `PORT`/`HOST` a propósito (cambiarían el bind a 0.0.0.0 desde un archivo).
- Modo nube (`DATABASE_URL` seteada) **exige** `TEMPO_PASSWORD` o el server no arranca.
- En Render las variables van por dashboard (Environment): DATABASE_URL, TEMPO_PASSWORD, SMTP_*.

## Backups

- Local: automático cada 60s a `data/backups/` (rotación 20).
- Nube: `descargar-nube.command` baja state+config de Neon a `data/backups-nube/` (rotación 30).
  LaunchAgent `com.dario.tempo-backup-nube` lo corre solo cada noche 21:45
  (log: `~/Library/Logs/tempo-backup-nube.log`).

## Git / deploy

- Remoto: `github.com/dariovillalon/tempo` (cuenta `dariovillalon`; si el push da
  "Repository not found", correr `gh auth switch -u dariovillalon`).
- Pushear a `main` = deploy a Render. `data/`, `.env` y `start.command` están gitignoreados.

## Historia

- `REVISION-PROYECTO-2026-07-04.md`: auditoría completa del proyecto.
- `IMPLEMENTACION-2026-07-05.md`: implementación de esa auditoría (seguridad, locking,
  XSS, ICS, timezone, etc.) — leerlo antes de tocar persistencia, auth o el vault.
- Pendientes conocidos (deliberadamente NO hechos): partir `fitness.js` (~1.550 líneas) en
  módulos; render incremental (hoy re-render completo por mutación, aceptable a esta escala).
