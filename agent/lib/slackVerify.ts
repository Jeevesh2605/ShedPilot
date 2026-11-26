/**
 * Verifies that a request really came from Slack.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 *   signature = "v0=" + hex(HMAC_SHA256(signing_secret, "v0:" + timestamp + ":" + raw_body))
 *
 * The timestamp check stops someone replaying an old, validly signed request.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_REQUEST_AGE_SECONDS = 300;

export interface VerifyInput {
  signingSecret: string;
  timestamp: string | undefined; // X-Slack-Request-Timestamp
  signature: string | undefined; // X-Slack-Signature
  rawBody: string; // exactly as received, before any parsing
  nowSeconds?: number;
}

export function verifySlackRequest(input: VerifyInput): { ok: true } | { ok: false; reason: string } {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: 'missing Slack signature headers' };

  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_REQUEST_AGE_SECONDS) {
    return { ok: false, reason: 'timestamp too old or invalid (possible replay)' };
  }

  const expected = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual needs equal lengths; comparing in constant time avoids leaking the signature.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}
