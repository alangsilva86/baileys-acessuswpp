#!/usr/bin/env sh
set -e

echo "[entrypoint] preparando persistência..."
mkdir -p /app/sessions

# /app/data aponta para o mesmo disco de /app/sessions
if [ -e /app/data ] && [ ! -L /app/data ]; then
  rm -rf /app/data
fi
ln -sfn /app/sessions /app/data

# tenta ajustar permissões; se rodar como root ok, senão ignora
chown -R 1000:1000 /app/sessions 2>/dev/null || true

echo "[entrypoint] verificação:"
ls -ld /app/sessions /app/data || true
test -w /app/sessions && echo "[entrypoint] /app/sessions é gravável" || echo "[entrypoint] /app/sessions NÃO é gravável"

# passa o comando original adiante
exec "$@"