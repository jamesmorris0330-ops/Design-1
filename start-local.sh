#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1 || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) === 24 ? 0 : 1)"; then
  echo 'Install Node.js 24 from https://nodejs.org, then run this launcher again.' >&2
  exit 1
fi
if [[ ! -f dist-server/index.js ]]; then
  echo 'Extract the complete release ZIP before running this launcher.' >&2
  exit 1
fi
if [[ ! -f node_modules/fastify/package.json ]]; then
  echo 'Installing game dependencies. Internet access is needed for this first launch.'
  npm ci --omit=dev --cache "$PWD/.npm-cache" --no-audit --no-fund
fi
export NODE_ENV=development HOST=0.0.0.0 PORT="${PORT:-3000}"
export DATABASE_PATH="$PWD/data/experiment.sqlite"
unset PUBLIC_ORIGIN TRUST_PROXY
echo "THE EXPERIMENT will run on this computer, port $PORT."
echo 'Keep this terminal open while playing. See docs/pc-quick-start.md for phone access.'
exec npm start
