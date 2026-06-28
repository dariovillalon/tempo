#!/bin/bash
# Doble-click: agrega/actualiza SOLO las comidas de hoy en la nube (no borra nada más).
# TIP: cerrá las pestañas de tempo en el navegador antes de correrlo.
cd "$(dirname "$0")" || exit 1
echo "Agregando las comidas de hoy a la nube…"
npm install --silent 2>/dev/null
node agregar-comidas-hoy-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
