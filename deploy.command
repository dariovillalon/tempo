#!/bin/bash
# Doble-click para subir los cambios de Tempo a la nube (Render redeploya solo).
cd "$(dirname "$0")" || exit 1
echo "── Subiendo cambios de Tempo a la nube ──"
# Limpia un lock viejo de git si quedó de una operación interrumpida.
rm -f .git/index.lock 2>/dev/null
rm -f .write_test_xyz 2>/dev/null
git add -A
msg="${1:-Update Tempo $(date '+%Y-%m-%d %H:%M')}"
if git diff --cached --quiet; then
  echo "No hay cambios nuevos para subir."
else
  git commit -m "$msg" || { echo "Error al commitear."; exit 1; }
fi
if git push; then
  echo "✅ Listo. Render va a redeployar solo en ~1–2 min."
  echo "   Mirá el estado en https://dashboard.render.com (tu servicio 'tempo')."
else
  echo "❌ Error al pushear. Revisá el mensaje de arriba (¿usuario git correcto?)."
fi
echo ""
read -n 1 -s -r -p "Apretá una tecla para cerrar..."
