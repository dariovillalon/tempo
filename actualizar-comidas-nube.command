#!/bin/bash
# Doble-click: actualiza SOLO la biblioteca de comidas en la nube (no toca tus comidas/pesajes).
cd "$(dirname "$0")" || exit 1
echo "Actualizando biblioteca de comidas en la nube…"
npm install --silent 2>/dev/null
node update-foodlibrary-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
