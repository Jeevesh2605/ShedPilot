/**
 * Decides whether it is safe to propose turning shed flags back on. Pure, so every rule is tested.
 *
 * Two questions, both must be "yes":
 *  1. Is the service healthy? No throttles and p90 latency under the threshold, for N full minutes.
 *  2. Is it SAFE to restore? The service may look healthy only BECAUSE the flag is off. The demand
 *     still hitting the degraded route, times what each request cost before, must fit in the spare
 *     capacity. Otherwise re-enabling would bring the overload straight back.
 */
import type { MinuteMetrics } from '../lib/types';

export interface RecoverySettings {
  healthyMinutes: number; // N consecutive healthy minutes required
  healthyP90Ms: number; // API p90 latency must stay under this
  concurrencyLimit: number; // reports-api's concurrency limit
  headroomFraction: number; // use at most this share of the limit, e.g. 0.6
  cooldownMinutes: number; // after "Keep disabled", wait this long before asking again
}

export interface RecoveryInputs {
  now: Date;
  shedAt: string;
  keptDisabledAt?: string; // when a human last clicked "Keep disabled"
  minutes: MinuteMetrics[]; // the health window, oldest first, newest complete minutes only
  peakConcurrency: number; // highest concurrency in the health window
  demandWindowSeconds: number;
  demand: { flag: string; requests: number }[]; // degraded requests per shed flag in that window
  featureAvgMs: Record<string, number>; // cost per request when the flag was on (incident evidence)
}

export interface FlagDemand {
  flag: string;
  requestsPerSecond: number;
  avgMs: number;
  executionsNeeded: number;
}

/** Stable identifier of the rule that decided; the audit trail gets a new event only when this changes. */
export type AssessmentCode = 'kept-disabled' | 'settling' | 'no-data' | 'throttling' | 'slow' | 'demand' | 'ready';

export interface Assessment {
  ready: boolean;
  code: AssessmentCode;
  reason: string;
  throttles: number;
  worstP90Ms: number | null;
  peakConcurrency: number;
  demand: FlagDemand[];
  executionsNeeded: number;
  executionsAvailable: number;
}

/** Used when the incident has no recorded cost for a flag: assume a heavy feature, to stay safe. */
const UNKNOWN_FEATURE_COST_MS = 3000;

export function assessRecovery(inputs: RecoveryInputs, settings: RecoverySettings): Assessment {
  const throttles = inputs.minutes.reduce((sum, m) => sum + (m.throttles ?? 0), 0);
  const p90s = inputs.minutes.map((m) => m.apiLatencyP90Ms).filter((v): v is number => v !== null);
  const worstP90Ms = p90s.length ? Math.max(...p90s) : null;

  const demand = inputs.demand.map(({ flag, requests }) => {
    const requestsPerSecond = round(requests / Math.max(1, inputs.demandWindowSeconds), 2);
    const avgMs = inputs.featureAvgMs[flag] ?? UNKNOWN_FEATURE_COST_MS;
    // Little's law: busy executions = arrival rate x time per request.
    return { flag, requestsPerSecond, avgMs, executionsNeeded: round((requestsPerSecond * avgMs) / 1000, 1) };
  });
  const executionsNeeded = round(demand.reduce((sum, d) => sum + d.executionsNeeded, 0), 1);
  const executionsAvailable = round(Math.max(0, settings.concurrencyLimit * settings.headroomFraction - inputs.peakConcurrency), 1);

  const result = { throttles, worstP90Ms, peakConcurrency: inputs.peakConcurrency, demand, executionsNeeded, executionsAvailable };
  const notYet = (code: AssessmentCode, reason: string): Assessment => ({ ready: false, code, reason, ...result });

  if (inputs.keptDisabledAt) {
    const until = Date.parse(inputs.keptDisabledAt) + settings.cooldownMinutes * 60_000;
    if (inputs.now.getTime() < until) {
      return notYet('kept-disabled', `a human chose "Keep disabled"; next check after ${new Date(until).toISOString().slice(11, 16)} UTC`);
    }
  }
  const minutesSinceShed = (inputs.now.getTime() - Date.parse(inputs.shedAt)) / 60_000;
  if (minutesSinceShed < settings.healthyMinutes + 2) {
    return notYet('settling', `shed ${Math.floor(minutesSinceShed)} min ago; waiting for ${settings.healthyMinutes} complete healthy minutes`);
  }
  if (inputs.minutes.length < settings.healthyMinutes) return notYet('no-data', 'not enough metric data yet');
  // Confirmed idle minutes have null latency because API Gateway saw zero requests;
  // active traffic with missing latency telemetry cannot be treated as healthy.
  const missingLatency = inputs.minutes.some((m) => ((m.invocations ?? 0) > 0 || (m.concurrencyMax ?? 0) > 0) && m.apiLatencyP90Ms === null);
  if (missingLatency) return notYet('no-data', 'missing latency observations for active traffic');
  if (throttles > 0) return notYet('throttling', `still throttling: ${throttles} throttled requests in the last ${settings.healthyMinutes} min`);
  if (worstP90Ms !== null && worstP90Ms >= settings.healthyP90Ms) {
    return notYet('slow', `p90 latency ${worstP90Ms} ms is not under ${settings.healthyP90Ms} ms yet`);
  }
  if (executionsNeeded > executionsAvailable) {
    return notYet(
      'demand',
      `healthy, but only because the flag is off: re-enabling now would need about ${executionsNeeded} executions ` +
        `and only ${executionsAvailable} are free (${Math.round(settings.headroomFraction * 100)}% of ${settings.concurrencyLimit} minus ${inputs.peakConcurrency} in use)`,
    );
  }
  const demandText = executionsNeeded === 0
    ? 'no traffic is waiting on the disabled flags'
    : `the returning demand needs about ${executionsNeeded} of ${executionsAvailable} free executions`;
  return {
    ready: true,
    code: 'ready',
    reason: `healthy for ${settings.healthyMinutes} min, and ${demandText}`,
    ...result,
  };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
