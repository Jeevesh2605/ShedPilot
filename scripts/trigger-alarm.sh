#!/usr/bin/env bash
# Forces the throttle alarm into ALARM for testing, without running a load test.
# The investigator then runs on whatever the last 5 minutes of real metrics and logs show.
# CloudWatch puts the alarm back to its real state at the next evaluation (about 1 minute).
#
#   ./scripts/trigger-alarm.sh
set -euo pipefail
source "$(dirname "$0")/region.sh"
aws cloudwatch set-alarm-state --region "$SHEDPILOT_REGION" \
  --alarm-name shedpilot-reports-api-throttles --state-value ALARM \
  --state-reason "Manual test from scripts/trigger-alarm.sh"
echo "Alarm set to ALARM. Watch Slack, or: aws logs tail /aws/lambda/shedpilot-investigator --follow --region $SHEDPILOT_AGENT_REGION"
