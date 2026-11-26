import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySlackRequest } from '../agent/lib/slackVerify';

const secret = '8f742231b10e8888abcd99yyyzzz85a5';
const body = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
const now = 1_794_580_000;
const sign = (ts: string, b = body, s = secret) => 'v0=' + createHmac('sha256', s).update(`v0:${ts}:${b}`).digest('hex');

describe('Slack request verification', () => {
  it('accepts a correctly signed, fresh request', () => {
    expect(verifySlackRequest({ signingSecret: secret, timestamp: String(now), signature: sign(String(now)), rawBody: body, nowSeconds: now })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const result = verifySlackRequest({ signingSecret: secret, timestamp: String(now), signature: sign(String(now)), rawBody: body + 'x', nowSeconds: now });
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a signature made with another secret', () => {
    const result = verifySlackRequest({ signingSecret: secret, timestamp: String(now), signature: sign(String(now), body, 'wrong'), rawBody: body, nowSeconds: now });
    expect(result.ok).toBe(false);
  });

  it('rejects a replay older than 5 minutes, even with a valid signature', () => {
    const old = String(now - 301);
    const result = verifySlackRequest({ signingSecret: secret, timestamp: old, signature: sign(old), rawBody: body, nowSeconds: now });
    expect(result).toEqual({ ok: false, reason: 'timestamp too old or invalid (possible replay)' });
  });

  it('rejects missing headers and malformed signatures without throwing', () => {
    expect(verifySlackRequest({ signingSecret: secret, timestamp: undefined, signature: undefined, rawBody: body, nowSeconds: now }).ok).toBe(false);
    expect(verifySlackRequest({ signingSecret: secret, timestamp: String(now), signature: 'v0=short', rawBody: body, nowSeconds: now }).ok).toBe(false);
    expect(verifySlackRequest({ signingSecret: secret, timestamp: 'abc', signature: sign('abc'), rawBody: body, nowSeconds: now }).ok).toBe(false);
  });
});
