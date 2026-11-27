/**
 * executor: the ONLY component that changes flags in Flagsmith.
 *
 * Invoked asynchronously by slack-callback after a human decision has been recorded.
 * Before writing anything it checks that:
 *   - the incident is in APPROVED status, with the approval stored on it;
 *   - each flag still passes the guardrail against Flagsmith's live state right now.
 * After writing, it reads each flag back to confirm, records the result, and updates the
 * original Slack message.
 *
 * DRY_RUN=true logs exactly what it would change and changes nothing.
 */
import { env, envNumber } from '../lib/config';
import { SERVICE_NAME } from '../lib/constants';
import type { ExecutorEvent } from '../lib/decisions';
import { FlagsmithAdmin, getFlagInventory, setAndVerifyFlag } from '../lib/flagsmith';
import { checkRestoreFlags, checkShedActions, describeRejections } from '../lib/guardrails';
import { IncidentStore, type ProposalIncident } from '../lib/incidents';
import { postMessage } from '../lib/slack';
import { getSecret } from '../lib/secrets';
import { updateMessage } from '../lib/slack';
import {
  decidedMessage,
  incidentReportMessage,
  restoreDecidedMessage,
  type RestoreOutcome,
  type ShedOutcome,
} from '../lib/slackMessages';
import type { FlagChangeResult } from '../lib/types';

const store = new IncidentStore(env('TABLE_NAME'), SERVICE_NAME);
const DRY_RUN = process.env.DRY_RUN === 'true';

function log(message: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ component: 'executor', message, dryRun: DRY_RUN, ...details }));
}

export async function handler(event: ExecutorEvent): Promise<void> {
  const incident = (await store.get(event.incidentId)) as ProposalIncident | undefined;
  if (!incident) throw new Error(`Incident ${event.incidentId} not found`);
  log('Executor started', { incidentId: incident.incidentId, phase: event.phase, decision: event.decision, status: incident.status });

  if (event.phase === 'shed' && event.decision === 'reject') return finishRejection(incident);
  if (event.phase === 'shed' && event.decision === 'approve') return shed(incident);
  if (event.phase === 'restore' && event.decision === 'approve') return restore(incident);
  return keepDisabled(incident);
}

async function finishRejection(incident: ProposalIncident): Promise<void> {
  if (incident.status !== 'REJECTED' || !incident.shedDecision) {
    log('Not rejected; refusing', { status: incident.status });
    return;
  }
  await updateSlack(incident, { kind: 'rejected', decision: incident.shedDecision });
  await store.releaseLock(incident.incidentId);
  await store.addEvent(incident.incidentId, 'Proposal rejected; lock released, no flags changed');
}

async function shed(incident: ProposalIncident): Promise<void> {
  const { incidentId } = incident;
  const decision = incident.shedDecision;
  // The hard rule: no flag changes without a recorded human approval.
  if (incident.status !== 'APPROVED' || !decision || decision.decision !== 'approve') {
    log('No recorded approval; refusing to change flags', { incidentId, status: incident.status });
    return;
  }

  const environmentKey = env('FLAGSMITH_ENVIRONMENT_KEY');
  const results: FlagChangeResult[] = [];
  const shedFlags: string[] = [];
  let blocked: string[] = [];
  try {
    const admin = new FlagsmithAdmin({
      apiKey: await getSecret('FLAGSMITH_ADMIN_KEY_PARAM'),
      host: process.env.FLAGSMITH_API_HOST,
    });
    const { environment, flags } = await getFlagInventory(admin, envNumber('FLAGSMITH_PROJECT_ID'), environmentKey);

    // Re-check against live state: someone may have changed a flag or its tags since the proposal.
    const guard = checkShedActions(incident.proposal.actions, flags);
    blocked = describeRejections(guard.rejected);
    for (const b of blocked) {
      await store.addEvent(incidentId, `Guardrail blocked at execution time: ${b}`)
        .catch((e) => log('Could not record guardrail audit event', { incidentId, error: String(e) }));
    }

    for (const action of guard.allowed) {
      const flag = flags.find((f) => f.name === action.flag)!;
      const r = await setFlag(admin, environmentKey, flag.name, flag.id, false, {
        useV2: environment.use_v2_feature_versioning,
        featureStateId: flag.featureStateId,
      });
      results.push(r);
      if (r.ok) shedFlags.push(r.flag);
      const eventMsg = !r.ok
        ? `Failed to turn off ${r.flag}: ${r.error}`
        : r.unverified
          ? `Turned off ${r.flag} in Flagsmith (read-back verification failed: ${r.error})`
          : `${r.dryRun ? 'DRY RUN: would turn off' : 'Turned off'} ${r.flag} in Flagsmith`;
      await store.addEvent(incidentId, eventMsg, { ...r })
        .catch((e) => log('Could not record flag audit event', { incidentId, flag: r.flag, error: String(e) }));
    }

    const unknownFlags = results.filter((r) => r.unknownState).map((r) => r.flag);
    const execution = { results, blocked, unknownFlags, dryRun: DRY_RUN };
    if (shedFlags.length > 0) {
      await store.transition(incidentId, 'APPROVED', 'SHED',
        { shedAt: new Date().toISOString(), shedFlags, execution },
        `Load shed: ${shedFlags.join(', ')} turned off${DRY_RUN ? ' (dry run)' : ''}, approved by ${decision.userName}`);
      await updateSlack(incident, { kind: 'shed', decision, results, blocked });
    } else {
      await store.transition(incidentId, 'APPROVED', 'FAILED', { execution }, 'No flag could be changed; incident kept open for a human');
      await updateSlack(incident, { kind: 'failed', decision, results, blocked });
    }
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log('Execution failed', { incidentId, error, shedFlags });
    const partial = shedFlags.length > 0
      ? { shedAt: new Date().toISOString(), shedFlags, execution: { results, blocked, dryRun: DRY_RUN }, executionError: error }
      : { executionError: error };
    await store.transition(incidentId, 'APPROVED', 'FAILED', partial, `Execution failed: ${error}`)
      .catch((e) => log('Could not mark incident FAILED', { error: String(e) }));
    await updateSlack(incident, { kind: 'failed', decision, results, blocked, error });
  }
}

/** Turns one flag on or off and reads it back to confirm. */
async function setFlag(
  admin: FlagsmithAdmin,
  environmentKey: string,
  flag: string,
  featureId: number,
  enabled: boolean,
  options: { useV2?: boolean; featureStateId?: number } = {},
): Promise<FlagChangeResult> {
  if (DRY_RUN) {
    const request = options.useV2 === false
      ? `PATCH /api/v1/environments/${environmentKey}/featurestates/${options.featureStateId}/`
      : `PATCH /api/__future__/environments/${environmentKey}/features/${featureId}/`;
    const body = options.useV2 === false ? { enabled } : { environment_default: { enabled } };
    log('DRY RUN: would send', { request, body, flag });
    return { flag, featureId, ok: true, dryRun: true };
  }
  const result = await setAndVerifyFlag(admin, environmentKey, flag, featureId, enabled, options);
  log(
    result.unknownState
      ? 'Flag write and read-back both failed (state unknown)'
      : result.unverified
        ? 'Flag change reconciled with one unverified leg'
        : result.ok
          ? `Flag turned ${enabled ? 'on' : 'off'} and verified`
          : 'Flag did not change',
    { flag, featureId, ok: result.ok, unverified: result.unverified, unknownState: result.unknownState },
  );
  return result;
}

// ---- Phase 5: turning flags back on ------------------------------------------------------------

async function restore(incident: ProposalIncident): Promise<void> {
  const { incidentId } = incident;
  // Retry path: if RESOLVED already committed and only lock release failed earlier, finish lock cleanup cleanly.
  if (incident.status === 'RESOLVED') {
    await store.releaseLock(incidentId);
    log('Released lingering lock for resolved incident', { incidentId });
    return;
  }
  const decision = incident.restoreDecision;
  if (incident.status !== 'RESTORE_APPROVED' || !decision || decision.decision !== 'approve') {
    log('No recorded restore approval; refusing to change flags', { incidentId, status: incident.status });
    return;
  }
  const shedFlags = incident.shedFlags ?? [];
  const environmentKey = env('FLAGSMITH_ENVIRONMENT_KEY');
  const results: FlagChangeResult[] = [];
  let blocked: string[] = [];
  try {
    const admin = new FlagsmithAdmin({
      apiKey: await getSecret('FLAGSMITH_ADMIN_KEY_PARAM'),
      host: process.env.FLAGSMITH_API_HOST,
    });
    const { environment, flags } = await getFlagInventory(admin, envNumber('FLAGSMITH_PROJECT_ID'), environmentKey);

    // Only flags this incident turned off, still off, still tagged load-sheddable.
    const guard = checkRestoreFlags(shedFlags, shedFlags, flags);
    const alreadyOn = guard.rejected.filter((r) => r.reasons.length === 1 && r.reasons[0] === 'flag is already on').map((r) => r.flag);
    blocked = describeRejections(guard.rejected.filter((r) => !alreadyOn.includes(r.flag)));

    for (const name of guard.allowed) {
      const flag = flags.find((f) => f.name === name)!;
      const r = await setFlag(admin, environmentKey, flag.name, flag.id, true, {
        useV2: environment.use_v2_feature_versioning,
        featureStateId: flag.featureStateId,
      });
      results.push(r);
      const eventMsg = !r.ok
        ? `Failed to turn on ${r.flag}: ${r.error}`
        : r.unverified
          ? `Turned on ${r.flag} in Flagsmith (read-back verification failed: ${r.error})`
          : `${r.dryRun ? 'DRY RUN: would turn on' : 'Turned on'} ${r.flag} in Flagsmith`;
      await store.addEvent(incidentId, eventMsg, { ...r })
        .catch((e) => log('Could not record restore audit event', { incidentId, flag: r.flag, error: String(e) }));
    }

    const done = results.filter((r) => r.ok).length + alreadyOn.length;
    const restoreExecution = { results, blocked, dryRun: DRY_RUN };
    if (done === shedFlags.length && blocked.length === 0) {
      const resolvedAt = new Date().toISOString();
      await store.transition(incidentId, 'RESTORE_APPROVED', 'RESOLVED', { resolvedAt, restoreExecution },
        `Resolved: ${shedFlags.join(', ')} back on${DRY_RUN ? ' (dry run)' : ''}, approved by ${decision.userName}`);
      await store.releaseLock(incidentId).catch((e) => log('Could not release lock after resolution; recovery will clean up', { incidentId, error: String(e) }));
      await updateRestoreSlack(incident, { kind: 'restored', decision, results, alreadyOn });
      await postReport({ ...incident, resolvedAt });
    } else {
      await store.transition(incidentId, 'RESTORE_APPROVED', 'FAILED', { restoreExecution }, 'Could not turn every flag back on; incident kept open for a human');
      await updateRestoreSlack(incident, { kind: 'failed', decision, results, blocked });
    }
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log('Restore failed', { incidentId, error });
    await store.transition(incidentId, 'RESTORE_APPROVED', 'FAILED', { restoreError: error }, `Restore failed: ${error}`)
      .catch((e) => log('Could not mark incident FAILED', { error: String(e) }));
    await updateRestoreSlack(incident, { kind: 'failed', decision, results, blocked, error });
  }
}

/** "Keep disabled": the callback already moved the incident back to SHED; just update Slack. */
async function keepDisabled(incident: ProposalIncident): Promise<void> {
  const decision = incident.restoreDecision;
  if (incident.status !== 'SHED' || !decision || decision.decision !== 'reject') {
    log('Not a kept-disabled incident; nothing to do', { status: incident.status });
    return;
  }
  const next = new Date(Date.parse(decision.at) + envNumber('RESTORE_COOLDOWN_MINUTES') * 60_000).toISOString().slice(11, 16) + ' UTC';
  await updateRestoreSlack(incident, { kind: 'kept', decision, nextCheck: next });
  await store.addEvent(incident.incidentId, `Kept disabled by ${decision.userName}; next check after ${next}`);
}

async function updateRestoreSlack(incident: ProposalIncident, outcome: RestoreOutcome): Promise<void> {
  if (!incident.restoreCheck) return;
  const message = restoreDecidedMessage(incident.incidentId, incident.evidence, incident.shedFlags ?? [], incident.restoreCheck, envNumber('HEALTHY_MINUTES'), outcome);
  if (incident.restoreSlack) {
    try {
      await updateMessage(incident.restoreSlack.channel, incident.restoreSlack.ts, message);
      return;
    } catch (err) {
      log('Could not update restore message, posting new one instead', { error: String(err) });
    }
  }
  await postMessage(env('SLACK_CHANNEL_ID'), message).catch((err) => log('Could not post restore fallback message', { error: String(err) }));
}

async function postReport(incident: ProposalIncident & { resolvedAt: string }): Promise<void> {
  try {
    const events = await store.listEvents(incident.incidentId);
    const proposer = incident.llm?.fellBackToRules ? 'rule-based fallback' : (incident.proposal.model ?? 'rule-based proposal');
    await postMessage(env('SLACK_CHANNEL_ID'), incidentReportMessage({
      incidentId: incident.incidentId,
      createdAt: incident.createdAt,
      shedAt: incident.shedAt,
      resolvedAt: incident.resolvedAt,
      evidence: incident.evidence,
      proposal: incident.proposal,
      shedFlags: incident.shedFlags ?? [],
      shedDecision: incident.shedDecision,
      restoreDecision: incident.restoreDecision,
      guardrailRejections: incident.guardrailRejections,
      proposer,
      events,
    }));
  } catch (err) {
    log('Could not post incident report', { error: String(err) });
  }
}

async function updateSlack(incident: ProposalIncident, outcome: ShedOutcome): Promise<void> {
  const extras = { guardrailRejections: incident.guardrailRejections, llm: incident.llm };
  const message = decidedMessage(incident.incidentId, incident.evidence, incident.proposal, outcome, extras);
  if (incident.slack) {
    try {
      await updateMessage(incident.slack.channel, incident.slack.ts, message);
      return;
    } catch (err) {
      log('Could not update Slack message, posting new one instead', { error: String(err) });
    }
  }
  await postMessage(env('SLACK_CHANNEL_ID'), message).catch((err) => log('Could not post Slack fallback message', { error: String(err) }));
}
