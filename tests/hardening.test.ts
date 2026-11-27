import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlagsmithAdmin, FlagsmithApiError, setAndVerifyFlag } from '../agent/lib/flagsmith';
import { callSlack } from '../agent/lib/slack';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('FlagsmithAdmin retries', () => {
  it('retries transient 503 responses on idempotent GET and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 1, next: null, results: [{ id: 1, name: 'proj' }] }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const admin = new FlagsmithAdmin({ apiKey: 'test-key', maxRetries: 2, retryDelayMs: 0 });
    const projects = await admin.listProjects();

    expect(projects).toEqual([{ id: 1, name: 'proj' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries 429 on idempotent PATCH setFlagEnabled and succeeds', async () => {
    const state = { environment_default: { enabled: false, value: null, variants: [] }, segment_overrides: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(state), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const admin = new FlagsmithAdmin({ apiKey: 'test-key', maxRetries: 2, retryDelayMs: 0 });
    const result = await admin.setFlagEnabled('env-key', 42, false);

    expect(result.environment_default.enabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient 404 errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const admin = new FlagsmithAdmin({ apiKey: 'test-key', maxRetries: 2, retryDelayMs: 0 });
    await expect(admin.getFlagState('bad-key', 42)).rejects.toBeInstanceOf(FlagsmithApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry POST requests even on 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const admin = new FlagsmithAdmin({ apiKey: 'test-key', maxRetries: 2, retryDelayMs: 0 });
    await expect(admin.createTag(1, { label: 't', color: '#000', description: 'd' })).rejects.toBeInstanceOf(FlagsmithApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Slack client retries and error handling', () => {
  it('retries transient HTTP 503 and succeeds when Slack recovers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>503</html>', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '123.45' }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const res = await callSlack('chat.postMessage', { channel: 'C1', text: 'hi' }, 'xoxb-test', { maxRetries: 2, retryDelayMs: 0 });
    expect(res.ts).toBe('123.45');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a clear HTTP error when Slack returns non-JSON 502 after retries', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      callSlack('chat.postMessage', { channel: 'C1', text: 'hi' }, 'xoxb-test', { maxRetries: 1, retryDelayMs: 0 }),
    ).rejects.toThrow(/Slack chat\.postMessage HTTP 502/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry logical ok:false Slack errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      callSlack('chat.postMessage', { channel: 'C1', text: 'hi' }, 'xoxb-test', { maxRetries: 2, retryDelayMs: 0 }),
    ).rejects.toThrow('Slack chat.postMessage failed: channel_not_found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when Slack Retry-After exceeds retry budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      callSlack('chat.postMessage', { channel: 'C1', text: 'hi' }, 'xoxb-test', { maxRetries: 2, retryDelayMs: 0 }),
    ).rejects.toThrow(/Retry-After 60s exceeds retry budget/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('setAndVerifyFlag reconciliation', () => {
  const flagState = (enabled: boolean) => ({
    environment_default: { enabled, value: null, variants: [] },
    segment_overrides: [],
  });

  it('reconciles a PATCH failure when follow-up GET confirms the flag changed', async () => {
    const result = await setAndVerifyFlag(
      {
        setFlagEnabled: async () => { throw new Error('socket timeout'); },
        getFlagState: async () => flagState(false),
      },
      'env-key',
      'pdf_export',
      1,
      false,
    );
    expect(result).toMatchObject({ flag: 'pdf_export', ok: true, unverified: true, enabledAfter: false });
    expect(result.unknownState).toBeUndefined();
  });

  it('returns ok:false without unknownState when PATCH failed and GET confirms flag is still unchanged', async () => {
    const result = await setAndVerifyFlag(
      {
        setFlagEnabled: async () => { throw new Error('HTTP 500'); },
        getFlagState: async () => flagState(true),
      },
      'env-key',
      'pdf_export',
      1,
      false,
    );
    expect(result).toMatchObject({ flag: 'pdf_export', ok: false, enabledAfter: true });
    expect(result.unknownState).toBeUndefined();
  });

  it('marks unknownState when both PATCH and follow-up GET fail', async () => {
    const result = await setAndVerifyFlag(
      {
        setFlagEnabled: async () => { throw new Error('reset'); },
        getFlagState: async () => { throw new Error('unreachable'); },
      },
      'env-key',
      'pdf_export',
      1,
      false,
    );
    expect(result).toMatchObject({ flag: 'pdf_export', ok: false, unknownState: true });
    expect(result.error).toContain('verify in Flagsmith');
  });

  it('uses v1 featurestates endpoints when useV2 is false and reconciles failed PATCH', async () => {
    const v1State = (enabled: boolean) => ({ id: 77, enabled, feature: 1, environment: 2 });
    let patched = false;
    const okResult = await setAndVerifyFlag(
      {
        setFlagEnabled: async () => { throw new Error('should not call v2'); },
        getFlagState: async () => { throw new Error('should not call v2'); },
        setV1FeatureStateEnabled: async (_env, stateId, enabled) => {
          expect(stateId).toBe(77);
          patched = true;
          return v1State(enabled);
        },
        getV1FeatureState: async (_env, stateId) => {
          expect(stateId).toBe(77);
          return v1State(false);
        },
      },
      'env-key',
      'pdf_export',
      1,
      false,
      { useV2: false, featureStateId: 77 },
    );
    expect(patched).toBe(true);
    expect(okResult).toMatchObject({ flag: 'pdf_export', ok: true, enabledAfter: false });

    const reconciled = await setAndVerifyFlag(
      {
        setFlagEnabled: async () => { throw new Error('should not call v2'); },
        getFlagState: async () => { throw new Error('should not call v2'); },
        setV1FeatureStateEnabled: async () => { throw new Error('timeout'); },
        getV1FeatureState: async () => v1State(false),
      },
      'env-key',
      'pdf_export',
      1,
      false,
      { useV2: false, featureStateId: 77 },
    );
    expect(reconciled).toMatchObject({ flag: 'pdf_export', ok: true, unverified: true, enabledAfter: false });

    const missingId = await setAndVerifyFlag(
      {
        setFlagEnabled: async () => { throw new Error('should not call v2'); },
        getFlagState: async () => { throw new Error('should not call v2'); },
      },
      'env-key',
      'pdf_export',
      1,
      false,
      { useV2: false },
    );
    expect(missingId).toMatchObject({ flag: 'pdf_export', ok: false });
    expect(missingId.error).toContain('feature_state');
  });

  it('defaults blank host to Flagsmith Cloud and trims trailing slashes on custom host', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ count: 0, next: null, results: [] }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await new FlagsmithAdmin({ apiKey: 'k', host: '   ' }).listProjects();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.flagsmith.com/api/v1/projects/');

    await new FlagsmithAdmin({ apiKey: 'k', host: 'https://flags.example.com///' }).listProjects();
    expect(fetchMock.mock.calls[1][0]).toBe('https://flags.example.com/api/v1/projects/');
  });
});
