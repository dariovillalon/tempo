# Handoff context (para continuar en Claude Code)

Fecha: 2026-06-24. Dos hilos de trabajo: (A) cambios en la app **tempo** (ya hechos), (B) investigación Harbormind / próximo trabajo de **vertexes** (pendiente).

---

## A) App tempo — cambios YA implementados

App local-first (Node `server.js`, sin build; ES modules servidos desde `public/`). Persistencia: `data/state.json` local, o Postgres/Neon si hay `DATABASE_URL`.

### 1. Cargar pesaje desde foto (OCR) — pestaña Peso
Archivo: `public/js/views/fitness.js`
- `ensureTesseract()` carga Tesseract.js desde `https://cdn.jsdelivr.net/npm/tesseract.js@5` on-demand (gratis, corre en el navegador; necesita internet la 1ª vez).
- `parseZepp(text)` parsea la captura de Zepp Life → `{kg, bodyFatPct, muscleKg, bodyWaterPct, proteinPct, boneKg, visceralFat, bmr, bmi, date}`. Probado contra la captura real: extrae los 10 campos OK.
- Form en `bodyPeso()`: botón "📷 Cargar desde captura", inputs visibles + fila extra (agua, proteína, ósea, visceral, bmr, imc), status `#fit-w-ocr-status`.
- Handler `#fit-w-photo` corre OCR → prefiltra el form. `weighFromPhoto` marca la entrada con `source: 'Zepp Life'`. Save handler mergea todos los campos opcionales.

### 2. Auto-hora editable en fitness
Archivo: `public/js/views/fitness.js`
- La hora se sigue autocargando al crear (café/actividad/comida) pero ahora es **editable** con `<input type="time">` inline.
- Funciones nuevas: `editCaffeineTime`, `editActivityTime`, `editMealTime` (esta recalcula `meal.ts` desde fecha+hora).
- Renders con `data-caftime` / `data-acttime` / `data-mealtime` + handlers en bindEvents.
- CSS `.fit-time-edit` en `public/css/styles.css`.
- NOTA: sólo fitness. MiTiempo y Calendario NO tienen auto-hora (decisión del usuario). Pendiente si lo quiere después.

### 3. Pomodoro flotante en Agenda (sin cambiar de página)
- `public/js/views/pomodoro.js`: `mountFloatingMini()` + `updateFloatingMini()` (widget fijo abajo-derecha con tiempo, pausa, saltar, expandir ⤢, cerrar). Se monta en `startGlobalTicker()` y se actualiza desde `updateMiniDisplay()`. El botón ⤢ dispara el click del `#pom-mini` de la topbar (evita import circular del router).
- `public/js/views/calendar.js`: se quitó `router.go('pomodoro')` del handler `[data-pomo]` → el pomodoro arranca y Dario se queda en la Agenda.
- CSS `.pom-float*` en `public/css/styles.css`.

### 4. Biblioteca de comidas curada (en CÓDIGO)
Archivo: `public/js/state.js`
- `defaultFoodLibrary()` reemplazada por la lista curada de Dario (solo lo que come seguido), en 2 grupos: **Desayuno / Merienda** (12) y **Almuerzo / Cena** (12, incluye "Tarta de pollo, huevo y verduras (1 porción)" y "ChocoArroz alfajor limón (1u)").
- Migración one-shot: `FOOD_LIBRARY_VERSION = 2`. En `initState`, si `state.fitness.foodLibraryVersion !== 2` se reemplaza la biblioteca vieja (genérica) por la nueva y se setea la versión. Corre una sola vez por estado. OJO: pisa cualquier "Alimento propio" agregado antes (en web no había ninguno).
- Por qué en código y no en datos: la web corre Neon; un write directo a la DB es frágil (la pestaña abierta lo pisa). Con la migración, se autoaplica en la próxima carga después del deploy.

### 5. Datos
- `data/state.json` (local): agregado pesaje 2026-06-24 (71.45 kg) + comida tarta de pollo. (No crítico para el deploy; es data local.)

### Deploy / cómo ver los cambios
- Local: recargar la página (archivos estáticos servidos en vivo).
- Web (Render): requiere `git push` + redeploy. El `sync-nube.command` **NO** sube código, sólo `data/state.json` a Neon.
- Verificado: `node --check` OK en fitness.js, pomodoro.js, calendar.js.

---

## B) Harbormind — próximo trabajo: VERTEXES (pendiente)

### Los 4 PRs de Eddie (todos MERGED a `dev`, 23/06)
1. `SaaS-frontend#717` — Add Azure Cosmos resource configuration UI (Key Vault URI, colecciones anidadas).
2. `data-scanner#630` — Add Azure public compute metadata collectors: **Container Apps, AKS, API Management** (sólo metadata cruda).
3. `SaaS-backend#918` — Gate Azure datastore activation on scanner validation (SQL + Cosmos quedan `discovered` hasta validar acceso).
4. `data-scanner#631` — Add Azure SQL scanner access validation (creds vía Key Vault, DSN seguro).

### Qué falta para los vertexes (esto es lo de Dario)
Los recursos del PR #630 entran como **metadata cruda**. Para que aparezcan en el grafo:
- Grafo definido en `harbormind-contracts/python/hm_contracts/graph_spec.py`: 9 vertex types (Principal, Agent, Endpoint, **Compute**, Role, Data, Secret, Model, Network), 7 edge types, y un **mapeo resource_type → vertex_type**.
- Construcción: `vertex_factory.py` (HM ID format `hm:{cloud}:{account}:{service}:{region}:{type}:{name}`) + `unified-relationship-builder/app.py` (patrón deferred-edge).
- TAREA: mapear los nuevos resource_types Azure → vertex types (probable: AKS + Container Apps → **Compute**, API Management → **Endpoint**) y definir sus edges.
- A CONFIRMAR (no pude leer el repo desde la sesión): los strings exactos de `resource_type` que emiten los collectors (por patrón tipo `azure_blob_container`, serían algo como `azure_container_app`, `azure_managed_cluster`, `azure_api_management`) y si `graph_spec.py` ya los tiene mapeados.
- Contexto: NO hay issue de Linear asignado a Dario ahora mismo; los "Graph to Spec" existentes (HM-364/365/366) son AWS-only. Probable que sea trabajo net-new → abrir ticket + PR.

### Otros pendientes / contexto
- **IAM**: Eddie debe los collectors de IAM (Azure); wire después de eso.
- **Validación**: activación de datastore pasa cuando las creds van al Azure Key Vault + la URI se carga en la config de la integración.
- **is_public** (de antes): infra PR `SaaS-infrastructure#583` (grantReadData → grantReadWriteData del check-executor sobre resource-metadata) — fix del AccessDenied en el write step.
- **Slack**: grupo DM `C0BC84T9T47` (Eddie, Dario, Matias). Hay un borrador de respuesta listo (no enviado) confirmando que Dario toma el wiring del grafo.

### Primeros pasos sugeridos en Claude Code
1. Abrir `harbormind-contracts` → leer `python/hm_contracts/graph_spec.py` (mapeo resource_type→vertex_type + relationships válidas).
2. En `data-scanner` confirmar los `resource_type` exactos de `container_app_collector.py`, `kubernetes_managed_cluster_collector.py`, `api_management_collector.py`.
3. Agregar el mapeo faltante en graph_spec + edges; revisar `vertex_factory.py` y el relationship-builder.
4. Abrir ticket en Linear (HarborMind) + PR.
