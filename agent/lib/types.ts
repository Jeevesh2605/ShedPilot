/**
 * Shared data shapes. The Proposal shape is the same one the LLM will return in Phase 4,
 * so the rest of the pipeline (incidents, Slack, executor) never changes when the LLM arrives.
 */

/** One flag as seen in Flagsmith right now. */
export interface FlagInfo {
  name: string;
  id: number;
  enabled: boolean;
  tags: string[]; // labels, e.g. ["load-sheddable"]
  description: string | null;
}

/** One minute of CloudWatch metrics. Missing data is null. */
export interface MinuteMetrics {
  minute: string; // ISO timestamp of the start of the minute
  invocations: number | null;
  throttles: number | null;
  errors: number | null;
  concurrencyMax: number | null;
  apiLatencyP90Ms: number | null;
  api5xx: number | null;
}

export interface MetricsEvidence {
  windowStart: string;
  windowEnd: string;
  perMinute: MinuteMetrics[];
  totals: {
    invocations: number;
    throttles: number;
    errors: number;
    api5xx: number;
    peakConcurrency: number;
    // Percentiles can't be combined across minutes, so these are the worst single minute.
    worstMinuteApiLatencyP50Ms: number | null;
    worstMinuteApiLatencyP90Ms: number | null;
    worstMinuteLambdaDurationP90Ms: number | null;
  };
}

/** Compute spent in one flag's code path, from the structured request logs. */
export interface FeatureCost {
  flag: string;
  requests: number; // requests that ran this feature's code
  avgMs: number;
  p90Ms: number;
  totalMs: number;
  computeShare: number; // totalMs / all request time, 0..1
  avgConcurrency: number; // totalMs / window length: executions kept busy on average
}

export interface LogsEvidence {
  servedRequests: number;
  totalDurationMs: number;
  features: FeatureCost[]; // sorted by totalMs, largest first
}

export interface AlarmInfo {
  name: string;
  reason: string;
  time: string;
}

export interface Evidence {
  alarm: AlarmInfo;
  metrics: MetricsEvidence;
  logs: LogsEvidence;
  flags: FlagInfo[];
}

export interface ProposedAction {
  flag: string;
  action: 'disable';
  reason: string;
  evidence: string;
  expected_effect: string;
  user_impact: string;
}

export interface Proposal {
  proposedBy: 'heuristic' | 'llm';
  /** For LLM proposals: which model, e.g. "grok-4.7". */
  model?: string;
  diagnosis: string;
  actions: ProposedAction[];
  alternatives_considered: string[];
  confidence: 'low' | 'medium' | 'high';
}

/** Who clicked a button, and when. Stored on the incident: this is the recorded human approval. */
export interface HumanDecision {
  decision: 'approve' | 'reject';
  userId: string;
  userName: string;
  at: string;
}

/** What the executor did to one flag. */
export interface FlagChangeResult {
  flag: string;
  featureId?: number;
  ok: boolean;
  dryRun: boolean;
  enabledAfter?: boolean; // read back from Flagsmith after the change
  /** True when one leg succeeded and one failed, so state came from only PATCH or only GET. */
  unverified?: boolean;
  /** True when both PATCH and follow-up GET failed, leaving the live flag state unknown. */
  unknownState?: boolean;
  error?: string;
}
