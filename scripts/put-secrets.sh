#!/usr/bin/env bash
# Copies secrets from .env into SSM Parameter Store as SecureString parameters under /shedpilot/.
# Lambdas read them at cold start; only the parameter names live in the template.
# Only variables that are set in .env are written. Values are never printed.
#
#   ./scripts/put-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

source "$(dirname "$0")/region.sh"
REGION="$SHEDPILOT_REGION"
[ -f .env ] || { echo "No .env file. Copy .env.example to .env first."; exit 1; }

# Read KEY=value from .env without executing the file.
# "|| true": a key missing from .env is skipped, not a fatal error.
read_env() { { grep -E "^$1=" .env || true; } | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

put() {
  local env_name="$1" param="$2" value
  value="$(read_env "$env_name")"
  if [ -z "$value" ]; then echo "skip  $param ($env_name is empty)"; return; fi
  aws ssm put-parameter --region "$REGION" --name "$param" --type SecureString \
    --value "$value" --overwrite >/dev/null
  echo "saved $param"
}

put FLAGSMITH_SERVER_KEY    /shedpilot/flagsmith-server-key
put FLAGSMITH_ADMIN_API_KEY /shedpilot/flagsmith-admin-key
put SLACK_BOT_TOKEN         /shedpilot/slack-bot-token
put SLACK_SIGNING_SECRET    /shedpilot/slack-signing-secret
put GROQ_API_KEY            /shedpilot/groq-api-key
put XAI_API_KEY             /shedpilot/xai-api-key
