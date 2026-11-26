/** Minimal Slack Web API client: post a message, update a message. Uses the bot token from SSM. */
import { getSecret } from './secrets';

export interface SlackMessage {
  text: string; // plain-text fallback, shown in notifications
  blocks: unknown[]; // Block Kit layout
}

export interface SlackCallOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

export async function callSlack(
  method: string,
  body: Record<string, unknown>,
  tokenOverride?: string,
  options: SlackCallOptions = {},
): Promise<Record<string, unknown>> {
  const token = tokenOverride ?? (await getSecret('SLACK_BOT_TOKEN_PARAM'));
  const maxAttempts = 1 + (options.maxRetries ?? 2);
  const baseDelayMs = options.retryDelayMs ?? 400;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let result: Record<string, unknown> | undefined;
      try {
        result = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      } catch {
        result = undefined;
      }

      if (!response.ok) {
        if (attempt < maxAttempts && (response.status === 429 || response.status >= 500)) {
          const retryAfter = Number(response.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 30) {
            throw new Error(`Slack ${method} HTTP ${response.status}: Retry-After ${retryAfter}s exceeds retry budget`);
          }
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * attempt;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Slack ${method} HTTP ${response.status}: ${(result?.error ? String(result.error) : text).slice(0, 200)}`);
      }

      if (!result) throw new Error(`Slack ${method} returned non-JSON response: ${text.slice(0, 200)}`);
      // Slack returns HTTP 200 with ok:false on errors, so the body must be checked.
      if (!result.ok) throw new Error(`Slack ${method} failed: ${String(result.error)}`);
      return result;
    } catch (err) {
      const isSlackLogicError = err instanceof Error && err.message.startsWith(`Slack ${method} `);
      if (isSlackLogicError || attempt >= maxAttempts) throw err;
      const delay = baseDelayMs * attempt;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`Slack ${method} failed after ${maxAttempts} attempts`);
}

export async function postMessage(channel: string, message: SlackMessage): Promise<{ channel: string; ts: string }> {
  const result = await callSlack('chat.postMessage', { channel, ...message, unfurl_links: false });
  return { channel: String(result.channel), ts: String(result.ts) };
}

export async function updateMessage(channel: string, ts: string, message: SlackMessage): Promise<void> {
  await callSlack('chat.update', { channel, ts, ...message });
}
