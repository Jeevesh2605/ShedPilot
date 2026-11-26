/**
 * The proposal flow with a fake LLM. These tests show the core safety property:
 * whatever the model says, only guardrail-approved actions ever reach the approval buttons.
 */
import { describe, expect, it } from 'vitest';
import { decide } from '../agent/investigator/propose';
import { buildUserMessage } from '../agent/investigator/prompt';
import { RogueDemoProvider, type LlmProvider, type LlmRequest } from '../agent/lib/llm';
import { investigationMessage, noSafeActionMessage } from '../agent/lib/slackMessages';
import { spikeEvidence } from './fixtures';

const action = (flag: string, act = 'disable') => ({ flag, action: act, reason: 'r', evidence: 'e', expected_effect: 'x', user_impact: 'u' });
const answer = (...actions: object[]) => JSON.stringify({ diagnosis: 'Overloaded.', actions, alternatives_considered: ['Do nothing'], confidence: 'high' });

/** A fake model that returns the given answers in order (or throws). */
function fakeLlm(...replies: (string | Error)[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    name: 'fake',
    requests,
    async complete(request) {
      requests.push(request);
      const reply = replies.shift() ?? new Error('no more replies');
      if (reply instanceof Error) throw reply;
      return { text: reply, model: 'fake-model', latencyMs: 1200 };
    },
  };
}

describe('LLM proposal + guardrail', () => {
  it('passes a correct LLM proposal through', async () => {
    const decision = await decide(spikeEvidence(), fakeLlm(answer(action('pdf_export'))));
    expect(decision.proposal.proposedBy).toBe('llm');
    expect(decision.proposal.actions.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(decision.guardrailRejections).toEqual([]);
  });

  it('BLOCKS checkout_core when the model proposes it', async () => {
    const decision = await decide(spikeEvidence(), fakeLlm(answer(action('checkout_core'))));
    expect(decision.proposal.actions).toEqual([]); // nothing left to approve
    expect(decision.originalActions.map((a) => a.flag)).toEqual(['checkout_core']); // but we keep a record
    expect(decision.guardrailRejections).toEqual(['checkout_core: missing tag load-sheddable']);

    const message = JSON.stringify(noSafeActionMessage('inc-1', spikeEvidence(), decision.proposal, { guardrailRejections: decision.guardrailRejections }).blocks);
    expect(message).toContain('Blocked by the guardrail');
    expect(message).toContain('checkout_core: missing tag load-sheddable');
    expect(message).not.toContain('"actions"'); // no buttons
  });

  it('keeps the safe half of a mixed proposal and shows what was blocked', async () => {
    const decision = await decide(spikeEvidence(), fakeLlm(answer(action('pdf_export'), action('checkout_core'), action('made_up'))));
    expect(decision.proposal.actions.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(decision.guardrailRejections).toEqual(['checkout_core: missing tag load-sheddable', 'made_up: no such flag in Flagsmith']);

    const blocks = investigationMessage('inc-1', spikeEvidence(), decision.proposal, { guardrailRejections: decision.guardrailRejections }).blocks as { type: string; elements?: { value?: string }[] }[];
    const text = JSON.stringify(blocks);
    expect(text).toContain('turn off `pdf_export`');
    expect(text).toContain('checkout_core: missing tag load-sheddable');
    expect(blocks.filter((b) => b.type === 'actions')).toHaveLength(1);
  });

  it('blocks actions other than "disable"', async () => {
    const decision = await decide(spikeEvidence(), fakeLlm(answer(action('pdf_export', 'delete'))));
    expect(decision.proposal.actions).toEqual([]);
    expect(decision.guardrailRejections[0]).toContain('action must be "disable"');
  });

  it('retries once with the parse error when the answer is malformed', async () => {
    const llm = fakeLlm('{"diagnosis": "trunc', answer(action('pdf_export')));
    const decision = await decide(spikeEvidence(), llm);
    expect(decision.proposal.proposedBy).toBe('llm');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1].user).toContain('Your previous answer was rejected: not valid JSON');
    expect(decision.llm?.attempts.map((a) => Boolean(a.error))).toEqual([true, false]);
  });

  it('falls back to the rule-based proposal, visibly, after two malformed answers', async () => {
    const decision = await decide(spikeEvidence(), fakeLlm('nope', 'still nope'));
    expect(decision.llm?.fellBackToRules).toBe(true);
    expect(decision.proposal.proposedBy).toBe('heuristic');
    expect(decision.proposal.diagnosis).toContain('rule-based fallback');
    expect(decision.proposal.actions.map((a) => a.flag)).toEqual(['pdf_export']);
  });

  it('falls back without retrying when the API itself fails (e.g. rate limit)', async () => {
    const llm = fakeLlm(new Error('xAI HTTP 429: rate limited'));
    const decision = await decide(spikeEvidence(), llm);
    expect(llm.requests).toHaveLength(1);
    expect(decision.llm?.fellBackToRules).toBe(true);
    expect(decision.proposal.diagnosis).toContain('xAI HTTP 429');
  });

  it('uses only the rules when no LLM is configured', async () => {
    const decision = await decide(spikeEvidence(), null);
    expect(decision.llm).toBeUndefined();
    expect(decision.proposal.proposedBy).toBe('heuristic');
  });

  it('sends the model the numbers and flags it needs, as data', async () => {
    const llm = fakeLlm(answer(action('pdf_export')));
    await decide(spikeEvidence(), llm);
    const user = llm.requests[0].user;
    expect(user).toContain('"share_of_compute":0.947');
    expect(user).toContain('"throttles":676');
    expect(user).toContain('"checkout_core"');
    expect(llm.requests[0].system).toContain('MINIMUM set');
    expect(llm.requests[0].schema).toMatchObject({ required: ['diagnosis', 'actions', 'alternatives_considered', 'confidence'] });
    expect(buildUserMessage(spikeEvidence())).not.toMatch(/ser\.|Api-Key|xoxb-/); // no secrets in the prompt
  });

  it('the rogue demo model proposes checkout_core and the guardrail strips it, labelled as simulated', async () => {
    const decision = await decide(spikeEvidence(), new RogueDemoProvider());
    expect(decision.originalActions.map((a) => a.flag)).toEqual(['pdf_export', 'checkout_core']);
    expect(decision.proposal.actions.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(decision.guardrailRejections).toEqual(['checkout_core: missing tag load-sheddable']);
    expect(decision.proposal.model).toContain('SIMULATED');
    expect(decision.proposal.diagnosis).toContain('SIMULATED');
  });
});
