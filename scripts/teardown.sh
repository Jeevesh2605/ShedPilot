#!/usr/bin/env bash
# Removes everything ShedPilot created in AWS: both CloudFormation stacks (agent first, then app:
# Lambdas, API, alarms, SNS topic, DynamoDB table, log groups) and the /shedpilot/* SSM parameters.
# Flagsmith flags are left alone; delete them in the dashboard if you want.
#
#   ./scripts/teardown.sh          # asks for confirmation
#   ./scripts/teardown.sh --yes
set -euo pipefail

source "$(dirname "$0")/region.sh"
REGION="$SHEDPILOT_REGION"

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Delete stacks shedpilot-agent ($SHEDPILOT_AGENT_REGION), shedpilot ($REGION) and all /shedpilot/* parameters? Type yes: " answer
  [ "$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
fi

echo "Deleting agent stack..."
sam delete --stack-name shedpilot-agent --region "$SHEDPILOT_AGENT_REGION" --no-prompts
echo "Deleting app stack..."
sam delete --stack-name shedpilot --region "$REGION" --no-prompts

echo "Deleting SSM parameters under /shedpilot/..."
names=$(aws ssm get-parameters-by-path --region "$REGION" --path /shedpilot --recursive \
  --query 'Parameters[].Name' --output text)
if [ -n "$names" ]; then
  # shellcheck disable=SC2086
  aws ssm delete-parameters --region "$REGION" --names $names --query 'DeletedParameters' --output text
fi

echo "Done. The SAM artifact bucket (stack aws-sam-cli-managed-default) is shared by all SAM"
echo "projects in this account and is left in place. It costs almost nothing."
