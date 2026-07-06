#!/bin/bash
# Doble-click: PISA las comidas de hoy en la nube con las de tu estado local (corrige valores ya cargados).
# TIP: cerrá las pestañas de tempo en el navegador antes de correrlo.
# Después de "OK", abrí la web de nuevo y recargá (Cmd+Shift+R).
cd "$(dirname "$0")" || exit 1
echo "Pisando las comidas de hoy en la nube…"
npm install --silent 2>/dev/null
node pisar-comidas-hoy-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
