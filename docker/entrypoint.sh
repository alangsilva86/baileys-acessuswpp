#!/usr/bin/env sh
set -eu

echo "[entrypoint] preparando persistência..."

mkdir -p /app/sessions
if [ ! -e /app/data ]; then
  ln -s /app/sessions /app/data
fi

echo "[entrypoint] verificação:"
ls -ld /app/data || true
ls -ld /app/sessions || true

if [ -w /app/sessions ]; then
  echo "[entrypoint] /app/sessions é gravável"
else
  echo "[entrypoint] /app/sessions NÃO é gravável" >&2
fi

exec node dist/src/server.js