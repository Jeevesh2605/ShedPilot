/**
 * Gathers the measured evidence for an incident:
 * - CloudWatch metrics (GetMetricData) for the reports-api Lambda and its HTTP API;
 * - a CloudWatch Logs Insights query over the structured request logs, which tells us how much
 *   compute each flagged feature used.
 *
 * Note the blind spot: a throttled request never reaches the Lambda, so it leaves no log line.
 * Metrics tell us how much was rejected; logs tell us what the served requests spent time on.
 */
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery, type MetricDataResult } from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  type ResultField,
} from '@aws-sdk/client-cloudwatch-logs';
import type { FeatureCost, LogsEvidence, MetricsEvidence, MinuteMetrics } from './types';

export interface Target {
  region: string;
  functionName: string;
  apiId: string;
  logGroup: string;
}

// ---- metrics ---------------------------------------------------------------------------------

/**
 * The metric queries, by id, all per minute. Percentiles can't be combined across minutes,
 * so for latency we report the worst minute rather than pretending to have a window-wide value.
 */
function metricQueries(target: Target): MetricDataQuery[] {
  const lambda = (id: string, metric: string, stat: string, period = 60): MetricDataQuery => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/Lambda', MetricName: metric, Dimensions: [{ Name: 'FunctionName', Value: target.functionName }] },
      Period: period,
      Stat: stat,
    },
  });
  const api = (id: string, metric: string, stat: string, period = 60): MetricDataQuery => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/ApiGateway', MetricName: metric, Dimensions: [{ Name: 'ApiId', Value: target.apiId }] },
      Period: period,
      Stat: stat,
    },
  });
  return [
    lambda('invocations', 'Invocations', 'Sum'),
    lambda('throttles', 'Throttles', 'Sum'),
    lambda('errors', 'Errors', 'Sum'),
    lambda('concurrency', 'ConcurrentExecutions', 'Maximum'),
    api('latencyp90', 'Latency', 'p90'),
    api('latencyp50', 'Latency', 'p50'),
    api('api5xx', '5xx', 'Sum'),
    lambda('durationp90', 'Duration', 'p90'),
  ];
}

export async function gatherMetrics(target: Target, start: Date, end: Date): Promise<MetricsEvidence> {
  const client = new CloudWatchClient({ region: target.region });
  const series = new Map<string, Map<string, number>>();
  const queries = metricQueries(target);
  let nextToken: string | undefined;

  for (let page = 0; page < 5; page++) {
    const result = await client.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: queries,
        ScanBy: 'TimestampAscending',
        NextToken: nextToken,
      }),
    );
    mergeMetricResults(series, result.MetricDataResults ?? []);
    nextToken = result.NextToken;
    if (!nextToken) break;
  }
  return summariseMetrics(series, start, end);
}

/** Pure: validates per-metric statuses and merges pages into series. Exported for tests. */
export function mergeMetricResults(series: Map<string, Map<string, number>>, results: MetricDataResult[]): void {
  for (const r of results) {
    if (r.StatusCode === 'InternalError' || r.StatusCode === 'Forbidden') {
      const detail = r.Messages?.map((m) => m.Value).filter(Boolean).join('; ');
      throw new Error(`CloudWatch GetMetricData failed for ${r.Id ?? 'metric'}: ${r.StatusCode}${detail ? ` (${detail})` : ''}`);
    }
    let points = series.get(r.Id ?? '');
    if (!points) {
      points = new Map<string, number>();
      series.set(r.Id ?? '', points);
    }
    (r.Timestamps ?? []).forEach((t, i) => points.set(t.toISOString(), r.Values?.[i] ?? 0));
  }
}

/** Pure: turns raw series into per-minute rows and totals. Exported for tests. */
export function summariseMetrics(series: Map<string, Map<string, number>>, start: Date, end: Date): MetricsEvidence {
  const get = (id: string, minute: string) => series.get(id)?.get(minute) ?? null;
  const sum = (id: string) => [...(series.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const max = (id: string) => Math.max(0, ...(series.get(id)?.values() ?? []));
  const worst = (id: string) => {
    const values = [...(series.get(id)?.values() ?? [])];
    return values.length ? Math.round(Math.max(...values)) : null;
  };

  const perMinute: MinuteMetrics[] = [];
  for (let t = Math.floor(start.getTime() / 60_000) * 60_000; t < end.getTime(); t += 60_000) {
    const minute = new Date(t).toISOString();
    const latency = get('latencyp90', minute);
    perMinute.push({
      minute,
      invocations: get('invocations', minute),
      throttles: get('throttles', minute),
      errors: get('errors', minute),
      concurrencyMax: get('concurrency', minute),
      apiLatencyP90Ms: latency === null ? null : Math.round(latency),
      api5xx: get('api5xx', minute),
    });
  }

  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    perMinute,
    totals: {
      invocations: sum('invocations'),
      throttles: sum('throttles'),
      errors: sum('errors'),
      api5xx: sum('api5xx'),
      peakConcurrency: max('concurrency'),
      worstMinuteApiLatencyP50Ms: worst('latencyp50'),
      worstMinuteApiLatencyP90Ms: worst('latencyp90'),
      worstMinuteLambdaDurationP90Ms: worst('durationp90'),
    },
  };
}

// ---- logs ------------------------------------------------------------------------------------

/** Flag names go into the query text, so only plain names are allowed. */
const SAFE_FLAG_NAME = /^[A-Za-z0-9_]+$/;

/**
 * Pure: builds one Logs Insights query that measures every flag at once. Exported for tests.
 * For each flag it computes how many requests ran the flag's code and how long that code took.
 */
export function buildFeatureQuery(flagNames: string[]): string {
  const stats = ['count(*) as served_requests', 'sum(duration_ms) as total_duration_ms'];
  for (const flag of flagNames.filter((f) => SAFE_FLAG_NAME.test(f))) {
    const field = `feature_timings_ms.${flag}`;
    stats.push(
      `count(${field}) as ${flag}__count`,
      `sum(${field}) as ${flag}__sum`,
      `avg(${field}) as ${flag}__avg`,
      `pct(${field}, 90) as ${flag}__p90`,
    );
  }
  return `filter type = "request"\n| stats ${stats.join(',\n  ')}`;
}

/** Pure: turns the single result row into per-feature costs. Exported for tests. */
export function parseFeatureRow(row: ResultField[], flagNames: string[], windowMs: number): LogsEvidence {
  const values = new Map(row.map((f) => [f.field ?? '', Number(f.value ?? 0)]));
  const num = (key: string) => (Number.isFinite(values.get(key)) ? (values.get(key) as number) : 0);

  const totalDurationMs = num('total_duration_ms');
  const features: FeatureCost[] = flagNames
    .filter((f) => SAFE_FLAG_NAME.test(f))
    .map((flag) => {
      const totalMs = num(`${flag}__sum`);
      return {
        flag,
        requests: num(`${flag}__count`),
        avgMs: Math.round(num(`${flag}__avg`)),
        p90Ms: Math.round(num(`${flag}__p90`)),
        totalMs: Math.round(totalMs),
        computeShare: totalDurationMs > 0 ? round(totalMs / totalDurationMs, 3) : 0,
        avgConcurrency: windowMs > 0 ? round(totalMs / windowMs, 2) : 0,
      };
    })
    .filter((f) => f.requests > 0)
    .sort((a, b) => b.totalMs - a.totalMs);

  return { servedRequests: num('served_requests'), totalDurationMs: Math.round(totalDurationMs), features };
}

export async function gatherFeatureCosts(target: Target, flagNames: string[], start: Date, end: Date): Promise<LogsEvidence> {
  const row = await runInsightsQuery(target, buildFeatureQuery(flagNames), start, end);
  return parseFeatureRow(row, flagNames, end.getTime() - start.getTime());
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---- demand on degraded routes (recovery) -----------------------------------------------------

/**
 * Pure: counts requests that reached each shed feature's code path while it was OFF.
 * In the logs a false flag value reads as 0, so "= 0" counts the degraded requests: the demand
 * that would come back if the flag were turned on again. Exported for tests.
 */
export function buildDemandQuery(flagNames: string[]): string {
  const stats = ['count(*) as served_requests'];
  for (const flag of flagNames.filter((f) => SAFE_FLAG_NAME.test(f))) {
    stats.push(`sum(features_evaluated.${flag} = 0) as ${flag}__off`);
  }
  return `filter type = "request"\n| stats ${stats.join(',\n  ')}`;
}

/** Pure: the demand row as { flag, requests }. Exported for tests. */
export function parseDemandRow(row: ResultField[], flagNames: string[]): { flag: string; requests: number }[] {
  const values = new Map(row.map((f) => [f.field ?? '', Number(f.value ?? 0)]));
  return flagNames
    .filter((f) => SAFE_FLAG_NAME.test(f))
    .map((flag) => ({ flag, requests: Number.isFinite(values.get(`${flag}__off`)) ? (values.get(`${flag}__off`) as number) : 0 }));
}

export async function gatherDemand(target: Target, flagNames: string[], start: Date, end: Date) {
  const row = await runInsightsQuery(target, buildDemandQuery(flagNames), start, end);
  return parseDemandRow(row, flagNames);
}

/** Runs a Logs Insights query and returns its first result row (polling up to 30 s). */
async function runInsightsQuery(target: Target, queryString: string, start: Date, end: Date): Promise<ResultField[]> {
  const client = new CloudWatchLogsClient({ region: target.region });
  const { queryId } = await client.send(
    new StartQueryCommand({
      logGroupName: target.logGroup,
      startTime: Math.floor(start.getTime() / 1000),
      endTime: Math.ceil(end.getTime() / 1000),
      queryString,
    }),
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await client.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === 'Complete') return result.results?.[0] ?? [];
    if (result.status === 'Failed' || result.status === 'Cancelled' || result.status === 'Timeout') {
      throw new Error(`Logs Insights query ${result.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000)); // polling an AWS API, not simulating load
  }
  throw new Error('Logs Insights query did not finish within 30 s');
}
