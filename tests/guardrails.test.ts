import { describe, expect, it } from 'vitest';
import { checkRestoreFlags, checkShedActions, describeRejections } from '../agent/lib/guardrails';
import { FLAGS } from './fixtures';

const disable = (flag: string) => ({ flag, action: 'disable', reason: 'r', evidence: 'e', expected_effect: 'x', user_impact: 'u' });

describe('guardrail for shedding', () => {
  it('allows an enabled, load-sheddable flag', () => {
    const result = checkShedActions([disable('pdf_export')], FLAGS);
    expect(result.allowed.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(result.rejected).toEqual([]);
  });

  it('blocks checkout_core because it is not tagged load-sheddable', () => {
    const result = checkShedActions([disable('checkout_core')], FLAGS);
    expect(result.allowed).toEqual([]);
    expect(describeRejections(result.rejected)).toEqual(['checkout_core: missing tag load-sheddable']);
  });

  it('keeps the safe action and drops the unsafe one from a mixed proposal', () => {
    const result = checkShedActions([disable('pdf_export'), disable('checkout_core')], FLAGS);
    expect(result.allowed.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(result.rejected.map((r) => r.flag)).toEqual(['checkout_core']);
  });

  it('blocks unknown flags, flags already off, duplicates and other actions', () => {
    const flags = FLAGS.map((f) => (f.name === 'basic_csv' ? { ...f, enabled: false } : f));
    const result = checkShedActions(
      [disable('made_up_flag'), disable('basic_csv'), disable('pdf_export'), disable('pdf_export'), { ...disable('rich_analytics'), action: 'delete' }],
      flags,
    );
    expect(result.allowed.map((a) => a.flag)).toEqual(['pdf_export']);
    expect(describeRejections(result.rejected)).toEqual([
      'made_up_flag: no such flag in Flagsmith',
      'basic_csv: flag is already off',
      'pdf_export: duplicate of an earlier action',
      'rich_analytics: action must be "disable", got "delete"',
    ]);
  });

  it('survives junk input (LLM output is untrusted)', () => {
    const result = checkShedActions([null, 42, 'pdf_export', { flag: { evil: true } }], FLAGS);
    expect(result.allowed).toEqual([]);
    expect(result.rejected).toHaveLength(4);
  });

  it('caps the number of flags in one proposal', () => {
    const many = Array.from({ length: 5 }, (_, i) => `f${i}`);
    const flags = many.map((name, id) => ({ name, id, enabled: true, tags: ['load-sheddable'], description: null }));
    const result = checkShedActions(many.map(disable), flags);
    expect(result.allowed).toHaveLength(3);
    expect(result.rejected.every((r) => r.reasons[0].startsWith('more than 3'))).toBe(true);
  });
});

describe('guardrail for restoring', () => {
  const afterShed = FLAGS.map((f) => (f.name === 'pdf_export' ? { ...f, enabled: false } : f));

  it('only restores flags this incident turned off and that are still off', () => {
    const result = checkRestoreFlags(['pdf_export', 'basic_csv'], ['pdf_export'], afterShed);
    expect(result.allowed).toEqual(['pdf_export']);
    expect(describeRejections(result.rejected)).toEqual(['basic_csv: this incident did not turn it off, flag is already on']);
  });
});
