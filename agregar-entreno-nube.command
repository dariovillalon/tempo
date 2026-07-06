#!/bin/bash
# Doble-click: agrega SOLO la sesión de entreno de hoy a la nube (no borra nada más).
# Se puede correr con la web abierta: va en transacción y las pestañas detectan el cambio solas.
cd "$(dirname "$0")" || exit 1
echo "Agregando la sesión de entreno de hoy a la nube…"
npm install --silent 2>/dev/null
node agregar-entreno-nube.mjs
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
