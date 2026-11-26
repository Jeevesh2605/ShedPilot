/**
 * Collects facts about one request and writes them as a single JSON log line.
 * The investigator's Logs Insights query reads these fields, so their names are a contract.
 */
import type { FlagName } from './flags';

export class RequestLog {
  private readonly startedAt = performance.now();
  readonly featuresEvaluated: Partial<Record<FlagName, boolean>> = {};
  readonly featureTimingsMs: Partial<Record<FlagName, number>> = {};
  flagsSource: string | undefined;

  constructor(
    readonly requestId: string,
    readonly route: string,
    readonly format: string | null,
  ) {}

  /** Records that a flag was checked for this request and what it said. */
  evaluated(flag: FlagName, enabled: boolean): boolean {
    this.featuresEvaluated[flag] = enabled;
    return enabled;
  }

  /** Runs the code behind a flag and records how long it took. */
  async timeFeature<T>(flag: FlagName, work: () => T | Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await work();
    } finally {
      this.featureTimingsMs[flag] = Math.round(performance.now() - start);
    }
  }

  write(status: number, error?: string): void {
    const line = {
      type: 'request',
      request_id: this.requestId,
      route: this.route,
      format: this.format,
      features_evaluated: this.featuresEvaluated,
      feature_timings_ms: this.featureTimingsMs,
      duration_ms: Math.round(performance.now() - this.startedAt),
      status,
      flags_source: this.flagsSource,
      ...(error ? { error } : {}),
    };
    // One line of JSON on stdout becomes one CloudWatch Logs event.
    process.stdout.write(JSON.stringify(line) + '\n');
  }
}
