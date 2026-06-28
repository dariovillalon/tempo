#!/bin/bash
# Doble-click: sube a la nube las comidas del 27/06 (juntada) y el pesaje del 28/06.
# No borra ni duplica nada. TIP: cerrá las pestañas de tempo en el navegador antes de correrlo.
cd "$(dirname "$0")" || exit 1
echo "── Sincronizando juntada (27/06) y pesaje (28/06) a la nube ──"
npm install --silent 2>/dev/null
node sync-juntada-pesaje-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
