#!/bin/bash
# Doble-click: agrega SOLO la sesión de entreno de hoy a la nube (no borra nada más).
# TIP: cerrá las pestañas de tempo en el navegador antes de correrlo, para que no
# pisen el cambio. Después de "OK", abrí la web de nuevo y recargá (Cmd+Shift+R).
cd "$(dirname "$0")" || exit 1
echo "Agregando la sesión de entreno de hoy a la nube…"
npm install --silent 2>/dev/null
node agregar-entreno-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
