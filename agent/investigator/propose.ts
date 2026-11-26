/**
 * Turns evidence into a guardrailed proposal:
 *   1. ask the LLM (if configured), parse strictly, retry once if the answer is malformed;
 *   2. if the LLM is unavailable or keeps failing, fall back to the rule-based proposal, and say so;
 *   3. run the guardrail on whatever came back: drop unsafe actions and record why.
 * The provider is passed in, so tests can use a fake model.
 */
import { checkShedActions, describeRejections } from '../lib/guardrails';
import type { LlmProvider } from '../lib/llm';
import { parseProposal } from '../lib/proposalParser';
import type { Evidence, Proposal } from '../lib/types';
import { heuristicProposal } from './heuristicProposal';
import { PROPOSAL_SCHEMA, SYSTEM_PROMPT, buildUserMessage } from './prompt';

export interface LlmTrace {
  provider: string;
  model?: string;
  attempts: { latencyMs?: number; error?: string; rawText?: string }[];
  fellBackToRules: boolean;
}

export interface Decision {
  proposal: Proposal; // actions contain ONLY guardrail-approved actions
  originalActions: Proposal['actions']; // what was proposed before the guardrail
  guardrailRejections: string[]; // e.g. "checkout_core: missing tag load-sheddable"
  llm?: LlmTrace;
}

export async function decide(evidence: Evidence, provider: LlmProvider | null): Promise<Decision> {
  let proposal: Proposal;
  let llm: LlmTrace | undefined;

  if (provider) {
    llm = { provider: provider.name, attempts: [], fellBackToRules: false };
    proposal = (await askLlm(provider, evidence, llm)) ?? fallback(evidence, llm);
  } else {
    proposal = heuristicProposal(evidence);
  }

  const guard = checkShedActions(proposal.actions, evidence.flags);
  return {
    proposal: { ...proposal, actions: guard.allowed },
    originalActions: proposal.actions,
    guardrailRejections: describeRejections(guard.rejected),
    llm,
  };
}

async function askLlm(provider: LlmProvider, evidence: Evidence, trace: LlmTrace): Promise<Proposal | undefined> {
  let user = buildUserMessage(evidence);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await provider.complete({ system: SYSTEM_PROMPT, user, schemaName: 'shedding_proposal', schema: PROPOSAL_SCHEMA });
      trace.model = response.model;
      const parsed = parseProposal(response.text, response.model);
      if (parsed.ok) {
        trace.attempts.push({ latencyMs: response.latencyMs });
        return parsed.proposal;
      }
      trace.attempts.push({ latencyMs: response.latencyMs, error: `malformed answer: ${parsed.error}`, rawText: response.text.slice(0, 2000) });
      // One retry, telling the model exactly what was wrong.
      user = `${buildUserMessage(evidence)}\n\nYour previous answer was rejected: ${parsed.error}. Return only JSON matching the schema.`;
    } catch (err) {
      trace.attempts.push({ error: err instanceof Error ? err.message : String(err) });
      return undefined; // network/API errors: don't hammer a struggling API, fall back
    }
  }
  return undefined;
}

function fallback(evidence: Evidence, trace: LlmTrace): Proposal {
  trace.fellBackToRules = true;
  const proposal = heuristicProposal(evidence);
  const lastError = trace.attempts[trace.attempts.length - 1]?.error ?? 'unknown error';
  return { ...proposal, diagnosis: `${proposal.diagnosis} (The LLM was unavailable: ${lastError.slice(0, 150)}. This is the rule-based fallback.)` };
}
