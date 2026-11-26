/**
 * Slack Block Kit layouts. Pure functions (no network), so they are easy to test and preview.
 * Preview any message by pasting its blocks into https://app.slack.com/block-kit-builder
 */
import type { Assessment } from '../recovery/assess';
import type { IncidentEvent } from './incidents';
import type { Evidence, FlagChangeResult, HumanDecision, Proposal } from './types';
import type { SlackMessage } from './slack';

/** Extra context shown with a proposal: what the guardrail blocked, and which model proposed it. */
export interface ProposalExtras {
  guardrailRejections?: string[];
  llm?: { provider: string; model?: string; attempts: { latencyMs?: number; error?: string }[]; fellBackToRules: boolean };
}

function proposerText(proposal: Proposal, extras: ProposalExtras): string {
  if (extras.llm?.fellBackToRules) return 'rule-based fallback (LLM unavailable)';
  if (proposal.proposedBy === 'llm') {
    const ms = extras.llm?.attempts.reduce((sum, a) => sum + (a.latencyMs ?? 0), 0) ?? 0;
    return `${proposal.model ?? 'LLM'}${ms ? ` in ${(ms / 1000).toFixed(1)} s` : ''}`;
  }
  return 'rule-based proposal';
}

function guardrailBlocks(extras: ProposalExtras): unknown[] {
  if (!extras.guardrailRejections?.length) return [];
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: *Blocked by the guardrail* (never offered for approval):\n• ${extras.guardrailRejections.join('\n• ')}`,
      },
    },
  ];
}

/** What a button carries back to the callback in Phase 3. */
export interface ButtonValue {
  incidentId: string;
  decision: 'approve' | 'reject';
  phase: 'shed' | 'restore';
}

const SECTION_TEXT_LIMIT = 3000;
const clipSectionText = (text: string): string =>
  text.length <= SECTION_TEXT_LIMIT ? text : `${text.slice(0, SECTION_TEXT_LIMIT - 3)}...`;

const pct = (share: number) => `${Math.round(share * 100)}%`;
const secs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
const num = (n: number) => n.toLocaleString('en-US');

/** "2026-11-13T13:26:27.251+0000" -> "13:26:27 UTC" (falls back to the raw text if unparsable). */
export function alarmTime(raw: string): string {
  const date = new Date(raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? raw : `${date.toISOString().slice(11, 19)} UTC`;
}

function evidenceBlocks(evidence: Evidence): unknown[] {
  const t = evidence.metrics.totals;
  const rows = evidence.logs.features.map(
    (f) =>
      `${f.flag.padEnd(16)} ${String(f.requests).padStart(8)} ${String(f.avgMs).padStart(7)} ${String(f.p90Ms).padStart(7)} ${pct(f.computeShare).padStart(6)}`,
  );
  const table = ['flag             requests  avg ms  p90 ms  share', ...rows].join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*What's wrong*\nAlarm \`${evidence.alarm.name}\` fired at ${alarmTime(evidence.alarm.time)}.` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Throttled requests (5 min)*\n${num(t.throttles)}` },
        { type: 'mrkdwn', text: `*API 5xx (5 min)*\n${num(t.api5xx)}` },
        { type: 'mrkdwn', text: `*Peak Lambda concurrency*\n${t.peakConcurrency}` },
        { type: 'mrkdwn', text: `*Worst-minute API p90*\n${secs(t.worstMinuteApiLatencyP90Ms)}` },
        { type: 'mrkdwn', text: `*Served requests (logs)*\n${num(evidence.logs.servedRequests)}` },
        { type: 'mrkdwn', text: `*Lambda errors*\n${num(t.errors)}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Where the compute went* (served requests, last 5 min)\n\`\`\`${rows.length ? table : 'No feature timings in the logs.'}\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'CloudWatch is still filling in the most recent minute, so counts during an ongoing spike are a lower bound.' }],
    },
  ];
}

export function investigationMessage(incidentId: string, evidence: Evidence, proposal: Proposal, extras: ProposalExtras = {}): SlackMessage {
  const value = (decision: ButtonValue['decision']) => JSON.stringify({ incidentId, decision, phase: 'shed' } satisfies ButtonValue);
  const flags = proposal.actions.map((a) => `\`${a.flag}\``).join(', ');

  return {
    text: `ShedPilot: reports-api is overloaded. Proposed: turn off ${proposal.actions.map((a) => a.flag).join(', ')}. Approval needed.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':rotating_light: reports-api is overloaded' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Diagnosis*\n${proposal.diagnosis}` } },
      ...evidenceBlocks(evidence),
      { type: 'divider' },
      ...proposal.actions.map((a) => ({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: clipSectionText(
            `*Proposed: turn off \`${a.flag}\`*\n` +
              `*Why:* ${a.reason}\n*Evidence:* ${a.evidence}\n*Expected effect:* ${a.expected_effect}\n*User impact:* ${a.user_impact}`,
          ),
        },
      })),
      ...guardrailBlocks(extras),
      ...(proposal.alternatives_considered.length
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `*Alternatives considered:*\n• ${proposal.alternatives_considered.join('\n• ')}` }] }]
        : []),
      {
        type: 'actions',
        block_id: 'shed_decision',
        elements: [
          {
            type: 'button',
            action_id: 'approve',
            style: 'primary',
            text: { type: 'plain_text', text: 'Approve' },
            value: value('approve'),
            confirm: {
              title: { type: 'plain_text', text: 'Turn off flags?' },
              text: { type: 'mrkdwn', text: `ShedPilot will turn off ${flags} in Flagsmith.` },
              confirm: { type: 'plain_text', text: 'Turn off' },
              deny: { type: 'plain_text', text: 'Cancel' },
            },
          },
          { type: 'button', action_id: 'reject', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: value('reject') },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Incident \`${incidentId}\` · proposed by ${proposerText(proposal, extras)} · confidence ${proposal.confidence} · checked by the guardrail · nothing changes until a human approves`,
          },
        ],
      },
    ],
  };
}

/** Posted the moment an alarm arrives, then replaced by the proposal once the evidence is in. */
export function investigatingMessage(incidentId: string, alarmName: string, alarmAt: string, settleSeconds: number, proposer: string): SlackMessage {
  return {
    text: `ShedPilot is investigating alarm ${alarmName}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':mag: Investigating reports-api' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `Alarm \`${alarmName}\` fired at ${alarmTime(alarmAt)}.\n` +
            `Waiting about ${settleSeconds} s for CloudWatch metrics to settle, then gathering metrics and logs and asking ${proposer} for a proposal. ` +
            'This message will update.',
        },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident \`${incidentId}\` · no flags will change without a human approval` }] },
    ],
  };
}

export function noSafeActionMessage(incidentId: string, evidence: Evidence, proposal: Proposal, extras: ProposalExtras = {}): SlackMessage {
  return {
    text: 'ShedPilot investigated reports-api: no safe action available.',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':mag: Investigated: no safe action available' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Diagnosis*\n${proposal.diagnosis}` } },
      ...evidenceBlocks(evidence),
      ...guardrailBlocks(extras),
      ...(proposal.alternatives_considered.length
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `*Considered:*\n• ${proposal.alternatives_considered.join('\n• ')}` }] }]
        : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident \`${incidentId}\` · proposed by ${proposerText(proposal, extras)} · no flags will be changed · a human should take a look` }] },
    ],
  };
}

export function investigationFailedMessage(incidentId: string, error: string): SlackMessage {
  return {
    text: `ShedPilot could not finish investigating reports-api: ${error}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':warning: Investigation failed' } },
      { type: 'section', text: { type: 'mrkdwn', text: `ShedPilot could not finish the investigation, so it proposes nothing.\n*Error:* \`${error.slice(0, 500)}\`` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident \`${incidentId}\` · no flags were changed` }] },
    ],
  };
}

// ---- after a decision: the original message, without buttons, plus what happened -------------

export type ShedOutcome =
  | { kind: 'expired'; minutes: number }
  | { kind: 'shed'; decision: HumanDecision; results: FlagChangeResult[]; blocked: string[] }
  | { kind: 'failed'; decision: HumanDecision; results: FlagChangeResult[]; blocked: string[]; error?: string }
  | { kind: 'rejected'; decision: HumanDecision };

function outcomeText(outcome: ShedOutcome): string {
  if (outcome.kind === 'expired') {
    return `:hourglass: *Expired.* Nobody approved or rejected this within ${outcome.minutes} minutes, so its evidence is stale. No flags were changed. If the problem continues, the alarm will start a fresh investigation.`;
  }
  const who = `<@${outcome.decision.userId}> at ${alarmTime(outcome.decision.at)}`;
  if (outcome.kind === 'rejected') return `:no_entry: *Rejected* by ${who}. No flags were changed.`;

  const changed = outcome.results.filter((r) => r.ok);
  const failed = outcome.results.filter((r) => !r.ok);
  const dryRun = changed.some((r) => r.dryRun);
  const lines = [
    outcome.kind === 'shed'
      ? `:white_check_mark: *Approved* by ${who}.`
      : `:x: *Approved* by ${who}, but the change did not go through. The incident stays open for a human.`,
  ];
  if (changed.length) {
    const verified = changed.filter((r) => !r.unverified);
    const unverified = changed.filter((r) => r.unverified);
    if (verified.length) {
      lines.push(
        dryRun
          ? `DRY RUN: would have turned off ${verified.map((r) => `\`${r.flag}\``).join(', ')} in Flagsmith. Nothing was changed.`
          : `Turned off ${verified.map((r) => `\`${r.flag}\``).join(', ')} in Flagsmith, and read it back to confirm.`,
      );
    }
    for (const r of unverified) {
      lines.push(`Turned off \`${r.flag}\` in Flagsmith, but read-back verification failed (${r.error ?? 'unknown error'}).`);
    }
  }
  for (const r of failed) lines.push(`Could not change \`${r.flag}\`: ${r.error ?? 'unknown error'}`);
  for (const b of outcome.blocked) lines.push(`Blocked by the guardrail at execution time: ${b}`);
  if (outcome.kind === 'failed' && outcome.error) lines.push(`Error: \`${outcome.error.slice(0, 300)}\``);
  return lines.join('\n');
}

/** Rebuilds the original proposal message, swaps the buttons for the outcome. */
export function decidedMessage(
  incidentId: string,
  evidence: Evidence,
  proposal: Proposal,
  outcome: ShedOutcome,
  extras: ProposalExtras = {},
): SlackMessage {
  const original = investigationMessage(incidentId, evidence, proposal, extras);
  const blocks = (original.blocks as { type: string; [key: string]: unknown }[]).filter((b) => b.type !== 'actions');
  blocks.pop(); // drop the "nothing changes until a human approves" footer; it is no longer true
  const header = {
    shed: ':white_check_mark: reports-api: load shed',
    rejected: ':no_entry: reports-api: proposal rejected',
    failed: ':x: reports-api: shedding failed',
    expired: ':hourglass: reports-api: proposal expired',
  }[outcome.kind];
  blocks[0] = { type: 'header', text: { type: 'plain_text', text: header } };
  const closedFooter = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Incident \`${incidentId}\` · proposed by ${proposerText(proposal, extras)} · ${outcome.kind === 'expired' ? 'no decision' : `decided by <@${outcome.decision.userId}>`}`,
      },
    ],
  };
  return {
    text: outcomeText(outcome).replace(/[*:`]/g, ''),
    blocks: [...blocks, { type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: outcomeText(outcome) } }, closedFooter],
  };
}

// ---- Phase 5: restore proposal, its outcome, and the incident report -------------------------


const ms = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

function beforeAfterBlocks(evidence: Evidence, check: Assessment, healthyMinutes: number): unknown[] {
  const before = evidence.metrics.totals;
  const table = [
    '                    during incident   last ' + `${healthyMinutes} min`,
    `throttled requests  ${String(before.throttles).padStart(15)}   ${String(check.throttles).padStart(10)}`,
    `API p90 (worst min) ${ms(before.worstMinuteApiLatencyP90Ms).padStart(15)}   ${ms(check.worstP90Ms).padStart(10)}`,
    `peak concurrency    ${String(before.peakConcurrency).padStart(15)}   ${String(check.peakConcurrency).padStart(10)}`,
  ].join('\n');
  const demand = check.demand
    .filter((d) => d.requestsPerSecond > 0)
    .map((d) => `\`${d.flag}\`: ${d.requestsPerSecond} req/s still arriving × ${ms(d.avgMs)} each ≈ ${d.executionsNeeded} executions`)
    .join('\n');
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*Before and after*\n\`\`\`${table}\`\`\`` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Is it safe to turn back on?*\n${demand ? `${demand}\nNeeded: about ${check.executionsNeeded} executions. Free: ${check.executionsAvailable}.` : `No traffic is reaching the disabled features now, so turning them back on adds no load. Free executions: ${check.executionsAvailable}.`}`,
      },
    },
  ];
}

export function restoreProposalMessage(incidentId: string, evidence: Evidence, flags: string[], check: Assessment, healthyMinutes: number): SlackMessage {
  const list = flags.map((f) => `\`${f}\``).join(', ');
  const value = (decision: ButtonValue['decision']) => JSON.stringify({ incidentId, decision, phase: 'restore' } satisfies ButtonValue);
  return {
    text: `ShedPilot: reports-api has recovered. Turn ${flags.join(', ')} back on? Approval needed.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: ':seedling: reports-api has recovered: turn features back on?' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Proposed: turn ${list} back on.*\nShedPilot checked that the service is ${check.reason}.` } },
      ...beforeAfterBlocks(evidence, check, healthyMinutes),
      {
        type: 'actions',
        block_id: 'restore_decision',
        elements: [
          {
            type: 'button', action_id: 'approve', style: 'primary', text: { type: 'plain_text', text: 'Approve: turn back on' }, value: value('approve'),
            confirm: {
              title: { type: 'plain_text', text: 'Turn flags back on?' },
              text: { type: 'mrkdwn', text: `ShedPilot will turn ${list} back on in Flagsmith.` },
              confirm: { type: 'plain_text', text: 'Turn on' },
              deny: { type: 'plain_text', text: 'Cancel' },
            },
          },
          { type: 'button', action_id: 'reject', text: { type: 'plain_text', text: 'Keep disabled' }, value: value('reject') },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident \`${incidentId}\` · decided by measured numbers, not by an LLM · nothing changes until a human approves` }] },
    ],
  };
}

export type RestoreOutcome =
  | { kind: 'restored'; decision: HumanDecision; results: FlagChangeResult[]; alreadyOn: string[] }
  | { kind: 'kept'; decision: HumanDecision; nextCheck: string }
  | { kind: 'failed'; decision: HumanDecision; results: FlagChangeResult[]; blocked: string[]; error?: string };

export function restoreDecidedMessage(
  incidentId: string, evidence: Evidence, flags: string[], check: Assessment, healthyMinutes: number, outcome: RestoreOutcome,
): SlackMessage {
  const who = `<@${outcome.decision.userId}> at ${alarmTime(outcome.decision.at)}`;
  const lines: string[] = [];
  if (outcome.kind === 'kept') {
    lines.push(`:pause_button: *Kept disabled* by ${who}. ShedPilot will check again after ${outcome.nextCheck}.`);
  } else {
    const ok = outcome.results.filter((r) => r.ok);
    const dry = ok.some((r) => r.dryRun);
    lines.push(outcome.kind === 'restored' ? `:white_check_mark: *Approved* by ${who}.` : `:x: *Approved* by ${who}, but turning flags back on failed. The incident stays open for a human.`);
    if (ok.length) lines.push(dry ? `DRY RUN: would have turned ${ok.map((r) => `\`${r.flag}\``).join(', ')} back on. Nothing was changed.` : `Turned ${ok.map((r) => `\`${r.flag}\``).join(', ')} back on in Flagsmith, and read it back to confirm.`);
    if (outcome.kind === 'restored' && outcome.alreadyOn.length) lines.push(`Already on (someone turned it back on by hand): ${outcome.alreadyOn.join(', ')}`);
    for (const r of outcome.results.filter((r) => !r.ok)) lines.push(`Could not turn \`${r.flag}\` back on: ${r.error ?? 'unknown error'}`);
    if (outcome.kind === 'failed') for (const b of outcome.blocked) lines.push(`Blocked by the guardrail: ${b}`);
    if (outcome.kind === 'failed' && outcome.error) lines.push(`Error: \`${outcome.error.slice(0, 300)}\``);
  }
  const original = restoreProposalMessage(incidentId, evidence, flags, check, healthyMinutes);
  const blocks = (original.blocks as { type: string; [k: string]: unknown }[]).filter((b) => b.type !== 'actions' && b.type !== 'context');
  blocks[0] = {
    type: 'header',
    text: { type: 'plain_text', text: { restored: ':white_check_mark: reports-api: features restored', kept: ':pause_button: reports-api: kept disabled', failed: ':x: reports-api: restore failed' }[outcome.kind] },
  };
  return {
    text: lines.join(' ').replace(/[*:`]/g, ''),
    blocks: [...blocks, { type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }, { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident \`${incidentId}\`` }] }],
  };
}

/** "1 h 4 min", "12 min", "45 s" */
export function duration(fromIso: string, toIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export interface ReportInput {
  incidentId: string;
  createdAt: string;
  shedAt?: string;
  resolvedAt: string;
  evidence: Evidence;
  proposal: Proposal;
  shedFlags: string[];
  shedDecision?: HumanDecision;
  restoreDecision?: HumanDecision;
  guardrailRejections?: string[];
  proposer: string;
  events: IncidentEvent[];
}

/** The short incident report posted when an incident is resolved. */
export function incidentReportMessage(r: ReportInput): SlackMessage {
  const t = r.evidence.metrics.totals;
  const top = r.evidence.logs.features[0];
  const proposalAt = r.events.find((e) => e.to === 'PENDING_APPROVAL')?.at;
  const timeline = r.events
    .slice(0, 25)
    .map((e) => `${e.at.slice(11, 19)}  ${e.message}`)
    .join('\n')
    .slice(0, 2600);
  const summary = [
    `*Service:* reports-api   *Flags shed:* ${r.shedFlags.map((f) => `\`${f}\``).join(', ') || 'none'}`,
    `*Total time degraded:* ${r.shedAt ? duration(r.shedAt, r.resolvedAt) : 'n/a'}   *Alarm to proposal:* ${proposalAt ? duration(r.createdAt, proposalAt) : 'n/a'}   *Alarm to resolution:* ${duration(r.createdAt, r.resolvedAt)}`,
    `*Shed approved by:* ${r.shedDecision ? `<@${r.shedDecision.userId}>` : 'n/a'}   *Restore approved by:* ${r.restoreDecision ? `<@${r.restoreDecision.userId}>` : 'n/a'}`,
  ].join('\n');
  const cause = top
    ? `${top.flag} used ${Math.round(top.computeShare * 100)}% of compute (${top.requests} requests, avg ${top.avgMs} ms). ${t.throttles} requests were throttled and concurrency peaked at ${t.peakConcurrency}.`
    : r.proposal.diagnosis;
  return {
    text: `Incident report ${r.incidentId}: resolved after ${r.shedAt ? duration(r.shedAt, r.resolvedAt) : 'n/a'} degraded.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `:clipboard: Incident report: ${r.incidentId}` } },
      { type: 'section', text: { type: 'mrkdwn', text: summary } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Cause (measured):* ${cause}\n*Proposed by:* ${r.proposer}` } },
      ...(r.guardrailRejections?.length ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Blocked by the guardrail:* ${r.guardrailRejections.join('; ')}` } }] : []),
      { type: 'section', text: { type: 'mrkdwn', text: `*Timeline (UTC)*\n\`\`\`${timeline}\`\`\`` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Every flag change above was approved by a human in Slack and recorded in DynamoDB before it happened.' }] },
    ],
  };
}
