#!/usr/bin/env bash
# Development helper: removes the open-incident lock so a new alarm can start a new incident.
# Incident records and their audit trails are kept.
#
#   ./scripts/reset-incident.sh
set -euo pipefail
source "$(dirname "$0")/region.sh"
aws dynamodb delete-item --region "$SHEDPILOT_AGENT_REGION" --table-name shedpilot-incidents \
  --key '{"pk":{"S":"LOCK#reports-api"},"sk":{"S":"LOCK"}}' --return-values ALL_OLD \
  --query 'Attributes.incidentId.S' --output text | sed 's/^/Released lock held by: /'
