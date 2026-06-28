#!/bin/sh
set -eu

UPLOAD_TARGET="${UPLOADS_DIR:-}"

if [ -n "$UPLOAD_TARGET" ]; then
  mkdir -p "$UPLOAD_TARGET"
fi

mkdir -p /app/data /app/uploads

if [ "$(id -u)" = "0" ]; then
  if [ -n "$UPLOAD_TARGET" ]; then
    chown -R node:node "$UPLOAD_TARGET"
  fi
  chown -R node:node /app/data /app/uploads
  exec su node -s /bin/sh -c 'exec "$@"' grantflow-entrypoint "$@"
fi

exec "$@"
