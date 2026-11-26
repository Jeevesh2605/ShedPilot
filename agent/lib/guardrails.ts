/**
 * The guardrail: deterministic code that decides which proposed actions may run.
 * Whatever proposes an action (the Phase 2 rule, or Claude from Phase 4), every action must pass
 * these checks against Flagsmith's LIVE state. It runs twice: when the proposal is made, and again
 * in the executor right before any flag is changed, in case something changed in between.
 */
import { SHEDDABLE_TAG } from './constants';
import type { FlagInfo, ProposedAction } from './types';

export const MAX_ACTIONS_PER_PROPOSAL = 3;

export interface RejectedAction {
  flag: string;
  reasons: string[];
}

export interface GuardrailResult {
  allowed: ProposedAction[];
  rejected: RejectedAction[];
}

/** Checks actions that would turn flags OFF. Accepts unknown input, because LLM output is untrusted. */
export function checkShedActions(actions: unknown[], flags: FlagInfo[]): GuardrailResult {
  const byName = new Map(flags.map((f) => [f.name, f]));
  const allowed: ProposedAction[] = [];
  const rejected: RejectedAction[] = [];
  const seen = new Set<string>();

  for (const raw of actions) {
    const action = raw as Partial<ProposedAction>;
    const flagName = typeof action?.flag === 'string' ? action.flag : String(action?.flag ?? '(missing)');
    const reasons: string[] = [];
    const flag = byName.get(flagName);

    if (action?.action !== 'disable') reasons.push(`action must be "disable", got "${String(action?.action)}"`);
    if (!flag) reasons.push('no such flag in Flagsmith');
    else {
      if (!flag.enabled) reasons.push('flag is already off');
      if (!flag.tags.includes(SHEDDABLE_TAG)) reasons.push(`missing tag ${SHEDDABLE_TAG}`);
    }
    if (seen.has(flagName)) reasons.push('duplicate of an earlier action');
    if (reasons.length === 0 && allowed.length >= MAX_ACTIONS_PER_PROPOSAL) {
      reasons.push(`more than ${MAX_ACTIONS_PER_PROPOSAL} flags in one proposal`);
    }

    seen.add(flagName);
    if (reasons.length) rejected.push({ flag: flagName, reasons });
    else allowed.push(action as ProposedAction);
  }
  return { allowed, rejected };
}

/**
 * Checks flags to turn back ON at recovery (Phase 5): only flags this incident turned off,
 * that are still off, and still tagged load-sheddable.
 */
export function checkRestoreFlags(
  flagNames: string[],
  shedByIncident: string[],
  flags: FlagInfo[],
): { allowed: string[]; rejected: RejectedAction[] } {
  const byName = new Map(flags.map((f) => [f.name, f]));
  const allowed: string[] = [];
  const rejected: RejectedAction[] = [];
  for (const name of new Set(flagNames)) {
    const flag = byName.get(name);
    const reasons: string[] = [];
    if (!shedByIncident.includes(name)) reasons.push('this incident did not turn it off');
    if (!flag) reasons.push('no such flag in Flagsmith');
    else {
      if (flag.enabled) reasons.push('flag is already on');
      if (!flag.tags.includes(SHEDDABLE_TAG)) reasons.push(`missing tag ${SHEDDABLE_TAG}`);
    }
    if (reasons.length) rejected.push({ flag: name, reasons });
    else allowed.push(name);
  }
  return { allowed, rejected };
}

/** "checkout_core: missing tag load-sheddable" */
export function describeRejections(rejected: RejectedAction[]): string[] {
  return rejected.map((r) => `${r.flag}: ${r.reasons.join(', ')}`);
}
