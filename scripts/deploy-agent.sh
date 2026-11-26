#!/usr/bin/env bash
# Builds and deploys the agent stack. It reads the app stack's outputs and a few values from .env,
# and passes them in as parameters, so nothing is copied by hand.
#
# Every parameter is passed on every deploy. (For an existing stack, sam deploy otherwise keeps a
# parameter's PREVIOUS value, so changing a default in template.yaml would silently do nothing.)
#
# Settings, from the environment, else .env, else the default shown:
#   LLM_PROVIDER=groq  LLM_MODEL=openai/gpt-oss-120b  DRY_RUN=false  APPROVER_USER_IDS=""
#   EVIDENCE_WINDOW_MINUTES=5  EVIDENCE_SETTLE_SECONDS=60  RECOVERY_EVERY_MINUTES=10
#   HEALTHY_MINUTES=3  HEALTHY_P90_MS=1500  CONCURRENCY_LIMIT=10  HEADROOM_FRACTION=0.6
#   RESTORE_COOLDOWN_MINUTES=10  APPROVAL_TIMEOUT_MINUTES=30
#
#   ./scripts/deploy-agent.sh                                   # asks before applying the change set
#   ./scripts/deploy-agent.sh --no-confirm-changeset
#   LLM_PROVIDER=rogue-demo ./scripts/deploy-agent.sh           # guardrail demo
#   DRY_RUN=true ./scripts/deploy-agent.sh                      # executor changes nothing
#   RECOVERY_EVERY_MINUTES=1 HEALTHY_MINUTES=2 ./scripts/deploy-agent.sh   # fast recovery for the demo
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/region.sh

read_env() { { grep -E "^$1=" .env || true; } | head -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
output() {
  aws cloudformation describe-stacks --region "$SHEDPILOT_REGION" --stack-name shedpilot \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

# Environment variable wins, then .env, then the default.
setting() { local v="${!1:-}"; [ -n "$v" ] || v="$(read_env "$1")"; echo "${v:-$2}"; }
LLM_PROVIDER="$(setting LLM_PROVIDER groq)"
LLM_MODEL="$(setting LLM_MODEL openai/gpt-oss-120b)"
DRY_RUN="$(setting DRY_RUN false)"
APPROVER_USER_IDS="$(setting APPROVER_USER_IDS '')"
EVIDENCE_WINDOW_MINUTES="$(setting EVIDENCE_WINDOW_MINUTES 5)"
EVIDENCE_SETTLE_SECONDS="$(setting EVIDENCE_SETTLE_SECONDS 60)"
RECOVERY_EVERY_MINUTES="$(setting RECOVERY_EVERY_MINUTES 10)"
HEALTHY_MINUTES="$(setting HEALTHY_MINUTES 3)"
HEALTHY_P90_MS="$(setting HEALTHY_P90_MS 1500)"
CONCURRENCY_LIMIT="$(setting CONCURRENCY_LIMIT 10)"
HEADROOM_FRACTION="$(setting HEADROOM_FRACTION 0.6)"
RESTORE_COOLDOWN_MINUTES="$(setting RESTORE_COOLDOWN_MINUTES 10)"
APPROVAL_TIMEOUT_MINUTES="$(setting APPROVAL_TIMEOUT_MINUTES 30)"

for name in SLACK_CHANNEL_ID FLAGSMITH_PROJECT_ID FLAGSMITH_ENVIRONMENT_KEY; do
  [ -n "$(read_env "$name")" ] || { echo "$name is empty in .env"; exit 1; }
done

echo "App region:   $SHEDPILOT_REGION"
echo "Agent region: $SHEDPILOT_AGENT_REGION"
echo "LLM:          $LLM_PROVIDER ($LLM_MODEL)   dry run: $DRY_RUN   approvers: ${APPROVER_USER_IDS:-anyone in the channel}"
echo "Recovery:     every $RECOVERY_EVERY_MINUTES min, $HEALTHY_MINUTES healthy min, limit $CONCURRENCY_LIMIT, cooldown $RESTORE_COOLDOWN_MINUTES min"

OVERRIDES="TargetRegion=$SHEDPILOT_REGION SecretsRegion=$SHEDPILOT_REGION"
OVERRIDES+=" AlarmTopicArn=$(output AlarmTopicArn)"
OVERRIDES+=" ReportsFunctionName=$(output ReportsFunctionName)"
OVERRIDES+=" ReportsApiId=$(output ApiId)"
OVERRIDES+=" ReportsLogGroup=$(output ReportsLogGroup)"
OVERRIDES+=" SlackChannelId=$(read_env SLACK_CHANNEL_ID)"
OVERRIDES+=" FlagsmithProjectId=$(read_env FLAGSMITH_PROJECT_ID)"
OVERRIDES+=" FlagsmithEnvironmentKey=$(read_env FLAGSMITH_ENVIRONMENT_KEY)"
OVERRIDES+=" LlmProvider=$LLM_PROVIDER LlmModel=$LLM_MODEL DryRun=$DRY_RUN"
if [ -n "$APPROVER_USER_IDS" ]; then
  OVERRIDES+=" ApproverUserIds=$APPROVER_USER_IDS"
else
  OVERRIDES+=" ApproverUserIds=\"\""
fi
OVERRIDES+=" EvidenceWindowMinutes=$EVIDENCE_WINDOW_MINUTES EvidenceSettleSeconds=$EVIDENCE_SETTLE_SECONDS"
OVERRIDES+=" RecoveryEveryMinutes=$RECOVERY_EVERY_MINUTES HealthyMinutes=$HEALTHY_MINUTES HealthyP90Ms=$HEALTHY_P90_MS"
OVERRIDES+=" ConcurrencyLimit=$CONCURRENCY_LIMIT HeadroomFraction=$HEADROOM_FRACTION"
OVERRIDES+=" RestoreCooldownMinutes=$RESTORE_COOLDOWN_MINUTES ApprovalTimeoutMinutes=$APPROVAL_TIMEOUT_MINUTES"

# sam build needs esbuild on the PATH; use the project's copy.
export PATH="$PWD/node_modules/.bin:$PATH"
cd agent
sam build
sam deploy --parameter-overrides "$OVERRIDES" "$@"
