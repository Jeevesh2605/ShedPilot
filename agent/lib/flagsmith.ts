/**
 * Small client for the Flagsmith Admin (Management) API.
 *
 * Every endpoint here was checked against Flagsmith's OpenAPI spec
 * (https://api.flagsmith.com/api/v1/swagger.json); see docs/ARCHITECTURE.md, section 2.3.
 * Auth is an organisation API key sent as "Authorization: Api-Key <key>".
 *
 * Phase 1 uses only the read and setup calls. The flag-changing call is added in Phase 3,
 * and only the executor Lambda will use it.
 */
import type { FlagChangeResult, FlagInfo } from './types';

export interface FlagsmithAdminConfig {
  apiKey: string;
  /** API host without a path. Defaults to Flagsmith SaaS. */
  host?: string;
  /** Maximum retries on transient GET/PATCH failures (429, 5xx, network). Defaults to 2. */
  maxRetries?: number;
  /** Base backoff delay in ms between retries. Defaults to 400. */
  retryDelayMs?: number;
}

export interface FlagsmithEnvironment {
  id: number;
  name: string;
  api_key: string;
  project: number;
  use_v2_feature_versioning: boolean;
  minimum_change_request_approvals: number | null;
}

export interface FlagsmithTag {
  id: number;
  label: string;
  color: string;
  description: string | null;
}

/** A feature as returned by GET /projects/{id}/features/?environment={id}. */
export interface FlagsmithFeature {
  id: number;
  name: string;
  description: string | null;
  tags: number[]; // tag IDs, not labels
  is_archived: boolean;
  default_enabled: boolean;
  environment_feature_state: { id: number; enabled: boolean } | null;
}

/** Response of the experimental "update flag" endpoint (GET or PATCH). */
export interface FlagState {
  environment_default: { enabled: boolean; value: unknown; variants: unknown[] };
  segment_overrides: unknown[];
}

/** Response of the v1 environment featurestates endpoint (GET or PATCH). */
export interface V1FeatureState {
  id: number;
  enabled: boolean;
  feature: number;
  environment: number;
}

interface Page<T> {
  count: number;
  next: string | null;
  results: T[];
}

export class FlagsmithApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Flagsmith ${method} ${path} failed with HTTP ${status}: ${responseBody.slice(0, 300)}`);
  }
}

export class FlagsmithAdmin {
  private readonly host: string;

  constructor(private readonly config: FlagsmithAdminConfig) {
    const rawHost = config.host?.trim();
    this.host = (rawHost ? rawHost : 'https://api.flagsmith.com').replace(/\/+$/, '');
  }

  // ---- reads -------------------------------------------------------------------------------

  listProjects() {
    return this.listAll<{ id: number; name: string }>('/api/v1/projects/');
  }

  listEnvironments(projectId: number) {
    return this.listAll<FlagsmithEnvironment>(`/api/v1/environments/?project=${projectId}`);
  }

  listTags(projectId: number) {
    return this.listAll<FlagsmithTag>(`/api/v1/projects/${projectId}/tags/`);
  }

  /** All features in the project, each with its live state in the given environment. */
  listFeatures(projectId: number, environmentId: number) {
    return this.listAll<FlagsmithFeature>(
      `/api/v1/projects/${projectId}/features/?environment=${environmentId}&page_size=100`,
    );
  }

  /** Reads what a flag serves in an environment (experimental endpoint, see ARCHITECTURE 2.3). */
  getFlagState(environmentKey: string, featureId: number) {
    return this.request<FlagState>('GET', `/api/__future__/environments/${environmentKey}/features/${featureId}/`);
  }

  /** Reads a feature state on a v1-versioned environment. */
  getV1FeatureState(environmentKey: string, featureStateId: number) {
    return this.request<V1FeatureState>('GET', `/api/v1/environments/${environmentKey}/featurestates/${featureStateId}/`);
  }

  // ---- the one flag-changing call (used only by the executor, after human approval) ---------

  /**
   * Turns a flag on or off in an environment. Uses the "update flag" endpoint, which works on
   * environments with Feature Versioning v2 (ours on Cloud has it on; the legacy featurestates write
   * returns 400 there). PATCH leaves the flag's value and segment overrides unchanged.
   * The environment is addressed by its string api_key: Phase 1 showed the numeric ID returns 404.
   */
  setFlagEnabled(environmentKey: string, featureId: number, enabled: boolean) {
    return this.request<FlagState>('PATCH', `/api/__future__/environments/${environmentKey}/features/${featureId}/`, {
      environment_default: { enabled },
    });
  }

  /** Turns a flag on or off on a v1-versioned environment (common on fresh self-hosted installs). */
  setV1FeatureStateEnabled(environmentKey: string, featureStateId: number, enabled: boolean) {
    return this.request<V1FeatureState>('PATCH', `/api/v1/environments/${environmentKey}/featurestates/${featureStateId}/`, {
      enabled,
    });
  }

  // ---- setup writes (used only by scripts/seed-flags.ts) -----------------------------------

  createTag(projectId: number, tag: { label: string; color: string; description: string }) {
    return this.request<FlagsmithTag>('POST', `/api/v1/projects/${projectId}/tags/`, tag);
  }

  createFeature(
    projectId: number,
    feature: { name: string; description: string; default_enabled: boolean; tags: number[] },
  ) {
    return this.request<FlagsmithFeature>('POST', `/api/v1/projects/${projectId}/features/`, feature);
  }

  setFeatureTags(projectId: number, featureId: number, tagIds: number[]) {
    return this.request<FlagsmithFeature>('PATCH', `/api/v1/projects/${projectId}/features/${featureId}/`, {
      tags: tagIds,
    });
  }

  // ---- plumbing ----------------------------------------------------------------------------

  private async listAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;
    while (next) {
      const page: Page<T> = await this.request<Page<T>>('GET', next);
      items.push(...page.results);
      next = page.next; // Flagsmith returns an absolute URL here
    }
    return items;
  }

  private async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.host + pathOrUrl;
    const retryableMethod = method === 'GET' || method === 'PATCH';
    const maxAttempts = retryableMethod ? 1 + (this.config.maxRetries ?? 2) : 1;
    const baseDelayMs = this.config.retryDelayMs ?? 400;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Api-Key ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        if (response.ok) return (text ? JSON.parse(text) : undefined) as T;

        if (attempt < maxAttempts && isTransientHttpStatus(response.status)) {
          await sleep(retryDelay(response.headers.get('retry-after'), baseDelayMs, attempt));
          continue;
        }
        throw new FlagsmithApiError(method, new URL(url).pathname, response.status, text);
      } catch (err) {
        if (err instanceof FlagsmithApiError || attempt >= maxAttempts) throw err;
        await sleep(baseDelayMs * attempt);
      }
    }
    throw new Error(`Flagsmith ${method} ${pathOrUrl} failed after ${maxAttempts} attempts`);
  }
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(retryAfterHeader: string | null, baseDelayMs: number, attempt: number): number {
  const seconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 3000);
  return baseDelayMs * attempt;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// ---- inventory for the investigator ------------------------------------------------------------


/**
 * Everything the investigator needs to know about the flags, in three Admin API calls:
 * the environment (to get its numeric ID), the tags (to turn tag IDs into labels),
 * and the features with their live state in that environment. Archived features are left out.
 */
export async function getFlagInventory(
  admin: FlagsmithAdmin,
  projectId: number,
  environmentKey: string,
): Promise<{ environment: FlagsmithEnvironment; flags: FlagInfo[] }> {
  const environment = (await admin.listEnvironments(projectId)).find((e) => e.api_key === environmentKey);
  if (!environment) throw new Error(`Flagsmith environment ${environmentKey} not found in project ${projectId}`);

  const [tags, features] = await Promise.all([admin.listTags(projectId), admin.listFeatures(projectId, environment.id)]);
  const tagLabel = new Map(tags.map((t) => [t.id, t.label]));

  const flags = features
    .filter((f) => !f.is_archived)
    .map((f) => ({
      name: f.name,
      id: f.id,
      featureStateId: f.environment_feature_state?.id,
      enabled: f.environment_feature_state?.enabled ?? f.default_enabled,
      tags: f.tags.map((id) => tagLabel.get(id)).filter((label): label is string => Boolean(label)),
      description: f.description,
    }));
  return { environment, flags };
}

/**
 * Turns a flag on or off and reads it back to confirm. Supports both Feature Versioning v2
 * (__future__ endpoint) and v1 (featurestates endpoint, default on fresh self-hosted Flagsmith).
 * If PATCH throws after Flagsmith applied the change (e.g. timeout/reset), one follow-up GET
 * reconciles the real state so shedFlags never loses track of a changed flag; if both fail,
 * unknownState is marked for human follow-up.
 */
export async function setAndVerifyFlag(
  admin: Pick<FlagsmithAdmin, 'setFlagEnabled' | 'getFlagState'> &
    Partial<Pick<FlagsmithAdmin, 'setV1FeatureStateEnabled' | 'getV1FeatureState'>>,
  environmentKey: string,
  flag: string,
  featureId: number,
  enabled: boolean,
  options: { useV2?: boolean; featureStateId?: number } = {},
): Promise<FlagChangeResult> {
  const useV1 = options.useV2 === false;
  if (useV1 && options.featureStateId === undefined) {
    return {
      flag,
      featureId,
      ok: false,
      dryRun: false,
      error: 'missing environment_feature_state id for v1 environment',
    };
  }

  const writeState = async (): Promise<boolean> => {
    if (useV1) {
      if (!admin.setV1FeatureStateEnabled) throw new Error('v1 write method unavailable');
      const res = await admin.setV1FeatureStateEnabled(environmentKey, options.featureStateId!, enabled);
      return res.enabled;
    }
    const res = await admin.setFlagEnabled(environmentKey, featureId, enabled);
    return res.environment_default.enabled;
  };

  const readState = async (): Promise<boolean> => {
    if (useV1) {
      if (!admin.getV1FeatureState) throw new Error('v1 read method unavailable');
      const res = await admin.getV1FeatureState(environmentKey, options.featureStateId!);
      return res.enabled;
    }
    const res = await admin.getFlagState(environmentKey, featureId);
    return res.environment_default.enabled;
  };

  let patchedEnabled: boolean;
  try {
    patchedEnabled = await writeState();
  } catch (patchErr) {
    const patchMsg = patchErr instanceof Error ? patchErr.message : String(patchErr);
    try {
      const actualEnabled = await readState();
      if (actualEnabled === enabled) {
        return {
          flag,
          featureId,
          ok: true,
          dryRun: false,
          enabledAfter: actualEnabled,
          unverified: true,
          error: `write call failed (${patchMsg}), but read-back confirmed flag is ${enabled ? 'on' : 'off'}`,
        };
      }
      return { flag, featureId, ok: false, dryRun: false, enabledAfter: actualEnabled, error: patchMsg };
    } catch (readErr) {
      const readMsg = readErr instanceof Error ? readErr.message : String(readErr);
      return {
        flag,
        featureId,
        ok: false,
        dryRun: false,
        unknownState: true,
        error: `write failed (${patchMsg}) and state check failed (${readMsg}); verify in Flagsmith`,
      };
    }
  }

  try {
    const actualEnabled = await readState();
    const ok = actualEnabled === enabled;
    return {
      flag,
      featureId,
      ok,
      dryRun: false,
      enabledAfter: actualEnabled,
      error: ok ? undefined : `still ${enabled ? 'off' : 'on'} when read back`,
    };
  } catch (verifyErr) {
    const verifyMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    return {
      flag,
      featureId,
      ok: patchedEnabled === enabled,
      dryRun: false,
      enabledAfter: patchedEnabled,
      unverified: true,
      error: `read-back verification failed: ${verifyMsg}`,
    };
  }
}
