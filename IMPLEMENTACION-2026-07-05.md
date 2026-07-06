# Implementación de la revisión — 5/6 de julio 2026

Se implementó **todo** lo señalado en `REVISION-PROYECTO-2026-07-04.md` (alta, media y baja),
más una tanda de bugs nuevos encontrados durante el trabajo. 26 archivos tocados,
~900 líneas agregadas. Todo verificado: sintaxis, boot local y contrato de locking end-to-end.

## Prioridad alta (los 5 del veredicto)

1. **Secretos fuera de `start.command`** → ahora viven en `.env` (gitignoreado; hay `.env.example`
   committeable). El server tiene un loader propio de `.env` sin dependencias, así que funciona
   igual con doble-click, `npm start` o `node server.js`. `start.command` avisa si falta `.env`.
   ⚠️ **PENDIENTE TUYO: rotá el App Password de Gmail** (estuvo en texto plano en `start.command`):
   https://myaccount.google.com/apppasswords → revocá el viejo, generá uno nuevo y actualizá `.env`.
2. **Bug de timezone en comidas** → nueva convención única con `tsFor(dayKey, hh, mm)` (hora local
   vía `fromKey`, sin parseo de strings). `editMealTime` y `addFood` la usan; las comidas cerca de
   medianoche ya no saltan de día.
3. **`javascript:` URLs en Bills** → `sanitizeUrl()` en utils (solo http/https). El link de pago
   solo se renderiza como `<a>` si pasa la validación (si no, texto plano + aviso al guardar).
   Mismo tratamiento en los resources de proyectos.
4. **Condición de carrera entre pestañas/dispositivos** → optimistic locking completo:
   - `rev` (entero monotónico) dentro del blob de estado; `PUT /api/state` manda `{ state, rev }`.
   - El server responde **409** si otro cliente guardó primero (CAS en SQL para Neon, mutex en
     proceso para el archivo local). Clientes legacy sin rev siguen funcionando.
   - El frontend trackea `serverRev`, ante 409 recarga y avisa con toast; los endpoints que
     bumpean rev por su cuenta (vault connect/disconnect, import) devuelven el rev nuevo y el
     cliente lo sincroniza (sin 409 espurios).
   - Los 6 scripts `*-nube.mjs` ahora van en transacción `SELECT … FOR UPDATE` + bump de rev.
     Ya no hace falta cerrar las pestañas antes de correrlos.
5. **Backup de la nube** → `descargar-nube.command` (doble-click): baja el state (y config) de Neon
   a `data/backups-nube/state-FECHA.json`, rotación de 30. Solo lee, se puede correr con la web abierta.

## Prioridad media

- **CORS**: ya no se emite `Access-Control-Allow-Origin: *`; solo si seteás `ALLOWED_ORIGIN`.
- **Modo nube exige contraseña**: con `DATABASE_URL` y sin `TEMPO_PASSWORD` el server no arranca.
- **Errores silenciosos**: los `catch {}` que tapaban fallos reales ahora logean (`[vault]`, `[sync]`,
  `[btc]`, `[export]`, `[router]`…) y los que afectan al usuario muestran toast (sync de vault,
  búsqueda del quick capture).
- **Reintentos al guardar**: backoff exponencial (máx 5, techo 30s) + toast con botón "Reintentar".
- **Cierre de pestaña**: flush inmediato en `pagehide`/`visibilitychange` con `fetch keepalive`.
- **Alertas BTC**: histéresis (re-arma recién cuando el precio se aleja 1%) + backoff exponencial
  del SMTP (10min → 6h).
- **Timeouts en salidas de red**: fetch de calendarios ICS con AbortController de 10s (BTC y SMTP ya tenían).
- **Validación de rangos** en fitness: pesaje 30–250 kg, grasa 3–70%, kcal 1–5000, proteína 0–500,
  sueño 0–24 h, actividad 1–1440 min — con toasts en español.
- **Rachas deduplicadas**: `pomodoroStreak()` en utils.js reemplaza las 2 copias idénticas
  (dashboard/today). La de fitness es semánticamente distinta y quedó donde estaba (con la fecha
  de referencia congelada).
- **`foodLibrary` null-safe** en la vista de comidas.

## Prioridad baja

- Hint de atajos corregido (⌘Z es solo de la pizarra).
- Comidas en días pasados: mediodía consistente vía `tsFor(k, 12, 0)`.
- `aria-label` + `role="img"` en los charts SVG de fitness y el mapa corporal.
- `window.__pendingVaultPath` eliminado → deep-link one-shot vía `queueVaultFile()` (export tipado).

## Bugs nuevos encontrados y arreglados (no estaban en la revisión)

- **Path traversal real** en `/api/vault/file` y `/api/vault/save` (el check `startsWith` sin
  separador permitía escapar a carpetas hermanas; ahora usan `resolveVaultPath`). Igual en `serveStatic`.
- **Conectar/desconectar vault pisaba `icsUrls`** en config.json (ahora read-modify-write).
- **XSS almacenado** en el feed de actividad (dashboard/project) y en el HTML crudo que `marked`
  renderizaba desde notas del vault (hook central que escapa HTML inline/bloque). `marked` pinneado a v15.
- **Comparación de contraseña timing-safe** (sha256 + `timingSafeEqual`).
- **Eventos recurrentes ICS**: se ignoraba `RECURRENCE-ID` (reuniones movidas aparecían duplicadas),
  `EXDATE` multi-valor (ocurrencias borradas seguían apareciendo) e `INTERVAL` semanal con `BYDAY`
  (eventos quincenales aparecían todas las semanas).
- **Tareas archivadas**: abrirlas y guardarlas las corrompía a estado `''` (invisibles para siempre).
- **Leak de listeners** en la pizarra (2–4 listeners de documento por ítem por repintada, nunca
  removidos → ahora un único par global).
- **Bimestral**: las cuentas bimestrales se reseteaban todos los meses; ahora tienen período real
  de 2 meses (compatible con las marcas viejas). Y el mes de bills/promos se calcula en hora local
  (antes UTC: a las 21:00 del último día del mes ya contaba como el mes siguiente).
- **Pull del vault perdía la recurrencia** de tareas.
- **`.env` no puede cambiar el bind address** (PORT/HOST solo desde el entorno real).

## Verificación

- `node --check` en los 30 archivos JS/MJS tocados: OK.
- Boot local: auth 401/200, `.env` cargado, sin headers CORS.
- Contrato rev end-to-end: GET rev 0 → PUT ok rev 1 → PUT stale **409** → PUT legacy ok rev 2.
- Revisión adversarial multi-agente del diff completo (6 revisores + refutadores por hallazgo):
  los 6 hallazgos confirmados fueron corregidos (rev en respuestas de vault/import + sync en cliente,
  flush con guardas `saveInFlight`/`mutSeq`, deep-link one-shot, migración suave del período
  bimestral + orden del historial, `migrate-to-db` ya no traga errores de DB).

## Para deployar a la web (Render)

`git add … && git commit && git push` (el deploy de Render sale del repo). En Render, además:
- seteá `TEMPO_PASSWORD` en el dashboard si no está (ahora es obligatorio con `DATABASE_URL`),
- las credenciales SMTP también van por variables de entorno del dashboard (el `.env` local no sube).
