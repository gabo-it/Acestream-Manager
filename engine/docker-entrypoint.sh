#!/bin/bash
set -e

# HTTP_PORT/PORT stay as their own variables (not folded into ENGINE_FLAGS
# below) because docker-compose's port mapping and other services (acexy,
# webui) need these exact same values too — not just something buried
# inside a free-form flag string with no single source of truth.
ARGS=("--http-port" "${HTTP_PORT:-6677}" "--port" "${PORT:-44556}")

# ACCESS_TOKEN also stays separate, so it's never accidentally included
# when sharing/pasting ENGINE_FLAGS somewhere for troubleshooting.
if [ -n "${ACCESS_TOKEN:-}" ]; then
  ARGS+=("--access-token" "${ACCESS_TOKEN}")
fi

# Everything else: one free-form string of official engine flags (see
# https://docs.acestream.net/developers/engine-command-line-options/).
# Edit ENGINE_FLAGS directly to add, remove, or change any of them —
# no need for a dedicated variable per flag.
if [ -n "${ENGINE_FLAGS:-}" ]; then
  read -r -a FLAGS <<< "${ENGINE_FLAGS}"
  ARGS+=("${FLAGS[@]}")
fi

echo "[entrypoint] Starting AceStream engine with: ${ARGS[*]}"
exec /srv/ace/start-engine "${ARGS[@]}"

