import { describe, expect, it } from 'vitest';
import { extractChatContent, extractOutputText } from '../agent/lib/llm';
import { parseProposal } from '../agent/lib/proposalParser';

const valid = {
  diagnosis: 'pdf_export used 94% of compute.',
  actions: [{ flag: 'pdf_export', action: 'disable', reason: 'r', evidence: 'e', expected_effect: 'x', user_impact: 'u' }],
  alternatives_considered: ['Do nothing'],
  confidence: 'high',
};

describe('LLM response parser', () => {
  it('accepts a valid answer and marks it as an LLM proposal', () => {
    const result = parseProposal(JSON.stringify(valid), 'grok-4.7');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal).toMatchObject({ proposedBy: 'llm', model: 'grok-4.7', confidence: 'high' });
  });

  it('accepts JSON wrapped in a markdown code fence', () => {
    expect(parseProposal('```json\n' + JSON.stringify(valid) + '\n```', 'm').ok).toBe(true);
  });

  it('rejects malformed JSON with a useful error', () => {
    const result = parseProposal('{"diagnosis": "cut off mid-sent', 'm');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^not valid JSON/);
  });

  it('rejects prose, arrays and empty answers', () => {
    expect(parseProposal('I think you should turn off pdf_export.', 'm').ok).toBe(false);
    expect(parseProposal('[]', 'm')).toEqual({ ok: false, error: 'top level is not a JSON object' });
    expect(parseProposal('', 'm').ok).toBe(false);
  });

  it('rejects missing or wrongly typed fields', () => {
    expect(parseProposal(JSON.stringify({ ...valid, diagnosis: '' }), 'm')).toEqual({ ok: false, error: 'diagnosis must be a non-empty string' });
    expect(parseProposal(JSON.stringify({ ...valid, actions: 'pdf_export' }), 'm')).toEqual({ ok: false, error: 'actions must be an array' });
    expect(parseProposal(JSON.stringify({ ...valid, confidence: 'very high' }), 'm')).toEqual({ ok: false, error: 'confidence must be low, medium or high' });
    const noFlag = { ...valid, actions: [{ ...valid.actions[0], flag: 42 }] };
    expect(parseProposal(JSON.stringify(noFlag), 'm')).toEqual({ ok: false, error: 'actions[0].flag must be a string' });
  });

  it('keeps an unexpected action value so the guardrail can reject it visibly', () => {
    const odd = { ...valid, actions: [{ ...valid.actions[0], action: 'delete' }] };
    const result = parseProposal(JSON.stringify(odd), 'm');
    expect(result.ok && result.proposal.actions[0].action).toBe('delete');
  });

  it('clips very long text so Slack messages stay within limits', () => {
    const long = { ...valid, diagnosis: 'x'.repeat(5000) };
    const result = parseProposal(JSON.stringify(long), 'm');
    expect(result.ok && result.proposal.diagnosis.length).toBe(1000);
  });
});

describe('xAI Responses API body', () => {
  it('finds the output_text inside the message item, skipping reasoning items', () => {
    const body = {
      status: 'completed',
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: '{"a":1}' }] },
      ],
    };
    expect(extractOutputText(body)).toBe('{"a":1}');
    expect(extractOutputText({ output: [] })).toBeUndefined();
  });
});

describe('Groq Chat Completions body', () => {
  it('returns the content of a finished answer', () => {
    expect(extractChatContent({ choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }] })).toBe('{"a":1}');
  });

  it('refuses truncated answers, refusals and empty bodies', () => {
    expect(() => extractChatContent({ choices: [{ finish_reason: 'length', message: { content: '{"a":' } }] })).toThrow('finish_reason length');
    expect(() => extractChatContent({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] })).toThrow('model refused');
    expect(() => extractChatContent({})).toThrow('no choices');
  });
});
