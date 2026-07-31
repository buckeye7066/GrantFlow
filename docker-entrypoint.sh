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

  # Drop to `node`. Prefer setpriv: it EXECs, so the application becomes PID 1
  # itself. `su` forks and waits, leaving a root `su` as PID 1 — which fails the
  # production-image non-root gate and, more importantly, means PID 1 does not
  # forward SIGTERM to the app, so Railway deploys kill the container instead of
  # letting it shut down gracefully.
  #
  # Probe before committing: a present-but-unusable setpriv must not take the
  # container down, so we only exec it after a no-op run actually succeeds.
  if command -v setpriv >/dev/null 2>&1 \
    && setpriv --reuid=node --regid=node --init-groups true >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups -- "$@"
  fi

  # Fallback: correct privileges, but PID 1 stays root (see above).
  echo "[entrypoint] setpriv unavailable; falling back to su (PID 1 stays root)" >&2
  exec su node -s /bin/sh -c 'exec "$@"' grantflow-entrypoint "$@"
fi

exec "$@"
