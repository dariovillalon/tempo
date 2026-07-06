# Revisión completa de Tempo — 4 de julio 2026

Revisión de todo el proyecto: backend (`server.js`, ~2.300 líneas), scripts de sync (`.mjs` / `.command`), frontend core (`state`, `api`, `router`, componentes) y las 14 vistas (~16.000 líneas en total). Verifiqué los hallazgos principales contra el código real.

---

## Lo que está muy bien

**Seguridad de datos local.** El guardado de `state.json` usa escritura atómica (archivo temporal + rename, `server.js:119-127`), así un corte de luz a mitad de guardado no te corrompe el estado. Además hay backups automáticos cada 60 segundos con rotación de 20 copias.

**Protección XSS consistente.** Hay 265 usos de `escapeHtml()` en todo el frontend, aplicado de forma consistente antes de cada `innerHTML` con datos del usuario. Para una app sin framework, esto está mejor que muchos proyectos profesionales.

**Sin inyección SQL.** Todas las queries a Postgres usan parámetros (`$1, $2`), nunca concatenación.

**Protección contra path traversal.** El acceso al vault de Obsidian valida en dos capas que las rutas no se escapen de la carpeta (`server.js:575-579` y `1540-1548`). Alguien no podría pedirle al server `../../etc/passwd`.

**El módulo fitness está bien pensado.** Los cálculos de BMR + actividad + superávit son correctos, la meta de agua escala con el ejercicio, el "cerrar el día" sugiere opciones proteicas según lo que falta, y la detección de nutrientes faltantes por keywords es ingeniosa.

**UX cuidada.** Guardado con debounce (350ms) + indicador de estado visible, foco automático en modales, prevención de ciclos en la jerarquía de proyectos, persistencia del scroll al re-renderizar.

**Buen manejo de secretos en git.** El `.gitignore` excluye `data/` y `start.command` — los secretos no van al repo.

---

## Lo más importante a mejorar (prioridad alta)

### 1. Contraseñas en texto plano en `start.command` (líneas 27-38)
El App Password de Gmail y `TEMPO_PASSWORD` están hardcodeados. Está gitignoreado (bien), pero cualquier proceso o persona con acceso a la carpeta los ve.
**Fix:** movelos a un archivo `.env` (también gitignoreado) y cargalos desde ahí. Y si alguna vez ese archivo se compartió o subió por error, revocá el App Password desde tu cuenta de Google y generá otro.

### 2. Bug de timezone en las horas de comidas (`fitness.js:162-170`)
Al editar la hora de una comida hace `new Date(date + 'T00:00:00')` + `setHours()` en hora local. Las comidas cerca de medianoche pueden caer en el día equivocado, y si alguna vez usás la app desde otro huso horario los horarios se corren. Es exactamente el tipo de dato que te importa (comés seguido cerca de medianoche 🍖).
**Fix:** parsear y mostrar siempre con el mismo criterio (local con offset explícito, o todo UTC).

### 3. `javascript:` URLs en Bills (`bills.js:77`)
El link de pago hace `href="${escapeHtml(b.url)}"`. `escapeHtml` no valida el esquema: una URL `javascript:...` ejecutaría código al clickearla.
**Fix:** validar `/^https?:\/\//.test(b.url)` antes de renderizar el link.

### 4. Condición de carrera: dos pestañas/dispositivos pueden pisarse
El modelo es "leer todo el blob → modificar → escribir todo". Si tenés la web abierta en el teléfono y la compu (o corrés un script `.mjs` mientras la web está abierta), el último que guarda pisa al otro **silenciosamente** (`server.js:99-127`, `app.js:210-218`). Por eso el tip de "cerrá las pestañas antes de correr el script" — pero eso es un workaround, no una solución.
**Fix:** agregar un campo `version` al state y rechazar escrituras con versión vieja (optimistic locking), o al menos que los scripts `.mjs` usen `SELECT ... FOR UPDATE` dentro de una transacción.

### 5. Los datos en la nube no tienen backup
Los backups automáticos solo corren en local. Si Neon se corrompe o borrás el proyecto, no hay recuperación del lado de la app.
**Fix rápido:** un script `descargar-nube.command` que baje el state de Neon a un JSON local con fecha. Diez líneas y dormís tranquilo.

---

## Mejoras de prioridad media

- **Auth básica sobre HTTP + CORS abierto a `*`** (`server.js:2221, 2230-2235`): en Render va sobre HTTPS así que no es grave, pero convendría restringir CORS al dominio propio y exigir `TEMPO_PASSWORD` obligatorio cuando hay `DATABASE_URL`.
- **Errores silenciosos**: varios `catch {}` vacíos (`quickCapture.js:287`, vault sync en `state.js:703`). Si algo falla, no te enterás salvo por la consola. Un toast de error alcanzaría.
- **Sin reintentos al fallar el guardado**: si un `PUT /api/state` falla, queda el indicador rojo pero no reintenta ni ofrece botón de retry (`state.js:243-249`).
- **Cerrar la pestaña con guardado en vuelo puede perder el último cambio**: falta un handler `beforeunload` o `sendBeacon`.
- **Alertas BTC**: si el precio oscila alrededor del umbral, puede spamear emails (el cooldown se resetea); y si el SMTP falla repetidamente sigue intentando cada 10 min sin backoff (`server.js:1371-1395, 2295-2300`).
- **Fetch de calendarios ICS sin timeout** (`server.js:1378-1388`): un servidor colgado bloquea la request indefinidamente.
- **Sin validación de rangos**: el pesaje acepta 0 o 9999 kg; las comidas aceptan kcal negativas (`fitness.js:1394`).
- **Lógica de rachas (streaks) duplicada 3 veces** en `fitness.js`, `dashboard.js` y `today.js` — candidata a `utils.js`.
- **`f.foodLibrary.map()` sin null-check** en `fitness.js:846` (en otra línea sí lo tiene) — si la biblioteca viene vacía, rompe la vista.

## Detalles menores (baja)

- `fitness.js` tiene 1.548 líneas y funciones de 60+ líneas (`bodyGym()`): funciona, pero cada cambio se vuelve más riesgoso. Partirlo en módulos (comidas / gym / pesaje / charts).
- El hint de atajos menciona "⌘Z deshacer" pero el undo no está implementado (`app.js:184`).
- Comidas agregadas a días pasados comparten el mismo timestamp (mediodía fijo).
- Los charts SVG no tienen `aria-label` (accesibilidad).
- Re-render completo de la vista en cada cambio de estado: aceptable hoy, se sentirá con 200+ items.
- `window.__pendingVaultPath` como canal global entre quickCapture y notes: frágil, mejor query param del router.

---

## Veredicto

Para un proyecto personal hecho sin framework, está **notablemente bien**: seguridad XSS/SQL sólida, escrituras atómicas, backups locales, y un dominio (fitness) modelado con criterio real. Los riesgos que sí atacaría ya, en orden: **(1)** secretos a `.env` + rotar el App Password, **(2)** el bug de timezone en comidas, **(3)** validar URLs en Bills, **(4)** el locking del state para que dos dispositivos no se pisen, **(5)** backup de la nube. Con esos cinco, el resto es pulido incremental.
