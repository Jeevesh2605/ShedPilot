/** Evidence shaped like the real Phase 1 spike (2026-11-12, pdf_export on). */
import type { Evidence, FlagInfo } from '../agent/lib/types';

export const FLAGS: FlagInfo[] = [
  { name: 'pdf_export', id: 291694, enabled: true, tags: ['load-sheddable'], description: 'PDF report export. CPU heavy (2 to 4 s per report).' },
  { name: 'basic_csv', id: 291695, enabled: true, tags: ['load-sheddable'], description: 'Small CSV export. Cheap.' },
  { name: 'rich_analytics', id: 291696, enabled: true, tags: ['load-sheddable'], description: 'Extra aggregation on the summary endpoint (about 1 s).' },
  { name: 'checkout_core', id: 291697, enabled: true, tags: [], description: 'Core checkout path. NOT sheddable.' },
];

export function spikeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    alarm: { name: 'shedpilot-reports-api-throttles', reason: 'Threshold crossed', time: '2026-11-12T09:25:00Z' },
    metrics: {
      windowStart: '2026-11-12T09:21:00Z',
      windowEnd: '2026-11-12T09:26:00Z',
      perMinute: [],
      totals: {
        invocations: 640, throttles: 676, errors: 0, api5xx: 779, peakConcurrency: 10,
        worstMinuteApiLatencyP50Ms: 60, worstMinuteApiLatencyP90Ms: 3618, worstMinuteLambdaDurationP90Ms: 4300,
      },
    },
    logs: {
      servedRequests: 638,
      totalDurationMs: 1_636_550,
      features: [
        { flag: 'pdf_export', requests: 476, avgMs: 3255, p90Ms: 4328, totalMs: 1_549_383, computeShare: 0.947, avgConcurrency: 5.16 },
        { flag: 'rich_analytics', requests: 61, avgMs: 976, p90Ms: 1152, totalMs: 59_507, computeShare: 0.036, avgConcurrency: 0.2 },
        { flag: 'checkout_core', requests: 66, avgMs: 0, p90Ms: 0, totalMs: 10, computeShare: 0, avgConcurrency: 0 },
      ],
    },
    flags: FLAGS,
    ...overrides,
  };
}
