#!/usr/bin/env bash
# Builds and deploys the app stack (reports-api, alarms, SNS topic).
# Preserves parameter_overrides from samconfig.toml and only overrides a parameter when explicitly
# set in the environment or .env (plus FlagsmithApiHost for Cloud vs self-hosted switching).
set -euo pipefail
cd "$(dirname "$0")/.."

read_env() { { grep -E "^$1=" .env || true; } | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
setting() { local v="${!1:-}"; [ -n "$v" ] || v="$(read_env "$1")"; echo "${v:-}"; }

FLAGSMITH_API_HOST="$(setting FLAGSMITH_API_HOST)"
echo "Flagsmith:    ${FLAGSMITH_API_HOST:-https://edge.api.flagsmith.com (Cloud)}"

OVERRIDES_STR="$(node -e '
const fs = require("fs");
const sam = fs.readFileSync("samconfig.toml", "utf8");
const raw = sam.match(/^parameter_overrides\s*=\s*"([^"]*)"/m)?.[1] ?? "";
const map = new Map();
for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
  const idx = tok.indexOf("=");
  if (idx > 0) map.set(tok.slice(0, idx), tok.slice(idx + 1));
}
const readEnv = (k) => {
  if (process.env[k]) return process.env[k];
  if (!fs.existsSync(".env")) return "";
  const m = fs.readFileSync(".env", "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["\x27]|["\x27]$/g, "") : "";
};
for (const [envKey, paramKey] of [
  ["RESERVED_CONCURRENCY", "ReservedConcurrency"],
  ["PDF_PAGES", "PdfPages"],
  ["ANALYTICS_ROWS", "AnalyticsRows"],
  ["LATENCY_THRESHOLD_MS", "LatencyThresholdMs"],
]) {
  const val = readEnv(envKey);
  if (val) map.set(paramKey, val);
}
const host = readEnv("FLAGSMITH_API_HOST");
map.set("FlagsmithApiHost", host ? host : "\"\"");
console.log([...map.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
')"

export PATH="$PWD/node_modules/.bin:$PATH"
sam build
sam deploy --parameter-overrides "$OVERRIDES_STR" "$@"
