#!/bin/bash
# Doble-click: actualiza SOLO la biblioteca de comidas (foodLibrary) en la nube (no toca comidas/días/pesajes).
# Se puede correr con la web abierta: va en transacción y las pestañas detectan el cambio solas.
# Después de "OK", abrí la web de nuevo y recargá (Cmd+Shift+R).
cd "$(dirname "$0")" || exit 1
echo "Actualizando la biblioteca de comidas en la nube…"
npm install --silent 2>/dev/null
node update-foodlibrary-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
