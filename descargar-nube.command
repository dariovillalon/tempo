#!/bin/bash
# Doble-click: descarga (backup) el estado de la NUBE a data/backups-nube/ con fecha.
# Solo LEE de la nube — no modifica nada. Podés correrlo con la web abierta.
cd "$(dirname "$0")" || exit 1
echo "Descargando backup de la nube…"
npm install --silent 2>/dev/null
node descargar-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
