import { describe, expect, it } from 'vitest';
import { DECISIONS, parseButtonValue } from '../agent/lib/decisions';
import { canTransition } from '../agent/lib/incidents';

describe('Slack button decisions', () => {
  it('maps every button to a transition the state machine allows', () => {
    for (const phase of Object.values(DECISIONS)) {
      for (const { from, to } of Object.values(phase)) expect(canTransition(from, to)).toBe(true);
    }
  });

  it('parses a valid button value', () => {
    expect(parseButtonValue('{"incidentId":"inc-20261113-134327-141b","decision":"approve","phase":"shed"}')).toEqual({
      incidentId: 'inc-20261113-134327-141b', decision: 'approve', phase: 'shed',
    });
  });

  it('rejects anything malformed or unexpected', () => {
    expect(parseButtonValue('not json')).toBeNull();
    expect(parseButtonValue(undefined)).toBeNull();
    expect(parseButtonValue('{"incidentId":"inc-1","decision":"delete_everything","phase":"shed"}')).toBeNull();
    expect(parseButtonValue('{"incidentId":"../../etc","decision":"approve","phase":"shed"}')).toBeNull();
  });
});
