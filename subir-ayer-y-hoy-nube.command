#!/bin/bash
# Doble-click: sube a la nube las comidas de AYER y de HOY (merge, no duplica ni borra).
# TIP: cerrá las pestañas de tempo en el navegador antes de correrlo.
cd "$(dirname "$0")" || exit 1
HOY=$(date +%F)
AYER=$(date -v-1d +%F)
echo "Subiendo comidas de $AYER y $HOY a la nube…"
npm install --silent 2>/dev/null
node agregar-comidas-hoy-nube.mjs "$AYER"
node agregar-comidas-hoy-nube.mjs "$HOY"
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
