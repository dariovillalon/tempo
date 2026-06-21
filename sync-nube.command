#!/bin/bash
# Doble-click: empuja tus datos LOCALES a la NUBE (Neon / Postgres).
# Usa la URL guardada en data/.cloud-url (si no existe, te la pide una vez).
cd "$(dirname "$0")" || exit 1
echo "──────────────────────────────────────"
echo "   Sincronizar  LOCAL  ->  NUBE"
echo "──────────────────────────────────────"
if [ -s data/.cloud-url ]; then
  DBURL="$(cat data/.cloud-url)"
  echo "Usando tu URL de Neon guardada. ✓"
else
  echo "Pegá tu DATABASE_URL de Neon y apretá Enter:"
  read -r DBURL
  if [ -z "$DBURL" ]; then echo "Cancelado."; read -n 1 -s -r -p "Tecla para cerrar..."; exit 1; fi
  printf '%s' "$DBURL" > data/.cloud-url; chmod 600 data/.cloud-url
fi
echo "Preparando (rápido si ya estaba)..."
npm install --silent 2>/dev/null
echo "Subiendo tus datos..."
DATABASE_URL="$DBURL" npm run migrate
echo ""
echo "Si arriba dice '✅ Listo', recargá  https://tempo-kqoo.onrender.com  y vas a ver todo."
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
