# Sourced by the other scripts. Regions always come from the samconfig.toml files, the same place
# "sam deploy" reads them, so an AWS_REGION in your shell can't send things to the wrong region.
_shedpilot_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_read_region() { grep -E '^region *=' "$1" | head -1 | cut -d'"' -f2; }
SHEDPILOT_REGION="$(_read_region "$_shedpilot_root/samconfig.toml")"
SHEDPILOT_AGENT_REGION="$(_read_region "$_shedpilot_root/agent/samconfig.toml")"
[ -n "$SHEDPILOT_REGION" ] && [ -n "$SHEDPILOT_AGENT_REGION" ] || { echo "Could not read regions from samconfig.toml files"; exit 1; }
