#!/bin/bash
# Doble-click: sube SOLO el pesaje de hoy y las reuniones de hoy a la nube (no toca nada más).
# TIP: cerrá las pestañas de tempo en el navegador antes de correrlo.
# Después de "OK", abrí la web de nuevo y recargá (Cmd+Shift+R).
cd "$(dirname "$0")" || exit 1
echo "Subiendo pesaje y reuniones de hoy a la nube…"
npm install --silent 2>/dev/null
node sync-pesaje-agenda-hoy-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
