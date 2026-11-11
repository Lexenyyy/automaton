#!/bin/sh
# Runtime entrypoint (fork, Phase 1). Never prints secret values.
set -eu

# Mainnet is Phase 8 only. The code also refuses mainnet without approval;
# this refuses the approval variable itself, in any form.
if [ -n "${AUTOMATON_MAINNET_APPROVED+x}" ]; then
  echo "runtime: refusing to start: AUTOMATON_MAINNET_APPROVED is set (mainnet is Phase 8 only)." >&2
  exit 64
fi

. /usr/local/lib/automaton/load-secrets.sh

exec node /app/dist/index.js "$@"
