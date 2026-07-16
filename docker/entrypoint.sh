#!/bin/sh
set -eu

: "${CLAUDE_CONFIG_DIR:=/data}"
: "${CLAUDE_USAGE_WORKDIR:=/home/node/workspace}"
export CLAUDE_CONFIG_DIR CLAUDE_USAGE_WORKDIR

mkdir -p "$CLAUDE_CONFIG_DIR"

# Named volumes are created root:root on first use; hand off to the
# non-root user once ownership is fixed so nothing runs as root.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$CLAUDE_CONFIG_DIR"
  exec gosu node "$0" "$@"
fi

exec node /app/bin/claude-usage-server.js
