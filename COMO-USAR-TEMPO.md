# Cómo usar Tempo — referencia rápida

## Los dos scripts (doble-click en la carpeta `tempo`)

- **`deploy.command`** → sube **cambios de código / features** a la nube (hace `git push` y Render redeploya). Se usa cuando agregamos o arreglamos algo en la app.
- **`sync-nube.command`** → sube **tus datos** (comidas, pesajes, pádel…) a la nube. Se usa después de que cargo cosas por chat.

> Regla simple: **feature nueva → `deploy.command`. Dato nuevo → `sync-nube.command`.**

## Cómo cargar datos

1. Pedímelo **por chat**: "comí esto", "registrá el pesaje" (mandá la captura de la balanza), "jugué una hora de pádel".
2. Yo lo cargo en tu copia local.
3. Vos hacés doble-click en **`sync-nube.command`**.
4. Recargás la página y aparece.

> En el celular **mirá nomás, no cargues tocando los botones** — el próximo sync lo pisaría. Todo lo que quieras registrar, pedímelo por chat.

## En el celular

- Abrí **https://tempo-kqoo.onrender.com** en **Safari** → botón **Compartir** → **"Agregar a inicio"**. Queda como una app con ícono.
- Login: usuario **tempo** · contraseña **Tempo2026!**
- Si pasó un rato sin usarla, la primera carga tarda **~50 s** en "despertar". Después va fluido.

## Automatizaciones (ya activas)

- **Briefing diario · 8:10** — qué día de gym toca, cómo cerraste ayer, recordatorio de pesarte.
- **Recap semanal · domingos 20:06** — peso, adherencia, entrenos y ajustes para la semana.

> Corren mientras la app de Claude esté abierta. Podés probarlas con **"Run now"** en la sección **Scheduled**.

## Qué hay en cada pestaña (Fitness)

- **Resumen** — objetivo del día, bienestar (tabla), cómo cerrar el día, tu racha, aviso de partido.
- **Dieta / Plan** — ideas de comidas + día tipo según tu objetivo + lista de compras semanal.
- **Comidas** — registro con horarios.
- **Bienestar** — sueño, agua, meditación, cafeína, suplementos.
- **Cuerpo** — marcás zonas cargadas.
- **Peso** — pesajes + tendencia (se vuelve confiable con ~2 semanas de datos).
- **Gym** — plan **editable**, calentamiento, core/rotación para tenis, sobrecarga progresiva (te dice cuándo subir el peso), próximo partido.
- **Reportes** — peso/grasa/músculo, calorías/proteína, adherencia %, balance energético y composición corporal.
- **Perfil** — tus datos y objetivos.

## Mi tiempo (anti-workaholic)

Elegís energía y ganas → te da ideas para vos. Tiene balance semanal, un empuje a **bajo desgaste** cuando ya entrenaste, y un botón **"🎲 Sorprendeme"** para cuando no querés elegir.

---

## Conceptos clave (por si te confundís)

- **GitHub** guarda el código · **Render** corre la app · **Neon** guarda tus datos. Son tres cosas distintas.
- "Manual Deploy" en Render **no** sube mis cambios nuevos: solo redeploya lo que ya está en GitHub. Para subir lo nuevo, siempre **`deploy.command`**.
