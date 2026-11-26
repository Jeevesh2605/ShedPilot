/**
 * investigator: triggered by the CloudWatch alarms through SNS.
 *
 * 1. Claim the incident lock (de-duplication: two alarms firing together make one incident).
 * 2. Gather evidence: Flagsmith flags, CloudWatch metrics, Logs Insights feature costs.
 * 3. Ask the LLM for a minimal proposal, then run the guardrail on it (rule-based fallback if the LLM fails).
 * 4. Save the incident and post to Slack with Approve / Reject buttons.
 *
 * It never changes a flag. Only the executor does that, after a human approves (Phase 3).
 */
import type { SNSEvent } from 'aws-lambda';
import { env, envNumber } from '../lib/config';
import { SERVICE_NAME } from '../lib/constants';
import { gatherFeatureCosts, gatherMetrics, type Target } from '../lib/cloudwatch';
import { FlagsmithAdmin, getFlagInventory } from '../lib/flagsmith';
import { IncidentStore, newIncidentId } from '../lib/incidents';
import { getSecret } from '../lib/secrets';
import { postMessage, updateMessage } from '../lib/slack';
import { investigatingMessage, investigationFailedMessage, investigationMessage, noSafeActionMessage } from '../lib/slackMessages';
import type { AlarmInfo, Evidence } from '../lib/types';
import { createProvider } from '../lib/llm';
import { decide } from './propose';

const store = new IncidentStore(env('TABLE_NAME'), SERVICE_NAME);

function log(message: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ component: 'investigator', message, ...details }));
}

export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(record.Sns.Message) as Record<string, string>;
    } catch (err) {
      log('Ignoring non-JSON SNS message', { error: String(err), messageId: record.Sns.MessageId });
      continue;
    }
    await handleAlarm(parsed);
  }
}

async function handleAlarm(alarmMessage: Record<string, string>): Promise<void> {
  if (alarmMessage.NewStateValue !== 'ALARM') {
    log('Ignoring alarm state change', { alarm: alarmMessage.AlarmName, state: alarmMessage.NewStateValue });
    return;
  }
  const alarm: AlarmInfo = {
    name: alarmMessage.AlarmName ?? 'unknown-alarm',
    reason: alarmMessage.NewStateReason ?? '',
    time: alarmMessage.StateChangeTime ?? new Date().toISOString(),
  };

  // 1. De-duplicate. If an incident is already open, record the alarm on it and stop.
  const incidentId = newIncidentId();
  const lock = await store.acquireLock(incidentId);
  if (!lock.acquired) {
    log('Incident already open, not creating another', { openIncidentId: lock.openIncidentId, alarm: alarm.name });
    if (lock.openIncidentId !== 'unknown') {
      await store.addEvent(lock.openIncidentId, `Alarm ${alarm.name} fired again while this incident was open`)
        .catch((e) => log('Could not record duplicate alarm event', { openIncidentId: lock.openIncidentId, error: String(e) }));
    }
    return;
  }
  try {
    await store.create(incidentId, alarm);
  } catch (err) {
    await store.releaseLock(incidentId).catch((e) => log('Could not release lock after create failure', { incidentId, error: String(e) }));
    throw err;
  }
  log('Investigation started', { incidentId, alarm: alarm.name });

  const channel = env('SLACK_CHANNEL_ID');
  const settleSeconds = envNumber('EVIDENCE_SETTLE_SECONDS');
  const proposer = process.env.LLM_PROVIDER === 'none' ? 'the rule-based proposer' : env('LLM_MODEL');
  let slack: { channel: string; ts: string } | undefined;
  // Post the final result by updating that message, or as a new one if it could not be posted.
  const publish = (message: Parameters<typeof postMessage>[1]) =>
    slack ? updateMessage(slack.channel, slack.ts, message).then(() => slack) : postMessage(channel, message);

  try {
    // Tell on-call straight away that ShedPilot is on it. The proposal replaces this message later.
    slack = await postMessage(channel, investigatingMessage(incidentId, alarm.name, alarm.time, settleSeconds, proposer))
      .catch((e) => { log('Could not post investigating message', { error: String(e) }); return undefined; });
    if (slack) await store.update(incidentId, { slack });

    // CloudWatch metrics arrive a minute or more late. An alarm can fire 30 s into a spike, when the
    // current minute is still mostly empty, so wait for the numbers to settle. (Waiting for data,
    // not simulating anything.)
    await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1000));

    // 2. Evidence. 3. Proposal.
    const evidence = await gatherEvidence(alarm);
    const decision = await decide(evidence, await createProvider());
    const { proposal, guardrailRejections, originalActions, llm } = decision;
    const extras = { guardrailRejections, llm };
    const saved = { evidence, proposal, guardrailRejections, originalActions, llm };
    log('Proposal ready', {
      incidentId,
      proposedBy: proposal.proposedBy,
      model: proposal.model,
      llmAttempts: llm?.attempts.map((a) => a.error ?? `ok in ${a.latencyMs} ms`),
      proposed: originalActions.map((a) => a.flag),
      allowedByGuardrail: proposal.actions.map((a) => a.flag),
      guardrailRejections,
      diagnosis: proposal.diagnosis,
    });

    // 4. Post to Slack, then save. (A button click can only succeed once the status is saved.)
    if (proposal.actions.length > 0) {
      const posted = await publish(investigationMessage(incidentId, evidence, proposal, extras));
      await store.transition(incidentId, 'INVESTIGATING', 'PENDING_APPROVAL', { ...saved, slack: posted },
        `Proposed turning off ${proposal.actions.map((a) => a.flag).join(', ')}; waiting for human approval`);
    } else {
      const posted = await publish(noSafeActionMessage(incidentId, evidence, proposal, extras));
      await store.transition(incidentId, 'INVESTIGATING', 'NO_SAFE_ACTION', { ...saved, slack: posted },
        'Investigated; no safe action available');
      await store.releaseLock(incidentId);
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log('Investigation failed', { incidentId, error: message });
    // Close the incident without acting and free the lock, so the next alarm can try again.
    await store.transition(incidentId, 'INVESTIGATING', 'NO_SAFE_ACTION', { error: message }, `Investigation failed: ${message}`)
      .catch((e) => log('Could not mark incident failed', { incidentId, error: String(e) }));
    await store.releaseLock(incidentId);
    await publish(investigationFailedMessage(incidentId, message))
      .catch((e) => log('Could not post failure to Slack', { incidentId, error: String(e) }));
  }
}

async function gatherEvidence(alarm: AlarmInfo): Promise<Evidence> {
  const target: Target = {
    region: env('TARGET_REGION'),
    functionName: env('REPORTS_FUNCTION_NAME'),
    apiId: env('REPORTS_API_ID'),
    logGroup: env('REPORTS_LOG_GROUP'),
  };
  const windowMinutes = envNumber('EVIDENCE_WINDOW_MINUTES');
  const end = new Date();
  const start = new Date(end.getTime() - windowMinutes * 60_000);

  // Flags first: their names decide which feature timings the log query measures.
  const admin = new FlagsmithAdmin({ apiKey: await getSecret('FLAGSMITH_ADMIN_KEY_PARAM') });
  const { flags } = await getFlagInventory(admin, envNumber('FLAGSMITH_PROJECT_ID'), env('FLAGSMITH_ENVIRONMENT_KEY'));

  const [metrics, logs] = await Promise.all([
    gatherMetrics(target, start, end),
    gatherFeatureCosts(target, flags.map((f) => f.name), start, end),
  ]);
  return { alarm, metrics, logs, flags };
}
