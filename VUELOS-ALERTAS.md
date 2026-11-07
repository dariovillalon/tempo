# Vuelos: chequeo diario y alertas

La pestaña **Vuelos** de Tempo muestra solo precios que alguien vio en la página de pago
del vendedor (aerolínea o agencia). Nadie más los busca: los valida una tarea programada de
Claude que corre en la Mac de Dario todos los días a las 9:00, con Chrome. Si la Mac está
apagada, ese día se saltea.

```
Tarea 9:00 (Mac) ──► node vuelos-tempo.mjs due ──► rutas que tocan hoy
      │
      ├─ por ruta: Google Flights ─► Opciones de reserva ─► página del vendedor (precio final)
      │
      └─► node vuelos-tempo.mjs report archivo.json ──► POST /api/flights/report (Render)
                │                                        ├─ guarda oferta + historial
                │                                        ├─ deja el mail pendiente si es "muy buena"
                │                                        └─ devuelve alertas ─► push al celular
                └─► GET /api/flights/mail-pending ─► Gmail SMTP desde la Mac
                    └─► POST /api/flights/mail-result (Tempo anota si salió)
```

Render gratis bloquea los puertos SMTP (25/465/587) desde el 26-sep-2025, por eso el mail lo
manda la Mac con `SMTP_USER`/`SMTP_PASS` del `.env`. Si algún día Render pasa a pago, en la
pestaña se puede cambiar "Quién manda el mail" a "El server".

| Pieza | Lee de | Escribe en | Para qué |
|---|---|---|---|
| Tarea programada `vuelos-alertas` | `/api/flights/due`, Chrome | archivo JSON temporal | validar precios en el navegador |
| `vuelos-tempo.mjs` | `.env` (TEMPO_PASSWORD, SMTP_*) | `/api/flights/report`, `/mail-result`, Gmail | subir lo validado y mandar los mails |
| `server.js` (sección Vuelos) | fila kv `flights` (Neon) | fila kv `flights` | guardar, historial, mails pendientes |
| `lib/smtp.mjs` | — | Gmail SMTP | cliente SMTP compartido (server y script) |
| `public/js/views/flights.js` | `/api/flights` | `/api/flights/watches`, `/settings` | ver ofertas y editar rutas |

## Qué es "muy buena"

Precio validado al menos `alertPct`% (15 por defecto) debajo del **piso** del rango normal que
muestra Google ("suelen valer entre USD X–Y"), o debajo del tope en USD de la ruta (`maxUsd`).
Un multidestino no tiene rango de Google: avisa solo si baja de su `maxUsd`. No se repite el aviso
salvo que baje 3% más o pase una semana, aunque el mail haya fallado (el push ya avisó).
Mail: lo manda `vuelos-tempo.mjs` desde la Mac al terminar el `report` (y reintenta durante una
semana los que no salieron). Un mail pendiente solo sale si la oferta sigue siendo "muy buena" a un
precio no más de 3% arriba del avisado; si no, se retira ("ya no es barato"). Una oferta va en un
solo mail aunque tenga varios avisos pendientes. Al pausar, los pendientes se retiran.
`data/vuelos-mails-enviados.json` (local) evita reenviar un mail si Tempo no llegó a anotarlo.
Push: lo manda la tarea con la herramienta PushNotification. "Pausar avisos" en la pestaña frena mail y push, no los chequeos.

## Protocolo de la tarea (seguirlo al pie de la letra)

1. Correr `node vuelos-tempo.mjs due` en esta carpeta. Si falla, mandar push "Chequeo de vuelos:
   no pude leer Tempo (<error>)" y terminar.
2. Tomar como máximo **4 rutas** de `due` (las que hace más que no se chequean primero). Los
   lunes, además, revalidar hasta **3 ofertas `multi`** de `due.multi` (las de `validatedAt` más
   viejo primero), con los mismos tramos y fechas, en la página de cada vendedor.
3. Por cada ruta (`origin`, `dest`, `window`, `nights`):
   - Abrir Google Flights con
     `https://www.google.com/travel/flights?q=Flights%20from%20<ORIG>%20to%20<DEST>%20on%20<IDA>%20through%20<VUELTA>&curr=USD&hl=es-419&gl=AR`
     usando una ida dentro de la ventana y `nights.min`–`nights.max` noches.
   - Usar **Gráfico de precios** o **Cuadrícula de fechas** para encontrar la ida más barata de la
     ventana con esa duración. Probar al menos dos meses distintos de la ventana.
   - Anotar el rango normal de la búsqueda: el texto "suelen valer entre USD X–Y" (botón
     "Ver historial de precios"). Ese es `normal.lo` / `normal.hi`.
   - Pestaña **Más económicos** (la vista "Recomendado" muestra precios más altos). Elegir ida y
     vuelta más baratas con `li.querySelector('[role=link]').click()` sobre el `li` visible que dice
     "ida y vuelta". Evitar "Boletos separados" salvo que sea la única opción (anotarlo).
   - En **Opciones de reserva** elegir el vendedor más barato que sea la aerolínea o Despegar
     (otras agencias poco conocidas solo si son las únicas). Clic en "Continuar" (usar `find`).
   - **Validar en la página del vendedor**:
     - Despegar: página de tarifa con "Precio final $X" (ARS). Convertir a USD con la relación
       ARS/USD que mostró Google para Despegar en la misma pantalla; marcar `approx: true`.
     - arajet.com: precio por tramo y "N ASIENTO(S) DISPONIBLE(S) A ESTE PRECIO". "Ver tarifas" →
       Basic "Seleccionar con restricciones" para ver la vuelta. Basic = solo artículo personal.
     - Otras aerolíneas: la pantalla de selección de tarifa con el total.
     - Si el vendedor bloquea la búsqueda automática (pasó con airfrance.us), probar una vez más y,
       si falla, pasar al siguiente vendedor; si no hay otro, anotar la ruta en `failures`.
   - Nunca loguearse, nunca cargar datos personales, nunca tocar pagar/confirmar. Rechazar cookies
     no esenciales. Cerrar todas las pestañas propias al terminar.
4. Armar el JSON y subirlo con `node vuelos-tempo.mjs report <archivo>`:

```json
{
  "runAt": "2026-11-07T09:00:00-03:00",
  "note": "4 rutas, 3 validadas, 1 sin validar",
  "checked": ["w_bue_puj", "w_bue_cun", "w_cor_cun", "w_bue_bcn"],
  "deals": [
    {
      "watchId": "w_bue_puj",
      "kind": "roundtrip",
      "title": "Punta Cana directo",
      "origin": "EZE", "dest": "PUJ",
      "legs": [
        { "from": "EZE", "to": "PUJ", "date": "2027-04-17", "times": "11:00–18:10", "airline": "Arajet", "flight": "DM6265", "stops": "Directo", "seller": "arajet.com", "priceUsd": 308.15 },
        { "from": "PUJ", "to": "EZE", "date": "2027-04-24", "times": "10:40–19:40", "airline": "Arajet", "flight": "DM6200", "stops": "Directo", "seller": "arajet.com", "priceUsd": 250.75 }
      ],
      "priceUsd": 558.90, "approx": false, "priceArs": null,
      "seller": "arajet.com", "fare": "Basic", "seatsLeft": "10 en la ida, 8 en la vuelta",
      "baggage": "Solo artículo personal",
      "normal": { "lo": 550, "hi": 700, "label": "Google: suelen valer entre USD 550–700" },
      "beach": true,
      "notes": ["Con carry-on (Comfort) la ida sube a USD 334,90."],
      "links": [{ "label": "Ver en Arajet", "url": "https://www.arajet.com/es-do/booking?origin=EZE&destination=PUJ&adt=1&chd=0&inf=0&from=2027-04-17&to=2027-04-24&currency=USD" }],
      "validated": true,
      "evidence": "arajet.com: ida DM6265 USD 308,15 (10 asientos), vuelta DM6200 USD 250,75 (8 asientos)",
      "validatedAt": "2026-11-07T09:12:00-03:00"
    }
  ],
  "failures": [{ "watchId": "w_bue_bcn", "reason": "Air France bloqueó la búsqueda dos veces" }]
}
```

   - `checked` lleva todas las rutas que se intentaron (validadas o no), así no se repiten mañana.
   - **Una sola oferta por `watchId`**: la más barata que validaste. Si mandás más, el server se
     queda con la más barata.
   - `priceUsd` (y los precios de los tramos) son **números JSON con punto decimal** (`558.9`), nunca
     strings ni coma. Fechas `AAAA-MM-DD`. Aeropuertos: código IATA de 3 letras, nunca el nombre.
   - Una oferta `multi` lleva `"kind": "multi"`, **sin** `watchId`, un `id` fijo en minúsculas con
     solo `a-z 0-9 _ -` (ej. `m_arajet_puj_mia`), todos los tramos y `priceUsd` = total. Copiá el
     `maxUsd` que trae `due.multi` para ese id (si no lo mandás, el server conserva el anterior).
5. Leer la respuesta:
   - Salida 3 = el server rechazó ofertas (`rejected`, con el motivo). Corregí esas ofertas y subilas
     en un archivo nuevo. Esas rutas no quedan como chequeadas hasta que llegue una válida.
   - `duplicate: true` = ese mismo archivo ya se había subido; no lo cuentes dos veces.
   - `macMail` dice cuántos mails salieron desde la Mac (`sent`), cuáles fallaron (`failed`) y
     cuáles se retiraron (`retired`). `emailed` habla solo del mail de esta corrida.
   - Si `alerts` no está vacío, mandar **un** push: "Vuelo barato: <título> USD <precio> (<fechas>).
     Detalle en Tempo › Vuelos." Si `emailed` es false, agregar "(el mail falló)".
   - Si la subida falló (salida 1), push con el error corto. Si no hay alertas, no mandar push.

## Mails a mano

- `node vuelos-tempo.mjs mail-pending`: reintenta los mails de alerta que no salieron.
- `node vuelos-tempo.mjs test-mail`: manda un mail de prueba desde la Mac al mail de la pestaña.

## Probar sin tocar la nube

Server local en otro puerto (sandbox, ver memoria de Tempo) y
`TEMPO_URL=http://localhost:7788 node vuelos-tempo.mjs report prueba.json`.
