import { describe, expect, it } from 'vitest';
import { heuristicProposal } from '../agent/investigator/heuristicProposal';
import { alarmTime, decidedMessage, investigationMessage, noSafeActionMessage } from '../agent/lib/slackMessages';
import { spikeEvidence } from './fixtures';

type Block = { type: string; elements?: { action_id?: string; value?: string; confirm?: unknown }[]; text?: { text: string } };

describe('Slack investigation message', () => {
  const evidence = spikeEvidence();
  const message = investigationMessage('inc-1', evidence, heuristicProposal(evidence));
  const blocks = message.blocks as Block[];

  it('carries the incident and decision in each button', () => {
    const buttons = blocks.find((b) => b.type === 'actions')!.elements!;
    expect(buttons.map((b) => b.action_id)).toEqual(['approve', 'reject']);
    expect(JSON.parse(buttons[0].value!)).toEqual({ incidentId: 'inc-1', decision: 'approve', phase: 'shed' });
    expect(buttons[0].confirm).toBeDefined(); // Approve asks "are you sure?"
  });

  it('shows the measured numbers and the proposed flag', () => {
    const text = JSON.stringify(blocks);
    expect(text).toContain('676'); // throttles
    expect(text).toContain('3.6 s'); // worst-minute p90
    expect(text).toContain('turn off `pdf_export`');
    expect(message.text).toContain('pdf_export');
  });

  it('stays within Slack limits even when every action field is 1000 chars', () => {
    const long = 'x'.repeat(1000);
    const base = heuristicProposal(evidence);
    const oversized = {
      ...base,
      actions: [{ flag: 'pdf_export', action: 'disable' as const, reason: long, evidence: long, expected_effect: long, user_impact: long }],
    };
    const oversizedBlocks = investigationMessage('inc-1', evidence, oversized).blocks as Block[];
    expect(oversizedBlocks.length).toBeLessThanOrEqual(50);
    for (const b of oversizedBlocks) if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });

  it('has no buttons when there is no safe action', () => {
    const none = noSafeActionMessage('inc-2', evidence, { ...heuristicProposal(evidence), actions: [] });
    expect((none.blocks as Block[]).some((b) => b.type === 'actions')).toBe(false);
  });
});

describe('alarm time', () => {
  it('turns the CloudWatch timestamp into a short UTC time', () => {
    expect(alarmTime('2026-11-13T13:26:27.251+0000')).toBe('13:26:27 UTC');
    expect(alarmTime('not a date')).toBe('not a date');
  });
});

describe('Slack message after a decision', () => {
  const evidence = spikeEvidence();
  const proposal = heuristicProposal(evidence);
  const decision = { decision: 'approve' as const, userId: 'U123', userName: 'jeevesh', at: '2026-11-14T10:00:05Z' };

  it('replaces the buttons with who approved and what changed', () => {
    const msg = decidedMessage('inc-1', evidence, proposal, {
      kind: 'shed', decision, blocked: [],
      results: [{ flag: 'pdf_export', featureId: 1, ok: true, dryRun: false, enabledAfter: false }],
    });
    const text = JSON.stringify(msg.blocks);
    expect((msg.blocks as Block[]).some((b) => b.type === 'actions')).toBe(false);
    expect(text).toContain('<@U123> at 10:00:05 UTC');
    expect(text).toContain('Turned off `pdf_export` in Flagsmith');
    expect(text).not.toContain('nothing changes until a human approves');
    expect(text).toContain('decided by <@U123>');
  });

  it('says clearly when it was a dry run', () => {
    const msg = decidedMessage('inc-1', evidence, proposal, {
      kind: 'shed', decision, blocked: [], results: [{ flag: 'pdf_export', ok: true, dryRun: true }],
    });
    expect(JSON.stringify(msg.blocks)).toContain('DRY RUN');
  });

  it('reports a rejection without claiming any change', () => {
    const msg = decidedMessage('inc-1', evidence, proposal, { kind: 'rejected', decision: { ...decision, decision: 'reject' } });
    expect(JSON.stringify(msg.blocks)).toContain('No flags were changed');
  });
});

describe('investigating message', () => {
  it('tells on-call what is happening and when to expect an update', async () => {
    const { investigatingMessage } = await import('../agent/lib/slackMessages');
    const text = JSON.stringify(investigatingMessage('inc-1', 'shedpilot-reports-api-throttles', '2026-11-13T16:36:17.000+0000', 60, 'openai/gpt-oss-120b').blocks);
    expect(text).toContain('16:36:17 UTC');
    expect(text).toContain('about 60 s');
    expect(text).toContain('openai/gpt-oss-120b');
    expect(text).toContain('no flags will change without a human approval');
  });
});
