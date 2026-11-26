/**
 * Open-loop load test for reports-api.
 *
 *   npm run load:baseline   about 2 req/s of mixed traffic for 60 s   (about 120 requests)
 *   npm run load:spike      about 8 req/s, mostly PDF, for 180 s      (about 1,440 requests)
 *   npm run load:demo       the spike, but for 300 s                  (about 2,400 requests)
 *                           long enough to see the proposal, the approval and the recovery in one run
 *
 * "Open loop" means users arrive at random times at a fixed average rate, whether or not the
 * server keeps up, like real traffic. The gaps between arrivals are random (a Poisson process),
 * so requests don't fire in lockstep.
 *
 * Why not autocannon: its rate limiter fires every connection on the same tick, which sent bursts
 * of 20 simultaneous requests and caused throttling even when every request was fast. That was a
 * load-generator artifact, not a real overload. See docs/ARCHITECTURE.md, section 10.
 *
 * The only waiting here is client-side pacing of arrivals. The server never sleeps.
 * API URL: set API_URL in .env, or it is read from the "shedpilot" CloudFormation stack outputs.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

interface Profile {
  ratePerSecond: number; // average arrivals per second
  durationSeconds: number;
  maxInFlight: number; // safety cap on open requests from this machine
  mix: Record<string, number>; // path -> weight
}

const PROFILES: Record<string, Profile> = {
  baseline: {
    ratePerSecond: 2,
    durationSeconds: 60,
    maxInFlight: 20,
    mix: { '/api/reports?format=pdf': 10, '/api/reports?format=csv': 30, '/api/reports/summary': 30, '/api/checkout': 30 },
  },
  spike: {
    ratePerSecond: 8,
    durationSeconds: 180,
    maxInFlight: 40,
    mix: { '/api/reports?format=pdf': 75, '/api/reports?format=csv': 5, '/api/reports/summary': 10, '/api/checkout': 10 },
  },
};
// Same traffic as the spike, held long enough for the whole story to play out on camera.
PROFILES.demo = { ...PROFILES.spike, durationSeconds: 300 };

interface RouteStats { total: number; ok: number; degraded: number; failed: Record<string, number>; latencies: number[] }

function apiUrl(): string {
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (process.env.API_URL) return process.env.API_URL.replace(/\/+$/, '');
  // Use the region from samconfig.toml (where the stack was deployed), not whatever AWS_REGION says.
  const region = readFileSync('samconfig.toml', 'utf8').match(/^region\s*=\s*"([^"]+)"/m)?.[1] ?? 'ap-south-1';
  const out = execSync(
    `aws cloudformation describe-stacks --region ${region} --stack-name ${process.env.STACK_NAME ?? 'shedpilot'} --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text`,
    { encoding: 'utf8' },
  ).trim();
  if (!out.startsWith('https://')) throw new Error('Could not find ApiUrl. Set API_URL in .env.');
  return out;
}

/** Picks a path at random according to the profile's weights. */
function pickPath(mix: Record<string, number>): string {
  const entries = Object.entries(mix);
  let roll = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [path, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return path;
  }
  return entries[0][0];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const name = process.argv[2] ?? 'baseline';
  const profile = PROFILES[name];
  if (!profile) throw new Error(`Unknown profile "${name}". Use: ${Object.keys(PROFILES).join(', ')}`);
  // DURATION_SECONDS overrides the profile length, handy for a quick smoke test.
  if (process.env.DURATION_SECONDS) profile.durationSeconds = Number(process.env.DURATION_SECONDS);

  const base = apiUrl();
  const stats = new Map<string, RouteStats>();
  const statsFor = (path: string) => {
    let s = stats.get(path);
    if (!s) stats.set(path, (s = { total: 0, ok: 0, degraded: 0, failed: {}, latencies: [] }));
    return s;
  };

  async function sendOne(path: string): Promise<void> {
    const s = statsFor(path);
    const startedAt = performance.now();
    let outcome: string;
    try {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (response.ok) {
        outcome = body.includes('"degraded"') || body.includes('"analytics_status":"disabled"') ? 'degraded' : 'ok';
      } else {
        outcome = String(response.status);
      }
    } catch (err) {
      outcome = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network-error';
    }
    s.total++;
    s.latencies.push(Math.round(performance.now() - startedAt));
    if (outcome === 'ok') s.ok++;
    else if (outcome === 'degraded') s.degraded++;
    else s.failed[outcome] = (s.failed[outcome] ?? 0) + 1;
  }

  console.log(`Profile ${name}: about ${profile.ratePerSecond} req/s for ${profile.durationSeconds} s (random arrivals)`);
  console.log(`Target ${base}`);
  console.log(`Started ${new Date().toISOString()}\n`);

  const startedAt = Date.now();
  const endAt = startedAt + profile.durationSeconds * 1000;
  const inFlight = new Set<Promise<void>>();
  let sent = 0;
  let skipped = 0;
  let nextArrival = startedAt;
  let nextProgress = startedAt + 15_000;

  while (true) {
    // Random gap with the right average: an exponential distribution gives Poisson arrivals.
    nextArrival += (-Math.log(1 - Math.random()) * 1000) / profile.ratePerSecond;
    if (nextArrival >= endAt) break;
    await sleep(Math.max(0, nextArrival - Date.now()));

    if (inFlight.size >= profile.maxInFlight) {
      skipped++; // the client is saturated; don't pile up unlimited open requests
    } else {
      const request = sendOne(pickPath(profile.mix)).finally(() => inFlight.delete(request));
      inFlight.add(request);
      sent++;
    }

    if (Date.now() >= nextProgress) {
      const failed = [...stats.values()].reduce((n, s) => n + Object.values(s.failed).reduce((a, b) => a + b, 0), 0);
      console.log(`  ${Math.round((Date.now() - startedAt) / 1000)}s: sent ${sent}, failed ${failed}, open ${inFlight.size}`);
      nextProgress += 15_000;
    }
  }
  await Promise.all(inFlight);

  console.log(`\nFinished ${new Date().toISOString()}\n`);
  console.log('Route                       Total   OK  Degraded  Failed (by status)   p50 ms   p90 ms');
  for (const [path, s] of [...stats.entries()].sort()) {
    const failed = Object.entries(s.failed).map(([code, n]) => `${code}x${n}`).join(' ') || '-';
    console.log(
      `${path.padEnd(27)} ${String(s.total).padStart(5)} ${String(s.ok).padStart(4)} ${String(s.degraded).padStart(9)}  ${failed.padEnd(19)} ${String(percentile(s.latencies, 50)).padStart(7)} ${String(percentile(s.latencies, 90)).padStart(8)}`,
    );
  }
  console.log(`\nSent ${sent} requests${skipped ? `, skipped ${skipped} because ${profile.maxInFlight} were already open` : ''}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
