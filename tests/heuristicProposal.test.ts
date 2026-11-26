import { describe, expect, it } from 'vitest';
import { heuristicProposal } from '../agent/investigator/heuristicProposal';
import { FLAGS, spikeEvidence } from './fixtures';

describe('Phase 2 rule-based proposal', () => {
  it('proposes turning off pdf_export, and only that, for the real spike', () => {
    const proposal = heuristicProposal(spikeEvidence());
    expect(proposal.actions.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(proposal.actions[0].action).toBe('disable');
    expect(proposal.diagnosis).toContain('95%');
    expect(proposal.actions[0].user_impact).toContain('PDF report export');
    // 95% of execution time at a peak of 10 executions: roughly 9 of them.
    expect(proposal.actions[0].expected_effect).toContain('roughly 9 of them');
  });

  it('lists only meaningful alternatives, and never offers the untagged flag as an option', () => {
    const alternatives = heuristicProposal(spikeEvidence()).alternatives_considered.join('\n');
    expect(alternatives).toContain('Also turn off rich_analytics');
    expect(alternatives).not.toContain('checkout_core'); // 0% of compute: not worth mentioning
    expect(alternatives).toContain('Do nothing');
  });

  it('refuses when the most expensive feature is not tagged load-sheddable', () => {
    const evidence = spikeEvidence();
    evidence.logs.features = [{ ...evidence.logs.features[0], flag: 'checkout_core' }];
    const proposal = heuristicProposal(evidence);
    expect(proposal.actions).toEqual([]);
    expect(proposal.diagnosis).toContain('not tagged load-sheddable');
  });

  it('refuses when the expensive flag is already off', () => {
    const flags = FLAGS.map((f) => (f.name === 'pdf_export' ? { ...f, enabled: false } : f));
    expect(heuristicProposal(spikeEvidence({ flags })).actions).toEqual([]);
  });

  it('proposes nothing when the metrics show no stress', () => {
    const evidence = spikeEvidence();
    evidence.metrics.totals = { ...evidence.metrics.totals, throttles: 0, api5xx: 0 };
    const proposal = heuristicProposal(evidence);
    expect(proposal.actions).toEqual([]);
    expect(proposal.diagnosis).toContain('no throttling');
  });

  it('proposes nothing when no feature dominates compute', () => {
    const evidence = spikeEvidence();
    evidence.logs.features = evidence.logs.features.map((f) => ({ ...f, computeShare: 0.2 }));
    const proposal = heuristicProposal(evidence);
    expect(proposal.actions).toEqual([]);
    expect(proposal.confidence).toBe('low');
  });
});
