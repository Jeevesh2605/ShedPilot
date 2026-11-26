/**
 * Reads feature flags from Flagsmith with the server-side Node SDK.
 *
 * Why remote evaluation plus our own 5-second cache (see docs/ARCHITECTURE.md, section 2.2):
 * - a flag flip in Flagsmith reaches every warm Lambda container within 5 seconds;
 * - there is no background polling timer, which Lambda would freeze between invocations;
 * - it costs at most one Flags API call per container every 5 seconds.
 */
import { Flagsmith, DefaultFlag } from '@flagsmith/nodejs';
import { getSecret } from './secrets';

export const FLAG = {
  pdfExport: 'pdf_export',
  basicCsv: 'basic_csv',
  richAnalytics: 'rich_analytics',
  checkoutCore: 'checkout_core',
} as const;

export type FlagName = (typeof FLAG)[keyof typeof FLAG];
const ALL_FLAGS = Object.values(FLAG);

/**
 * Values used when Flagsmith cannot be reached. They fail safe:
 * expensive optional features are off, so a Flagsmith outage can never add load,
 * and the core checkout path stays on.
 */
const FAIL_SAFE_DEFAULTS: Record<FlagName, boolean> = {
  pdf_export: false,
  basic_csv: true,
  rich_analytics: false,
  checkout_core: true,
};

const CACHE_TTL_MS = 5_000;

export interface FlagSnapshot {
  enabled: Record<FlagName, boolean>;
  /** "flagsmith" when the values came from the API, "fallback" when any flag used the fail-safe default. */
  source: 'flagsmith' | 'fallback';
}

let client: Flagsmith | undefined;
let cache: { snapshot: FlagSnapshot; fetchedAt: number } | undefined;

async function getClient(): Promise<Flagsmith> {
  if (!client) {
    const environmentKey = await getSecret('FLAGSMITH_SERVER_KEY', 'FLAGSMITH_SERVER_KEY_PARAM');
    client = new Flagsmith({
      environmentKey,
      // Keep a Flagsmith outage from making our requests slow: fail fast, then use the defaults.
      requestTimeoutSeconds: 2,
      retries: 1,
      defaultFlagHandler: (name: string) =>
        new DefaultFlag(null, FAIL_SAFE_DEFAULTS[name as FlagName] ?? false),
    });
  }
  return client;
}

export async function getFlagSnapshot(now = Date.now()): Promise<FlagSnapshot> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const flags = await (await getClient()).getEnvironmentFlags();
  const enabled = {} as Record<FlagName, boolean>;
  let usedFallback = false;
  for (const name of ALL_FLAGS) {
    const flag = flags.getFlag(name);
    enabled[name] = flag.enabled;
    if (flag.isDefault) usedFallback = true;
  }

  const snapshot: FlagSnapshot = { enabled, source: usedFallback ? 'fallback' : 'flagsmith' };
  cache = { snapshot, fetchedAt: now };
  return snapshot;
}
