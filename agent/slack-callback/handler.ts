/**
 * slack-callback: receives Approve / Reject button clicks from Slack (public Function URL).
 *
 * In under 3 seconds (Slack's limit) it:
 *   1. verifies the Slack signature and timestamp (anything else gets 401);
 *   2. checks the click is for the incident that is open right now;
 *   3. records the human decision with ONE conditional write on the incident status.
 *      This write is the recorded approval. A double click or a Slack retry fails the condition
 *      and changes nothing;
 *   4. hands off to the executor asynchronously and returns.
 *
 * It never calls Flagsmith. Changing flags is the executor's job.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { env, envNumber } from '../lib/config';
import { SERVICE_NAME } from '../lib/constants';
import { DECISIONS, parseButtonValue, type ExecutorEvent } from '../lib/decisions';
import { IncidentStore, TransitionConflictError } from '../lib/incidents';
import { getSecret } from '../lib/secrets';
import { verifySlackRequest } from '../lib/slackVerify';
import type { HumanDecision } from '../lib/types';

const store = new IncidentStore(env('TABLE_NAME'), SERVICE_NAME);
const lambda = new LambdaClient({});

function log(message: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ component: 'slack-callback', message, ...details }));
}

const ok = (): LambdaFunctionURLResult => ({ statusCode: 200, body: '' });

/** Sends a message only the clicking user can see. Best effort, with a short timeout. */
async function tellUser(responseUrl: string | undefined, text: string): Promise<void> {
  if (!responseUrl?.startsWith('https://hooks.slack.com/')) return;
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    signal: AbortSignal.timeout(1500),
  }).catch((e) => log('Could not send ephemeral message', { error: String(e) }));
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  // 1. Verify the request came from Slack. The signature covers the raw body, so check it first.
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const verified = verifySlackRequest({
    signingSecret: await getSecret('SLACK_SIGNING_SECRET_PARAM'),
    timestamp: headers['x-slack-request-timestamp'],
    signature: headers['x-slack-signature'],
    rawBody,
  });
  if (!verified.ok) {
    log('Rejected request', { reason: verified.reason });
    return { statusCode: 401, body: 'invalid request' };
  }

  const payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '{}');
  if (payload.type !== 'block_actions') return ok();
  const button = parseButtonValue(payload.actions?.[0]?.value);
  if (!button) {
    log('Ignoring unknown button value');
    return ok();
  }
  const user = { id: String(payload.user?.id ?? ''), name: String(payload.user?.username ?? payload.user?.name ?? 'unknown') };
  const responseUrl: string | undefined = payload.response_url;
  const { incidentId } = button;
  log('Button clicked', { incidentId, phase: button.phase, decision: button.decision, user });

  // Optional allowlist of Slack user IDs who may decide. Empty means anyone in the channel.
  const approvers = (process.env.APPROVER_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (approvers.length > 0 && !approvers.includes(user.id)) {
    await tellUser(responseUrl, 'You are not on the ShedPilot approver list, so nothing was changed.');
    return ok();
  }

  // 2. Only the incident that is open right now can be acted on. Old proposals expire.
  const { from, to } = DECISIONS[button.phase][button.decision];
  const openIncidentId = await store.getOpenIncidentId();
  if (openIncidentId !== incidentId) {
    await store
      .transition(incidentId, from, 'EXPIRED', {}, `Button clicked by ${user.name} after the incident was closed; proposal expired`)
      .catch(() => undefined); // only applies if it was still pending
    await tellUser(responseUrl, `Incident \`${incidentId}\` is no longer open, so this proposal can't be acted on. Nothing was changed.`);
    return ok();
  }
  if (button.phase === 'shed' && button.decision === 'approve') {
    const incident = await store.get(incidentId);
    const ageMinutes = incident ? (Date.now() - Date.parse(incident.createdAt)) / 60_000 : Infinity;
    if (ageMinutes > envNumber('APPROVAL_TIMEOUT_MINUTES')) {
      await store
        .transition(incidentId, 'PENDING_APPROVAL', 'EXPIRED', {}, `Approval by ${user.name} arrived after ${Math.round(ageMinutes)} minutes; proposal expired`)
        .then(() => store.releaseLock(incidentId))
        .catch(() => undefined);
      await tellUser(responseUrl, `This proposal is ${Math.round(ageMinutes)} minutes old, so its evidence is stale. It has expired and nothing was changed. If the problem continues, the alarm will start a fresh investigation.`);
      return ok();
    }
  }

  // 3. Record the decision. The condition on the current status makes this idempotent.
  const decision: HumanDecision = { decision: button.decision, userId: user.id, userName: user.name, at: new Date().toISOString() };
  try {
    await store.transition(
      incidentId, from, to,
      { [`${button.phase}Decision`]: decision },
      `${button.decision === 'approve' ? 'Approved' : 'Rejected'} by ${user.name} (${user.id}) in Slack`,
    );
  } catch (err) {
    if (err instanceof TransitionConflictError) {
      const current = await store.get(incidentId);
      log('Decision already recorded', { incidentId, status: current?.status });
      await tellUser(responseUrl, `Already handled: incident \`${incidentId}\` is now ${current?.status}. Nothing more was done.`);
      return ok();
    }
    throw err;
  }

  // 4. Hand off to the executor without waiting for it.
  const executorEvent: ExecutorEvent = { incidentId, phase: button.phase, decision: button.decision };
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: env('EXECUTOR_FUNCTION_NAME'),
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(executorEvent)),
      }),
      { abortSignal: AbortSignal.timeout(1500) },
    );
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log('Could not invoke executor', { incidentId, to, error });
    if (to === 'APPROVED' || to === 'RESTORE_APPROVED') {
      await store.transition(incidentId, to, 'FAILED', { executionError: error }, `Could not start executor: ${error}`)
        .catch((e) => log('Could not mark incident FAILED after invoke error', { incidentId, error: String(e) }));
      await tellUser(responseUrl, `Approval was recorded for \`${incidentId}\`, but ShedPilot could not start the executor (\`${error.slice(0, 120)}\`). No flags were changed; the incident stays open for a human.`);
    } else if (to === 'REJECTED') {
      await store.releaseLock(incidentId).catch((e) => log('Could not release lock after reject invoke error', { incidentId, error: String(e) }));
      await tellUser(responseUrl, `Rejection recorded for \`${incidentId}\` and the lock was released (Slack message update did not run).`);
    } else {
      await tellUser(responseUrl, `Recorded "Keep disabled" for \`${incidentId}\`, though the Slack message update could not start.`);
    }
    return ok();
  }
  log('Decision recorded, executor invoked', { incidentId, to });
  // Return immediately so we always meet Slack's 3-second ack deadline; executor updates the message directly.
  return ok();
}
