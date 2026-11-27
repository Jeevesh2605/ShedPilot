import { describe, expect, it } from 'vitest';
import { buildDemandQuery, parseDemandRow } from '../agent/lib/cloudwatch';
import { assessRecovery } from '../agent/recovery/assess';
import { duration, incidentReportMessage, restoreDecidedMessage, restoreProposalMessage } from '../agent/lib/slackMessages';
import { heuristicProposal } from '../agent/investigator/heuristicProposal';
import { spikeEvidence } from './fixtures';

const check = assessRecovery(
  {
    now: new Date('2026-11-14T10:30:00Z'), shedAt: '2026-11-14T10:15:00Z', peakConcurrency: 1, demandWindowSeconds: 180,
    minutes: [1, 2, 3].map(() => ({ minute: 'x', invocations: 200, throttles: 0, errors: 0, concurrencyMax: 1, apiLatencyP90Ms: 110, api5xx: 0 })),
    demand: [{ flag: 'pdf_export', requests: 18 }], featureAvgMs: { pdf_export: 3255 },
  },
  { healthyMinutes: 3, healthyP90Ms: 1500, concurrencyLimit: 10, headroomFraction: 0.6, cooldownMinutes: 10 },
);
const decision = { decision: 'approve' as const, userId: 'U9', userName: 'oncall', at: '2026-11-14T10:31:00Z' };

describe('demand query', () => {
  it('counts degraded requests per shed flag (false is 0 in the logs)', () => {
    expect(buildDemandQuery(['pdf_export'])).toContain('sum(features_evaluated.pdf_export = 0) as pdf_export__off');
    expect(parseDemandRow([{ field: 'pdf_export__off', value: '1021' }], ['pdf_export', 'basic_csv'])).toEqual([
      { flag: 'pdf_export', requests: 1021 }, { flag: 'basic_csv', requests: 0 },
    ]);
  });
});

describe('restore proposal message', () => {
  const msg = restoreProposalMessage('inc-1', spikeEvidence(), ['pdf_export'], check, 3);
  const text = JSON.stringify(msg.blocks);

  it('shows before and after numbers and the capacity reasoning', () => {
    expect(text).toContain('676'); // throttles during the incident
    expect(text).toContain('3.6 s'); // p90 during
    expect(text).toContain('110 ms'); // p90 now
    expect(text).toContain('0.1 req/s still arriving');
    expect(text).toContain('Free: 5');
  });

  it('carries restore decisions on its buttons', () => {
    const actions = (msg.blocks as { type: string; elements?: { value: string; text: { text: string } }[] }[]).find((b) => b.type === 'actions')!;
    expect(actions.elements!.map((e) => e.text.text)).toEqual(['Approve: turn back on', 'Keep disabled']);
    expect(JSON.parse(actions.elements![0].value)).toEqual({ incidentId: 'inc-1', decision: 'approve', phase: 'restore' });
  });

  it('replaces the buttons with the outcome after a decision', () => {
    const done = JSON.stringify(restoreDecidedMessage('inc-1', spikeEvidence(), ['pdf_export'], check, 3, {
      kind: 'restored', decision, alreadyOn: [], results: [{ flag: 'pdf_export', ok: true, dryRun: false, enabledAfter: true }],
    }).blocks);
    expect(done).not.toContain('"type":"actions"');
    expect(done).toContain('Turned `pdf_export` back on in Flagsmith');
    const kept = JSON.stringify(restoreDecidedMessage('inc-1', spikeEvidence(), ['pdf_export'], check, 3, { kind: 'kept', decision, nextCheck: '10:41 UTC' }).blocks);
    expect(kept).toContain('Kept disabled');
    expect(kept).toContain('10:41 UTC');
  });
});

describe('incident report', () => {
  it('summarises duration, approvers, cause and timeline', () => {
    const events = [
      { at: '2026-11-14T10:10:00Z', message: 'Alarm received' },
      { at: '2026-11-14T10:11:05Z', message: 'Proposed turning off pdf_export', to: 'PENDING_APPROVAL' as const },
      { at: '2026-11-14T10:12:00Z', message: 'Approved by oncall' },
    ];
    const msg = incidentReportMessage({
      incidentId: 'inc-1', createdAt: '2026-11-14T10:10:00Z', shedAt: '2026-11-14T10:12:10Z', resolvedAt: '2026-11-14T10:32:10Z',
      evidence: spikeEvidence(), proposal: heuristicProposal(spikeEvidence()), shedFlags: ['pdf_export'],
      shedDecision: decision, restoreDecision: decision, proposer: 'openai/gpt-oss-120b', events,
      guardrailRejections: ['checkout_core: missing tag load-sheddable'],
    });
    const text = JSON.stringify(msg.blocks);
    expect(text).toContain('*Total time degraded:* 20 min');
    expect(text).toContain('*Alarm to proposal:* 1 min');
    expect(text).toContain('pdf_export used 95% of compute');
    expect(text).toContain('checkout_core: missing tag load-sheddable');
    expect(text).toContain('10:11:05  Proposed turning off pdf_export');
    expect(text).toContain('openai/gpt-oss-120b');
  });

  it('formats durations', () => {
    expect(duration('2026-11-14T10:00:00Z', '2026-11-14T10:00:45Z')).toBe('45 s');
    expect(duration('2026-11-14T10:00:00Z', '2026-11-14T11:04:00Z')).toBe('1 h 4 min');
  });
});
