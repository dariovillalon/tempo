# Tempo

Tu dashboard local-first para organizar proyectos, trackear tiempo, manejar tareas y pensar en pizarras. Todo guardado en tu disco. Cero dependencias externas.

## ¿Qué tiene?

- **Hoy** — saludo, métricas del día (tracked, pomodoros, tareas en curso, racha), plan de hoy, bloques del día, alertas de proyectos en riesgo, mini-chart de la semana.
- **Dashboard** — portfolio de proyectos con progreso, salud y descripción; chart de tiempo de los últimos 7 días con distribución por proyecto; feed de actividad reciente.
- **Calendario** — vista semanal con drag-to-create. Hacé click y arrastrá sobre la grilla para crear bloques. Color por proyecto.
- **Board** — kanban de 5 columnas (Inbox, Por hacer, En curso, Esperando, Hecho), filtros por proyecto y prioridad, drag-and-drop. Indica vencidas.
- **Pizarra** — múltiples pizarras con post-its arrastrables, 6 colores, edición inline. Doble-click para crear, click derecho para cambiar color.
- **Pomodoro** — timer circular con presets (foco/break/largo), historial visual de los últimos 7 días, asociar pomodoros a una tarea, notificaciones.
- **Notas** — dos pestañas: notas **locales** (guardadas por Tempo en `data/notes/`, asociables a un proyecto, editor markdown inline con autosave) y, si conectaste un vault, exploración de **Obsidian** con edición y preview. Las notas locales no necesitan Obsidian.
- **Ajustes** — nombre, tema (oscuro/claro), día y meta semanal, parámetros de pomodoro, conectar/desconectar vault, exportar/importar JSON con todo el estado y notas.
- **Detalle de proyecto** — página por proyecto: progreso, tiempo trackeado, pomodoros, chart de los últimos 14 días, tareas agrupadas por estado, actividad.
- **Captura rápida (⌘K)** — palette tipo Linear: tipeá una tarea para crearla, o `/board`, `/hoy`, `/calendar`, etc.

## Cómo empezar

Necesitás Node.js 18 o superior. Bajalo de [nodejs.org](https://nodejs.org) si no lo tenés.

### Mac

Doble-click sobre `start.command`. Se abre tu navegador en `http://localhost:7777`.

### Cualquier OS

```bash
node server.js
```

Abrí `http://localhost:7777`.

### Conectar Obsidian

1. Click en "Notas" en la barra lateral.
2. Click en "Conectar carpeta".
3. Tempo busca vaults en lugares conocidos (`~/Documents`, `~/Obsidian`, iCloud, etc.). Elegí uno o pegá la ruta a mano.
4. Listo: ya podés explorar tus notas con preview markdown.

## ¿Dónde se guardan los datos?

Todo en `./data/` dentro de la carpeta de Tempo:

- `data/state.json` — proyectos, tareas, bloques, pomodoros, pizarras, actividad
- `data/config.json` — ruta del vault de Obsidian
- `data/notes/` — una nota local por archivo `<id>.md` con frontmatter (título, proyecto, timestamps)
- `data/backups/` — snapshots automáticos de los últimos 20 estados (cada 60s)

Estos archivos están en `.gitignore` por defecto. Tu data nunca se sube a ningún lado.

## Atajos

| Atajo | Acción |
|-------|--------|
| `⌘K` / `Ctrl+K` | Búsqueda global (tareas, notas, proyectos, comandos) |
| `/` | Captura rápida |
| `g` + `t/d/c/b/p/n/w/s` | Navegar entre vistas (Hoy, Dashboard, Calendar, Board, Pomodoro, Notas, Pizarra, Ajustes) |
| `n` | Nueva tarea |
| `?` | Cheatsheet de atajos |
| `Esc` | Cerrar modal |
| Click + arrastre en calendario | Crear bloque |
| Drag tarea entre columnas | Cambiar estado |
| Doble-click en pizarra | Crear nota |
| Click derecho en post-it | Cambiar color |

## Comandos del package.json

```bash
npm start    # node server.js
npm run dev  # node --watch server.js (recarga al editar)
```

## Variables de entorno

- `TEMPO_PORT` — puerto del servidor (default: 7777)

```bash
TEMPO_PORT=8080 node server.js
```

## CLI

Pasá una ruta de vault al iniciar:

```bash
node server.js /Users/tu-user/Obsidian
```

## Estructura del proyecto

```
tempo/
├── server.js            # Servidor Node sin dependencias
├── package.json
├── start.command        # Launcher para Mac
├── public/
│   ├── index.html       # Shell
│   ├── css/styles.css
│   └── js/
│       ├── app.js       # Bootstrap
│       ├── api.js       # Wrapper REST
│       ├── state.js     # Single source of truth
│       ├── router.js
│       ├── utils.js
│       ├── icons.js
│       ├── components/  # Modales, toast, quick capture
│       └── views/       # today, dashboard, calendar, board, whiteboard, pomodoro, notes, project
└── data/                # Tu data (no se commitea)
```

## Stack

- Node.js >= 18, módulos built-in solamente
- ES Modules (`type: "module"`)
- HTML/CSS/JS vanilla, sin build step
- Inter + JetBrains Mono via Google Fonts
- marked.js via CDN para render de markdown

## Licencia

MIT — usá esto como quieras.
