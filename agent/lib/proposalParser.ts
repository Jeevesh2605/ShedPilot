/**
 * Parses and validates the LLM's answer. The model's output is untrusted text: even with a strict
 * schema on the API side, this code checks every field again before anything uses it.
 * It does NOT decide whether an action is safe; that is the guardrail's job (guardrails.ts).
 */
import type { Proposal } from './types';

const MAX_TEXT = 1000; // keeps Slack blocks well under their 3,000-character limit
const ACTION_FIELDS = ['flag', 'action', 'reason', 'evidence', 'expected_effect', 'user_impact'] as const;

export type ParseResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export function parseProposal(rawText: string, model: string): ParseResult {
  // Some models wrap JSON in a markdown code fence despite instructions; accept that one variation.
  const text = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isObject(data)) return { ok: false, error: 'top level is not a JSON object' };

  if (typeof data.diagnosis !== 'string' || !data.diagnosis.trim()) return { ok: false, error: 'diagnosis must be a non-empty string' };
  if (!Array.isArray(data.actions)) return { ok: false, error: 'actions must be an array' };
  if (!Array.isArray(data.alternatives_considered) || !data.alternatives_considered.every((a) => typeof a === 'string')) {
    return { ok: false, error: 'alternatives_considered must be an array of strings' };
  }
  if (data.confidence !== 'low' && data.confidence !== 'medium' && data.confidence !== 'high') {
    return { ok: false, error: 'confidence must be low, medium or high' };
  }

  const actions: Proposal['actions'] = [];
  for (const [i, raw] of data.actions.entries()) {
    if (!isObject(raw)) return { ok: false, error: `actions[${i}] is not an object` };
    for (const field of ACTION_FIELDS) {
      if (typeof raw[field] !== 'string') return { ok: false, error: `actions[${i}].${field} must be a string` };
    }
    // Keep the action value as given: the guardrail rejects anything other than "disable", visibly.
    actions.push({
      flag: clip(raw.flag as string),
      action: raw.action as 'disable',
      reason: clip(raw.reason as string),
      evidence: clip(raw.evidence as string),
      expected_effect: clip(raw.expected_effect as string),
      user_impact: clip(raw.user_impact as string),
    });
  }

  return {
    ok: true,
    proposal: {
      proposedBy: 'llm',
      model,
      diagnosis: clip(data.diagnosis),
      actions,
      alternatives_considered: data.alternatives_considered.slice(0, 8).map((a) => clip(a as string)),
      confidence: data.confidence,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
}
