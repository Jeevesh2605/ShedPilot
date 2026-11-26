/**
 * What each Slack button does to an incident's status. Pure, so it is easy to test.
 * The callback applies the change with a conditional write: if the incident is not in the
 * "from" status (double click, Slack retry, someone else was faster), nothing happens.
 */
import type { IncidentStatus } from './incidents';
import type { ButtonValue } from './slackMessages';

export const DECISIONS: Record<ButtonValue['phase'], Record<ButtonValue['decision'], { from: IncidentStatus; to: IncidentStatus }>> = {
  shed: {
    approve: { from: 'PENDING_APPROVAL', to: 'APPROVED' },
    reject: { from: 'PENDING_APPROVAL', to: 'REJECTED' },
  },
  restore: {
    approve: { from: 'RESTORE_PROPOSED', to: 'RESTORE_APPROVED' },
    reject: { from: 'RESTORE_PROPOSED', to: 'SHED' }, // "Keep disabled"
  },
};

/** Button values come back from Slack as strings; treat them as untrusted input. */
export function parseButtonValue(value: unknown): ButtonValue | null {
  if (typeof value !== 'string') return null;
  try {
    const v = JSON.parse(value) as Partial<ButtonValue>;
    const validId = typeof v.incidentId === 'string' && /^inc-[0-9a-z-]+$/.test(v.incidentId);
    const validDecision = v.decision === 'approve' || v.decision === 'reject';
    const validPhase = v.phase === 'shed' || v.phase === 'restore';
    return validId && validDecision && validPhase ? (v as ButtonValue) : null;
  } catch {
    return null;
  }
}

/** The message the executor receives from the callback. */
export interface ExecutorEvent {
  incidentId: string;
  phase: ButtonValue['phase'];
  decision: ButtonValue['decision'];
}
