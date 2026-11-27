import { describe, expect, it } from 'vitest';
import { assessRecovery, type RecoveryInputs, type RecoverySettings } from '../agent/recovery/assess';
import type { MinuteMetrics } from '../agent/lib/types';

const settings: RecoverySettings = { healthyMinutes: 3, healthyP90Ms: 1500, concurrencyLimit: 10, headroomFraction: 0.6, cooldownMinutes: 10 };
const now = new Date('2026-11-14T10:30:00Z');
const minute = (m: Partial<MinuteMetrics> = {}): MinuteMetrics => ({
  minute: '2026-11-14T10:25:00Z', invocations: 300, throttles: 0, errors: 0, concurrencyMax: 2, apiLatencyP90Ms: 120, api5xx: 0, ...m,
});
const inputs = (over: Partial<RecoveryInputs> = {}): RecoveryInputs => ({
  now,
  shedAt: '2026-11-14T10:15:00Z',
  minutes: [minute(), minute(), minute()],
  peakConcurrency: 2,
  demandWindowSeconds: 180,
  demand: [{ flag: 'pdf_export', requests: 0 }],
  featureAvgMs: { pdf_export: 3100 },
  ...over,
});

describe('recovery assessment', () => {
  it('is ready when healthy and the returning demand fits', () => {
    const result = assessRecovery(inputs({ demand: [{ flag: 'pdf_export', requests: 90 }] }), settings);
    // 90 requests in 180 s = 0.5 req/s; x 3.1 s = 1.6 executions; free = 10 x 0.6 - 2 = 4
    expect(result.ready).toBe(true);
    expect(result.demand[0]).toEqual({ flag: 'pdf_export', requestsPerSecond: 0.5, avgMs: 3100, executionsNeeded: 1.6 });
    expect(result.executionsAvailable).toBe(4);
  });

  it('is NOT ready when the service is healthy only because the flag is off (the spike is still going)', () => {
    // The real Phase 3 spike: about 6 PDF requests per second still arriving, degraded.
    const result = assessRecovery(inputs({ demand: [{ flag: 'pdf_export', requests: 1080 }] }), settings);
    expect(result.ready).toBe(false);
    expect(result.executionsNeeded).toBe(18.6);
    expect(result.reason).toContain('healthy, but only because the flag is off');
    expect(result.reason).toContain('about 18.6 executions and only 4 are free');
    expect(result.code).toBe('demand');
  });

  it('uses a stable code per rule, so the audit trail does not repeat "shed N min ago" every minute', () => {
    const early = { minutes: [minute(), minute(), minute()], shedAt: '2026-11-14T10:00:00Z' };
    const a = assessRecovery(inputs({ ...early, now: new Date('2026-11-14T10:01:00Z') }), settings);
    const b = assessRecovery(inputs({ ...early, now: new Date('2026-11-14T10:02:00Z') }), settings);
    expect(a.reason).not.toBe(b.reason);
    expect([a.code, b.code]).toEqual(['settling', 'settling']);
  });

  it('says plainly when no traffic is waiting on the disabled flag', () => {
    const result = assessRecovery(inputs({ demand: [{ flag: 'pdf_export', requests: 0 }] }), settings);
    expect(result.ready).toBe(true);
    expect(result.reason).toContain('no traffic is waiting on the disabled flags');
  });

  it('waits while there is still throttling', () => {
    const result = assessRecovery(inputs({ minutes: [minute(), minute({ throttles: 12 }), minute()] }), settings);
    expect(result).toMatchObject({ ready: false, throttles: 12 });
    expect(result.reason).toContain('still throttling');
  });

  it('waits while latency is high', () => {
    const result = assessRecovery(inputs({ minutes: [minute(), minute({ apiLatencyP90Ms: 2400 }), minute()] }), settings);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain('p90 latency 2400 ms');
  });

  it('waits until enough time has passed since shedding', () => {
    const result = assessRecovery(inputs({ shedAt: '2026-11-14T10:28:00Z' }), settings);
    expect(result.reason).toMatch(/^shed 2 min ago/);
  });

  it('waits when metric minutes are missing, instead of assuming health', () => {
    expect(assessRecovery(inputs({ minutes: [minute()] }), settings).reason).toBe('not enough metric data yet');
  });

  it('treats a quiet minute (no traffic, no latency data) as healthy', () => {
    const quiet = minute({ invocations: null, throttles: null, apiLatencyP90Ms: null, concurrencyMax: null });
    expect(assessRecovery(inputs({ minutes: [quiet, quiet, quiet], peakConcurrency: 0 }), settings).ready).toBe(true);
  });

  it('waits when active traffic is missing latency telemetry', () => {
    const missingLatency = minute({ invocations: 40, throttles: 0, apiLatencyP90Ms: null, concurrencyMax: 1 });
    const result = assessRecovery(inputs({ minutes: [missingLatency, missingLatency, missingLatency], peakConcurrency: 1 }), settings);
    expect(result.ready).toBe(false);
    expect(result.code).toBe('no-data');
  });

  it('respects the cooldown after "Keep disabled"', () => {
    const kept = assessRecovery(inputs({ keptDisabledAt: '2026-11-14T10:25:00Z' }), settings);
    expect(kept.ready).toBe(false);
    expect(kept.reason).toContain('next check after 10:35 UTC');
    expect(assessRecovery(inputs({ keptDisabledAt: '2026-11-14T10:15:00Z' }), settings).ready).toBe(true);
  });

  it('assumes an unknown feature is expensive, to stay safe', () => {
    const result = assessRecovery(inputs({ demand: [{ flag: 'mystery', requests: 180 }], featureAvgMs: {} }), settings);
    expect(result.demand[0].avgMs).toBe(3000);
    expect(result.executionsNeeded).toBe(3);
  });
});
