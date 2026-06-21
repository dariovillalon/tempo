# Subir Tempo a la web — GRATIS (Render + Neon)

- **Neon** = base de datos Postgres gratis y permanente (tus datos no se borran).
- **Render** = hostea la app gratis (se "duerme" tras 15 min sin uso; la primera vez que entrás tarda ~30–60 s en despertar, después va normal).
- El código ya está listo: con `DATABASE_URL` usa Postgres; sin esa variable, tu versión local sigue igual.

---

## 1) Neon — crear la base de datos
1. Entrá a https://neon.com → **Sign up** (con GitHub, gratis, sin tarjeta).
2. **Create project** (nombre: tempo). Te crea una base automáticamente.
3. En el dashboard, **Connect** / "Connection string": copiá la URL. Se ve así:
   `postgresql://usuario:clave@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require`
   👉 Guardá esa URL, la vas a usar dos veces.

## 2) Subir tus datos actuales a Neon (una vez, desde tu compu)
En la carpeta de `tempo`, en la Terminal:
```
npm install
DATABASE_URL="LA-URL-DE-NEON" npm run migrate
```
Tiene que decir "✅ Listo. Tus datos ya están en Postgres."

## 3) GitHub — poner Tempo en un repo
En la carpeta de `tempo`:
```
git init
git add .
git commit -m "Tempo"
```
Creá un repo **privado** en https://github.com/new (sin README), y después:
```
git remote add origin https://github.com/TU-USUARIO/tempo.git
git branch -M main
git push -u origin main
```
(El `.gitignore` ya evita subir tus datos y tu `start.command` con contraseñas.)

## 4) Render — hostear la app
1. Entrá a https://render.com → **Sign up** con GitHub (gratis).
2. **New + → Web Service →** conectá el repo `tempo`.
3. Configuración (Render suele autodetectar):
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. En **Environment / Environment Variables**, agregá:
   - `DATABASE_URL` = la URL de Neon (la misma del paso 1)
   - `TEMPO_PASSWORD` = la contraseña que quieras para entrar
5. **Create Web Service**. Render compila y deploya. Te da una URL: `https://tempo-xxxx.onrender.com`.

## 5) Usarlo
Abrí esa URL en el celular → usuario **tempo** + tu contraseña.
La primera vez tras un rato sin uso tarda ~30–60 s en despertar; después va fluido. Tus datos viven en Neon (permanente).

---

### Notas
- **Costo:** $0. Neon free es permanente; Render free duerme la app (solo afecta el primer acceso).
- **Sin lock-in:** es una app Node + Postgres estándar. Si algún día querés moverla (Railway, otro host), se hace en minutos y los datos se exportan con un comando.
- **Obsidian:** el explorador del vault no anda en la nube (son archivos locales). Como tu vault está en GitHub, más adelante podemos hacer que la nube lo lea desde ahí.
- **Local:** sin `DATABASE_URL`, todo sigue funcionando con `data/*.json` como hasta ahora.
