#!/usr/bin/env bash
# Builds and deploys the app stack (reports-api, alarms, SNS topic), passing FLAGSMITH_API_HOST
# from the environment or .env so switching between Flagsmith Cloud and self-hosted takes one variable.
set -euo pipefail
cd "$(dirname "$0")/.."

read_env() { { grep -E "^$1=" .env || true; } | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
setting() { local v="${!1:-}"; [ -n "$v" ] || v="$(read_env "$1")"; echo "${v:-$2}"; }

RESERVED_CONCURRENCY="$(setting RESERVED_CONCURRENCY 0)"
PDF_PAGES="$(setting PDF_PAGES 110)"
ANALYTICS_ROWS="$(setting ANALYTICS_ROWS 400000)"
FLAGSMITH_API_HOST="$(setting FLAGSMITH_API_HOST '')"

echo "Flagsmith:    ${FLAGSMITH_API_HOST:-https://edge.api.flagsmith.com (Cloud)}"

OVERRIDES="ReservedConcurrency=$RESERVED_CONCURRENCY PdfPages=$PDF_PAGES AnalyticsRows=$ANALYTICS_ROWS"
if [ -n "$FLAGSMITH_API_HOST" ]; then
  OVERRIDES+=" FlagsmithApiHost=$FLAGSMITH_API_HOST"
else
  OVERRIDES+=" FlagsmithApiHost=\"\""
fi

export PATH="$PWD/node_modules/.bin:$PATH"
sam build
sam deploy --parameter-overrides "$OVERRIDES" "$@"

