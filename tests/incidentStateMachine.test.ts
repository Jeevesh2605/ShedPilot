import { describe, expect, it } from 'vitest';
import { buildUpdate, canTransition, newIncidentId, RELEASES_LOCK, TRANSITIONS } from '../agent/lib/incidents';

describe('incident state machine', () => {
  it('follows the happy path from alarm to resolution', () => {
    const path = ['INVESTIGATING', 'PENDING_APPROVAL', 'APPROVED', 'SHED', 'RESTORE_PROPOSED', 'RESTORE_APPROVED', 'RESOLVED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('never lets a flag change start without approval', () => {
    // The only way into APPROVED or RESTORE_APPROVED is from a pending proposal.
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      if (targets.includes('APPROVED')) expect(from).toBe('PENDING_APPROVAL');
      if (targets.includes('RESTORE_APPROVED')) expect(from).toBe('RESTORE_PROPOSED');
    }
  });

  it('rejects skipping approval or reviving a closed incident', () => {
    expect(canTransition('INVESTIGATING', 'SHED')).toBe(false);
    expect(canTransition('PENDING_APPROVAL', 'SHED')).toBe(false);
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false);
    expect(canTransition('RESOLVED', 'INVESTIGATING')).toBe(false);
  });

  it('lets "keep disabled" send a restore proposal back to SHED', () => {
    expect(canTransition('RESTORE_PROPOSED', 'SHED')).toBe(true);
  });

  it('keeps the lock after FAILED so a human looks first', () => {
    expect(RELEASES_LOCK).not.toContain('FAILED');
    expect(TRANSITIONS.FAILED).toEqual([]);
  });

  it('makes readable, unique incident IDs', () => {
    const id = newIncidentId(new Date('2026-11-13T09:15:02Z'));
    expect(id).toMatch(/^inc-20261113-091502-[0-9a-f]{4}$/);
    expect(newIncidentId()).not.toBe(newIncidentId());
  });

  it('builds DynamoDB updates with placeholders and skips undefined fields', () => {
    const update = buildUpdate({ status: 'SHED', note: undefined, 'approved-by': 'U1' });
    expect(update.expression).toBe('SET #f0 = :v0, #f1 = :v1');
    expect(update.names).toEqual({ '#f0': 'status', '#f1': 'approved-by' });
    expect(update.values).toEqual({ ':v0': 'SHED', ':v1': 'U1' });
  });
});
