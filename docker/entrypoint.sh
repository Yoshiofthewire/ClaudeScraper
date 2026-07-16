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

node -e "import('/app/src/preseed.js').then(m => m.preseed(process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_USAGE_WORKDIR))"

has_credentials() {
  [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ] \
    || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] \
    || [ -n "${ANTHROPIC_API_KEY:-}" ]
}

if has_credentials; then
  exec node /app/bin/claude-usage.js "$@"
fi

case "${1:-}" in
  login)
    cd "$CLAUDE_USAGE_WORKDIR"
    if [ "${2:-}" = "--token" ]; then
      exec claude setup-token
    fi
    exec claude
    ;;
  *)
    echo "claude-usage: not logged in. Run '... login' first (see README)." >&2
    exit 2
    ;;
esac
