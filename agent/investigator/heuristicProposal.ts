/**
 * PHASE 2 STAND-IN for the LLM. Phase 4 replaces this with Claude, which returns the same
 * Proposal shape, so nothing downstream changes.
 *
 * The rule: find the feature that used the most compute in the window. If it used a large share,
 * is currently on, and is tagged load-sheddable, propose turning it off. Otherwise propose nothing.
 */
import { SHEDDABLE_TAG } from '../lib/constants';
import type { Evidence, Proposal } from '../lib/types';

/** A feature must use at least this share of compute to be worth shedding. */
const MIN_COMPUTE_SHARE = 0.3;

const pct = (share: number) => `${Math.round(share * 100)}%`;

export function heuristicProposal(evidence: Evidence): Proposal {
  const { totals } = evidence.metrics;
  const flagByName = new Map(evidence.flags.map((f) => [f.name, f]));
  const symptoms =
    `${totals.throttles} requests throttled and ${totals.api5xx} API 5xx responses in the last 5 minutes, ` +
    `with Lambda concurrency peaking at ${totals.peakConcurrency}`;

  if (totals.throttles === 0 && totals.api5xx === 0) {
    return {
      proposedBy: 'heuristic',
      diagnosis:
        'The alarm fired, but the last 5 minutes show no throttling and no API 5xx errors. ' +
        'It may have been a short blip or a manual test, so there is nothing to shed.',
      actions: [],
      alternatives_considered: [],
      confidence: 'medium',
    };
  }

  const top = evidence.logs.features[0];
  if (!top || top.computeShare < MIN_COMPUTE_SHARE) {
    return {
      proposedBy: 'heuristic',
      diagnosis: `reports-api is under stress (${symptoms}), but no single feature dominates compute time, so turning off one flag would not clearly help.`,
      actions: [],
      alternatives_considered: evidence.logs.features.map((f) => `${f.flag}: ${pct(f.computeShare)} of compute`),
      confidence: 'low',
    };
  }

  const flag = flagByName.get(top.flag);
  const sheddable = flag?.tags.includes(SHEDDABLE_TAG) ?? false;
  if (!flag || !flag.enabled || !sheddable) {
    const why = !flag ? 'is not a flag in Flagsmith' : !flag.enabled ? 'is already off' : `is not tagged ${SHEDDABLE_TAG}`;
    return {
      proposedBy: 'heuristic',
      diagnosis: `reports-api is under stress (${symptoms}). The biggest cost is ${top.flag} (${pct(top.computeShare)} of compute), but it ${why}, so ShedPilot will not touch it.`,
      actions: [],
      alternatives_considered: [`Disable ${top.flag}: blocked because it ${why}.`],
      confidence: 'medium',
    };
  }

  // Other features worth mentioning: anything that used at least 1% of compute.
  const others = evidence.logs.features
    .slice(1)
    .filter((f) => f.computeShare >= 0.01)
    .map((f) => {
      const tagged = flagByName.get(f.flag)?.tags.includes(SHEDDABLE_TAG) ?? false;
      return tagged
        ? `Also turn off ${f.flag}: it used only ${pct(f.computeShare)} of compute, so it would not change the outcome and would cost users a feature for nothing.`
        : `${f.flag} (${pct(f.computeShare)} of compute) is not tagged ${SHEDDABLE_TAG}, so ShedPilot never proposes it.`;
    });

  // The feature's share of execution time, applied to the peak, estimates how many of the busy
  // executions it was holding. (A 5-minute average would understate a spike that started a minute ago.)
  const executionsHeld = Math.max(1, Math.round(top.computeShare * totals.peakConcurrency));

  return {
    proposedBy: 'heuristic',
    diagnosis:
      `reports-api is overloaded: ${symptoms}. ${top.flag} used ${pct(top.computeShare)} of the compute time of served requests ` +
      `(${top.requests} requests, ${top.avgMs} ms on average, p90 ${top.p90Ms} ms).`,
    actions: [
      {
        flag: top.flag,
        action: 'disable',
        reason: `${top.flag} is the dominant cost and is tagged ${SHEDDABLE_TAG}.`,
        evidence: `${pct(top.computeShare)} of Lambda execution time, ${top.requests} requests, avg ${top.avgMs} ms, p90 ${top.p90Ms} ms.`,
        expected_effect:
          `At the peak of ${totals.peakConcurrency} concurrent executions, ${top.flag} was holding roughly ${executionsHeld} of them. ` +
          `Turning it off returns that capacity: its requests get a fast degraded response, so throttling of other routes, including checkout, should stop.`,
        user_impact: flag.description
          ? `Users temporarily lose this feature: ${flag.description}`
          : `Users temporarily lose the ${top.flag} feature and get a degraded response instead.`,
      },
    ],
    alternatives_considered: [...others, `Do nothing: throttling continues (${totals.throttles} throttles in the last 5 minutes).`],
    confidence: 'medium',
  };
}
