import { describe, expect, it } from 'vitest';
import { buildFeatureQuery, mergeMetricResults, parseFeatureRow, summariseMetrics } from '../agent/lib/cloudwatch';

describe('Logs Insights feature query', () => {
  it('measures every flag in one query', () => {
    const query = buildFeatureQuery(['pdf_export', 'rich_analytics']);
    expect(query).toContain('filter type = "request"');
    expect(query).toContain('sum(feature_timings_ms.pdf_export) as pdf_export__sum');
    expect(query).toContain('pct(feature_timings_ms.rich_analytics, 90) as rich_analytics__p90');
  });

  it('leaves out flag names that could change the query', () => {
    const query = buildFeatureQuery(['pdf_export', 'x) | display @message #', 'with space']);
    expect(query).toContain('pdf_export__sum');
    expect(query).not.toContain('display');
    expect(query).not.toContain('with space');
  });

  it('turns the result row into costs, sorted by total time, using real spike numbers', () => {
    const row = [
      { field: 'served_requests', value: '638' },
      { field: 'total_duration_ms', value: '1636550' },
      { field: 'pdf_export__count', value: '476' },
      { field: 'pdf_export__sum', value: '1549383' },
      { field: 'pdf_export__avg', value: '3255.0063' },
      { field: 'pdf_export__p90', value: '4327.7986' },
      { field: 'rich_analytics__count', value: '61' },
      { field: 'rich_analytics__sum', value: '59507' },
      { field: 'rich_analytics__avg', value: '975.5' },
      { field: 'rich_analytics__p90', value: '1152' },
      { field: 'basic_csv__count', value: '0' },
    ];
    const result = parseFeatureRow(row, ['rich_analytics', 'pdf_export', 'basic_csv'], 300_000);
    expect(result.servedRequests).toBe(638);
    expect(result.features.map((f) => f.flag)).toEqual(['pdf_export', 'rich_analytics']); // basic_csv had no requests
    expect(result.features[0]).toMatchObject({ requests: 476, avgMs: 3255, p90Ms: 4328, computeShare: 0.947, avgConcurrency: 5.16 });
  });

  it('copes with an empty result', () => {
    expect(parseFeatureRow([], ['pdf_export'], 300_000)).toEqual({ servedRequests: 0, totalDurationMs: 0, features: [] });
  });
});

describe('metric summary', () => {
  it('adds up counts, keeps the peak, and reports the worst minute for percentiles', () => {
    const m = (pairs: [string, number][]) => new Map(pairs);
    const series = new Map([
      ['throttles', m([['2026-11-12T09:24:00.000Z', 284], ['2026-11-12T09:25:00.000Z', 237]])],
      ['concurrency', m([['2026-11-12T09:24:00.000Z', 10], ['2026-11-12T09:25:00.000Z', 9]])],
      ['latencyp90', m([['2026-11-12T09:24:00.000Z', 3493.1], ['2026-11-12T09:25:00.000Z', 3617.7]])],
    ]);
    const result = summariseMetrics(series, new Date('2026-11-12T09:23:00Z'), new Date('2026-11-12T09:26:00Z'));
    expect(result.totals.throttles).toBe(521);
    expect(result.totals.peakConcurrency).toBe(10);
    expect(result.totals.worstMinuteApiLatencyP90Ms).toBe(3618);
    expect(result.totals.invocations).toBe(0);
    expect(result.perMinute).toHaveLength(3);
    expect(result.perMinute[0].throttles).toBeNull(); // 09:23 had no data
    expect(result.perMinute[1]).toMatchObject({ throttles: 284, apiLatencyP90Ms: 3493 });
  });

  it('rejects failed GetMetricData results and merges paginated PartialData results', () => {
    const series = new Map<string, Map<string, number>>();
    expect(() => mergeMetricResults(series, [{ Id: 'throttles', StatusCode: 'InternalError', Messages: [{ Value: 'boom' }] }]))
      .toThrow(/InternalError.*boom/);

    const t1 = new Date('2026-11-12T09:24:00.000Z');
    const t2 = new Date('2026-11-12T09:25:00.000Z');
    mergeMetricResults(series, [{ Id: 'throttles', StatusCode: 'PartialData', Timestamps: [t1], Values: [10] }]);
    mergeMetricResults(series, [{ Id: 'throttles', StatusCode: 'Complete', Timestamps: [t2], Values: [20] }]);
    expect(series.get('throttles')?.get(t1.toISOString())).toBe(10);
    expect(series.get('throttles')?.get(t2.toISOString())).toBe(20);
  });
});
