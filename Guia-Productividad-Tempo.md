# Guía de bloques de tiempo + salud para Dario

> Una forma práctica de organizar tus días entre múltiples trabajos (Precocity, Betwarrior, Ewents, harbormind…) maximizando foco y energía, y usando tempo como cockpit central.
> Pensada para combinar bloques sin caer en multitasking, e integrar hábitos de salud que sostienen la productividad en vez de competir con ella.

---

## 1. Los 6 principios (en los que se apoya todo lo demás)

**1. Tu foco profundo es un recurso escaso: 3–4 h por día, no más.**
La gente no sostiene más de ~4 horas de trabajo cognitivo profundo de calidad por día. La meta no es "trabajar más horas", es proteger esas 3–4 horas y rodearlas del resto. Todo lo demás (mails, reuniones, revisar PRs, Slack) es trabajo superficial y va en otros bloques.

**2. El paralelo real es: la máquina hace N cosas, vos hacés 1.**
Cambiar de tarea cuesta ~23 minutos en volver a foco pleno, y el multitasking puede bajar la productividad hasta un 40%. Con varios trabajos esto es letal. La versión sana de "correr varias cosas en simultáneo" es: mientras corre un build, una query de Snowflake, un pipeline o un agente para un job, **vos hacés foco en un solo job**. Paralelizás el trabajo de las máquinas, no tu atención.

**3. Trabajá en bloques de ~90 minutos (ritmo ultradiano).**
El cerebro cicla en ondas de energía de 90–120 min. Empujar más allá sin descanso degrada la precisión. Estructura: bloque de 90 min de foco → 15–20 min de recuperación real (lejos de la pantalla). Dentro del bloque podés usar pomodoros (25/5) como sub-ritmo.

**4. Límite duro de trabajo en curso: máximo 3 cosas activas.**
Regla de *Four Thousand Weeks*: no permitas más de 3 ítems "en curso" a la vez. Nada nuevo entra hasta que uno se termina y libera un slot. Con muchos proyectos esto es lo que evita que tengas 15 cosas al 60% y nada cerrado.

**5. Agrupá lo similar (batching) y separá los trabajos por bloques del día.**
En vez de intercalar Precocity / Betwarrior / Ewents minuto a minuto, asigná **franjas del día a cada empresa** (day-parting). Y juntá todo lo superficial parecido (todos los mails, todos los Slack, todos los PRs) en uno o dos bloques, en vez de espolvorearlo.

**6. El cuerpo es el motor del foco — no es tiempo "perdido".**
Luz matinal, desayuno con proteína, movimiento cada 30 min, una pausa de descanso profundo (NSDR) y dormir bien no son lujos: son lo que hace posible que tus 3–4 horas de foco existan. Saltearlos te cuesta horas de foco después.

---

## 2. La estrategia para tus múltiples trabajos

La idea central: **dividí el día en franjas por empresa**, no por tipo de tarea suelta.

- Asigná a cada trabajo un bloque de foco de 90 min (o dos si ese día pesa más).
- Dentro de la franja de una empresa, hacés su trabajo profundo **primero** y dejás sus mails/Slack/PRs para un bloque superficial al final de la franja.
- Lo que es esperar (CI, queries largas, deploys, un agente trabajando) lo lanzás **al principio** de la franja y mientras corre hacés foco en *esa misma* empresa, no en otra. Así no te partís.
- harbormind (lo tuyo) merece su propio bloque protegido, idealmente en tu mejor ventana de energía, porque es lo que más fácil se come el resto si no lo blindás.

Y el problema de las licencias de IA distintas por empresa se resuelve así: usás la IA de cada empresa solo para generar un **micro-resumen de 3 líneas** al cerrar su franja (qué hice / qué decidí / qué sigue + bloqueos), con el mismo prompt siempre, y lo pegás en tempo. Documentás una sola vez, en tempo (que es tuyo y cruza todos los trabajos), y el viernes tempo te arma el reporte por empresa.

---

## 3. Tu día tipo (plantilla de bloques combinados)

Pensado sobre tu ventana actual en tempo (día de 7:00 a 22:00). Ajustá las empresas según el peso de cada día; lo que importa es la **estructura**, no los nombres exactos.

| Hora | Bloque | Qué hacés | Por qué |
|------|--------|-----------|---------|
| 7:00–7:20 | ☀️ Arranque | Luz natural afuera/ventana 5–10 min + agua. Sin pantallas de trabajo todavía. | La luz matinal dispara el pico de cortisol que te despierta y ordena tu sueño esa noche. |
| 7:20–7:40 | 🍳 Desayuno | Desayuno con 20–30 g de proteína (huevos, yogur griego, etc.). | Glucosa estable = foco sostenido sin bajón a media mañana. |
| 7:40–7:55 | 🧘 Meditación | 10 min de meditación/respiración + intención del día. | 10 min/día mejoran atención de forma medible. Setea la calma del día. |
| 7:55–8:10 | 📋 Plan en tempo | Abrís tempo "Hoy": mirás los 4 calendarios mergeados, bajás 3 tareas al plan, asignás franjas por empresa. | Es el "mapa". Sin esto el día te maneja a vos. |
| 8:15–9:45 | 🧠 **Foco profundo #1** (tu mejor empresa/tarea) | El trabajo más difícil y de mayor valor del día. Pomodoro tageado a la tarea. Sin Slack ni mail. | Tu pico cognitivo es a la mañana: gastalo en lo que más rinde, no en mails. |
| 9:45–10:05 | 🚶 Recuperación | Caminar, estirar, lejos de la pantalla. Nada de scroll. | Cierra el ciclo ultradiano y recarga para el próximo bloque. |
| 10:05–11:35 | 🧠 **Foco profundo #2** (otra empresa) | Segundo bloque profundo, otro job. Lanzás lo async al inicio. | Segundo y último gran bloque de foco del día. |
| 11:35–11:50 | 🚶 Movimiento | Pausa activa. | Recuperación + cortar sedentarismo. |
| 11:50–12:30 | 📨 **Bloque superficial #1** | Todos los mails + Slack + PRs de la mañana, juntos. Reuniones cortas. | Batching: juntar lo superficial evita el goteo de interrupciones. |
| 12:30–13:30 | 🍽️ Almuerzo + corte real | Comer sin pantalla de trabajo. | Recuperación de verdad sostiene la tarde. |
| 13:30–13:50 | 😴 NSDR / siesta corta | 10–20 min de NSDR (yoga nidra/guiado) o siesta breve. | Repone dopamina y baja cortisol sin arruinar el sueño nocturno. La mejor herramienta para recuperar energía a media tarde. |
| 13:55–15:25 | 🧠 **Foco moderado** (tercera empresa / harbormind) | Bloque de trabajo, algo menos exigente que la mañana. | La tarde rinde menos para lo más duro; ideal para implementación, no diseño. |
| 15:25–15:40 | 🚶 Movimiento | Pausa activa. | — |
| 15:40–16:40 | 🛠️ Trabajo "combinado" | Tareas superficiales agrupadas + supervisar lo async (CI, queries, deploys, agentes). | Acá sí "varias cosas a la vez" funciona: son tareas livianas + monitorear máquinas. |
| 16:40–17:10 | 📨 **Bloque superficial #2** | Segunda y última pasada de mail/Slack. | Concentrar la comunicación en 2 ventanas, no todo el día. |
| 17:10–17:30 | ✅ Shutdown ritual | Cerrás cada franja con su micro-resumen de IA pegado en tempo, revisás el board, marcás follow-ups, planeás mañana. Decís "listo por hoy". | El ritual de cierre (Newport) te saca el trabajo de la cabeza y deja todo documentado. |
| Noche | 📖 Lectura + descanso | 20–30 min de lectura (no pantalla idealmente), luz baja, sin trabajo. | Lectura como hábito + higiene de sueño = el foco de mañana. |

**Microhábito transversal todo el día:** moverte ~2–3 min cada 30 min de estar sentado (parate, caminá, estirá). Romper el sedentarismo cada media hora reduce riesgos de salud y mejora la atención y función ejecutiva en el bloque siguiente.

> Notá que esto da **~4.5 h de foco profundo/moderado** repartidas en bloques, comunicación contenida en 2 ventanas, y salud integrada sin robarle tiempo al trabajo. No hace falta seguirlo al pie de la letra: usalo como esqueleto y movélo según reuniones reales.

---

## 4. Cómo combinar bloques sin que sea multitasking dañino

"Combinar" bien = juntar cosas que **no compiten por la misma atención**. Tres combinaciones que sí funcionan:

1. **Foreground + background:** una tarea de foco tuya + una tarea de máquina corriendo sola (build, query, pipeline, agente). Vos atendés una; la otra avanza sin vos.
2. **Batch de tareas superficiales similares:** todos los mails juntos, todos los PRs juntos, todos los Slack juntos. Son del mismo "modo mental", así que cambiar entre ellas cuesta poco.
3. **Deep + su shallow asociado:** un bloque profundo en un proyecto, y al final del mismo bloque, los mails/mensajes *de ese mismo proyecto*. Mismo contexto, cero salto.

Lo que **no** combines nunca: dos tareas de foco profundo de **dos empresas distintas** al mismo tiempo. Eso no es paralelo, es partir tu atención en dos y hacer ambas peor.

---

## 5. Cómo ejecutar todo esto en tempo

Tempo ya tiene casi todo lo necesario; el truco es mapear cada pieza:

- **Calendario:** creás los bloques del día arrastrando sobre la grilla, con color por empresa. Tus 4 calendarios de Google ya están conectados, así que ves reuniones reales y bloques en una sola vista.
- **Hoy:** tu pantalla de planificación de la mañana (los 5–10 min de plan).
- **Pomodoro tageado a la tarea:** tu cronómetro de los bloques de 90 min (3–4 pomodoros por bloque). Te fuerza a single-tasking.
- **Board (kanban):** aplicá el límite de **3 tareas en "En curso"** como regla. Si querés meter una cuarta, primero cerrás una.
- **Comentarios de tarea:** donde pegás el micro-resumen que te genera la IA de cada empresa al cerrar su franja.
- **Status report (viernes):** generás el reporte por proyecto de la semana y lo pegás en el Slack/standup de cada cliente. Documentás una vez, reportás a todos.
- **Notas / vault:** esta misma guía vive ahí como referencia.

---

## 6. Tabla de hábitos de salud (qué, cuándo, dosis mínima)

| Hábito | Cuándo | Dosis mínima que sirve | Para qué |
|--------|--------|------------------------|----------|
| Luz natural | Primeros 30–60 min del día | 5–10 min (nublado: más) | Despertar, energía, dormir mejor de noche |
| Desayuno proteico | Al levantarte | 20–30 g de proteína | Foco sostenido, sin bajón de media mañana |
| Meditación | Antes de arrancar a trabajar | 10 min (incluso 2–5 ya ayuda) | Atención, menos estrés |
| Movimiento postural | Cada 30 min sentado | 2–3 min de pararte/caminar/estirar | Salud, menos dolor, mejor atención después |
| NSDR / siesta | Media tarde (~13:30) | 10–20 min | Repone energía sin arruinar el sueño |
| Lectura | Noche | 20–30 min | Hábito, descanso de pantallas |
| Sueño | Misma hora cada noche | Tu objetivo personal de horas | Es el multiplicador de todo lo demás |

---

## 7. Reglas de oro (la versión de bolsillo)

1. Protegé 3–4 h de foco profundo por día. Lo demás se acomoda alrededor.
2. Un solo job en foco por bloque. La máquina paraleliza; vos no.
3. Bloques de ~90 min, descanso real de 15–20 después.
4. Máximo 3 tareas "en curso" a la vez.
5. Mail y Slack en 2 ventanas del día, no todo el día.
6. Cerrá cada franja con un micro-resumen pegado en tempo (mismo prompt en todas las empresas).
7. Movete cada 30 min. Comé proteína a la mañana. Dormí parejo. Eso *es* productividad.
8. Shutdown ritual al final: documentá, planeá mañana, y soltá el trabajo.

---

*Nota: esto son prácticas generales de productividad y bienestar basadas en evidencia divulgada, no consejo médico. Si tenés alguna condición de salud, ajustá con un profesional. Probá el esqueleto una o dos semanas y quedate con lo que te funcione; no hace falta adoptarlo todo de una.*

## Fuentes

- [Cal Newport — Deep Habits: Planning Every Minute of Your Work Day](https://calnewport.com/deep-habits-the-importance-of-planning-every-minute-of-your-work-day/)
- [Cal Newport — Time Block Planner](https://www.timeblockplanner.com/)
- [Akiflow — Cal Newport's Deep Work & Time Blocking](https://akiflow.com/blog/cal-newports-deep-work-explained)
- [PubMed — Ultradian rhythms in task performance, self-evaluation and EEG activity](https://pubmed.ncbi.nlm.nih.gov/7870505/)
- [Asian Efficiency — Ultradian Rhythms: the 90-minute productivity cycle](https://www.asianefficiency.com/productivity/ultradian-rhythms/)
- [The Cost of Context Switching: 23 min, 6 studies (Gloria Mark, UC Irvine)](https://www.rock.so/blog/cost-of-context-switching)
- [Four Thousand Weeks — Oliver Burkeman (resumen de principios)](https://sajithpai.com/book-summary-four-thousand-weeks-by-oliver-burkeman/)
- [Huberman Lab — Non-Sleep Deep Rest (NSDR)](https://www.hubermanlab.com/nsdr)
- [Hone Health — Andrew Huberman's daily routine: morning sun, NSDR](https://honehealth.com/edge/andrew-huberman-daily-routine/)
- [Sunnybrook — Movement breaks reduce risks of prolonged sitting](https://health.sunnybrook.ca/how-movement-breaks-can-reduce-the-health-risks-of-prolonged-sitting/)
- [Springer / BMC — Breaking up prolonged sitting and cognitive function](https://link.springer.com/article/10.1186/s12891-021-04136-5)
- [PMC — Brief mindfulness meditation improves attention in novices](https://pmc.ncbi.nlm.nih.gov/articles/PMC6088366/)
- [Scripps — Benefits of a high-protein breakfast](https://scrippsamg.com/benefits-of-high-protein-breakfast/)
