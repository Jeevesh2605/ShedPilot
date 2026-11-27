/**
 * recovery: runs on a schedule (EventBridge). It looks at the one open incident and:
 *   - SHED:             if the service is healthy AND safe to restore, posts a re-enable proposal;
 *   - PENDING_APPROVAL: if nobody decided within the timeout, expires the proposal.
 * It never changes a flag. Re-enabling goes through the same Slack approval -> executor path.
 */
import { env, envNumber } from '../lib/config';
import { SERVICE_NAME } from '../lib/constants';
import { gatherDemand, gatherMetrics, type Target } from '../lib/cloudwatch';
import { IncidentStore, RELEASES_LOCK, type ProposalIncident } from '../lib/incidents';
import { postMessage, updateMessage } from '../lib/slack';
import { decidedMessage, restoreProposalMessage } from '../lib/slackMessages';
import { assessRecovery, type RecoverySettings } from './assess';

const store = new IncidentStore(env('TABLE_NAME'), SERVICE_NAME);

function log(message: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ component: 'recovery', message, ...details }));
}

export async function handler(): Promise<void> {
  const incidentId = await store.getOpenIncidentId();
  if (!incidentId) return; // nothing open: the common case, and cheap
  const incident = (await store.get(incidentId)) as ProposalIncident | undefined;
  if (!incident) return;

  if (RELEASES_LOCK.includes(incident.status)) {
    await store.releaseLock(incident.incidentId);
    log('Released lingering lock for closed incident', { incidentId: incident.incidentId, status: incident.status });
    return;
  }
  if (incident.status === 'PENDING_APPROVAL') return expireIfStale(incident);
  if (incident.status === 'SHED') return checkRecovery(incident);
}

async function expireIfStale(incident: ProposalIncident): Promise<void> {
  const timeout = envNumber('APPROVAL_TIMEOUT_MINUTES');
  const ageMinutes = (Date.now() - Date.parse(incident.createdAt)) / 60_000;
  if (ageMinutes < timeout) return;
  try {
    await store.transition(incident.incidentId, 'PENDING_APPROVAL', 'EXPIRED', {}, `No decision within ${timeout} minutes; proposal expired`);
  } catch {
    return; // someone decided at the same moment: their decision wins
  }
  await store.releaseLock(incident.incidentId);
  if (incident.slack) {
    await updateMessage(incident.slack.channel, incident.slack.ts,
      decidedMessage(incident.incidentId, incident.evidence, incident.proposal, { kind: 'expired', minutes: timeout },
        { guardrailRejections: incident.guardrailRejections, llm: incident.llm }))
      .catch((e) => log('Could not update expired message', { error: String(e) }));
  }
  log('Expired stale proposal', { incidentId: incident.incidentId });
}

async function checkRecovery(incident: ProposalIncident): Promise<void> {
  const settings: RecoverySettings = {
    healthyMinutes: envNumber('HEALTHY_MINUTES'),
    healthyP90Ms: envNumber('HEALTHY_P90_MS'),
    concurrencyLimit: envNumber('CONCURRENCY_LIMIT'),
    headroomFraction: envNumber('HEADROOM_FRACTION'),
    cooldownMinutes: envNumber('RESTORE_COOLDOWN_MINUTES'),
  };
  const target: Target = {
    region: env('TARGET_REGION'),
    functionName: env('REPORTS_FUNCTION_NAME'),
    apiId: env('REPORTS_API_ID'),
    logGroup: env('REPORTS_LOG_GROUP'),
  };
  const shedFlags = incident.shedFlags ?? [];
  const now = new Date();

  // Health: the N most recent COMPLETE minutes. The 2 newest minutes are skipped because
  // CloudWatch fills them in late, and an empty minute would look falsely healthy.
  const healthEnd = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 2 * 60_000);
  const healthStart = new Date(healthEnd.getTime() - settings.healthyMinutes * 60_000);
  // Demand: logs are near real time, so look at the last N minutes up to now.
  const demandStart = new Date(now.getTime() - settings.healthyMinutes * 60_000);

  const [metrics, demand] = await Promise.all([
    gatherMetrics(target, healthStart, healthEnd),
    gatherDemand(target, shedFlags, demandStart, now),
  ]);

  const featureAvgMs = Object.fromEntries(incident.evidence.logs.features.map((f) => [f.flag, f.avgMs]));
  const keptDisabledAt = incident.restoreDecision?.decision === 'reject' ? incident.restoreDecision.at : undefined;
  const check = assessRecovery(
    {
      now,
      shedAt: incident.shedAt ?? incident.updatedAt,
      keptDisabledAt,
      minutes: metrics.perMinute,
      peakConcurrency: metrics.totals.peakConcurrency,
      demandWindowSeconds: settings.healthyMinutes * 60,
      demand,
      featureAvgMs,
    },
    settings,
  );
  log('Recovery check', { incidentId: incident.incidentId, ready: check.ready, reason: check.reason, needed: check.executionsNeeded, free: check.executionsAvailable });

  // Keep only the latest check on the incident; add an audit event only when the reason changes.
  if (incident.recoveryCheck?.code !== check.code) {
    await store.addEvent(incident.incidentId, `Recovery check: ${check.ready ? 'ready' : 'not yet'}, ${check.reason}`);
  }
  await store.update(incident.incidentId, { recoveryCheck: { at: now.toISOString(), ready: check.ready, code: check.code, reason: check.reason } });
  if (!check.ready) return;

  const restoreSlack = await postMessage(env('SLACK_CHANNEL_ID'),
    restoreProposalMessage(incident.incidentId, incident.evidence, shedFlags, check, settings.healthyMinutes));
  try {
    await store.transition(incident.incidentId, 'SHED', 'RESTORE_PROPOSED',
      { restoreCheck: { ...check, at: now.toISOString() }, restoreSlack },
      `Proposed turning ${shedFlags.join(', ')} back on; waiting for human approval`);
  } catch (err) {
    log('Could not save restore proposal, removing uncommitted buttons', { error: String(err) });
    await updateMessage(restoreSlack.channel, restoreSlack.ts, {
      text: `Restore proposal for ${incident.incidentId} was superseded before saving.`,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `:information_source: Restore proposal for \`${incident.incidentId}\` was cancelled because the incident state changed.` },
      }],
    }).catch((e) => log('Could not clean up uncommitted restore message', { error: String(e) }));
  }
}
