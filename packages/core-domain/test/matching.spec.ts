import { describe, expect, it } from 'vitest';

import { matchStatement } from '../src/reconciliation/matching';
import type { MatchableRow } from '../src/reconciliation/matching';

/**
 * The matching engine (§5.17, Phase 11).
 *
 * These are the rules the module's safety rests on. Everything else in
 * reconciliation is a link a person can undo in one tap; an automatic match is
 * the one thing the machine decides on its own, so what may and may not become
 * one is asserted here rather than trusted.
 */

function ours(over: Partial<MatchableRow> = {}): MatchableRow {
  return {
    id: 'L1',
    businessDate: '2026-08-05',
    amountMinor: 1_000_000,
    reference: 'RCPT-101',
    description: 'customer receipt RCPT-101',
    ...over,
  };
}

function theirs(over: Partial<MatchableRow> = {}): MatchableRow {
  return {
    id: 'S1',
    businessDate: '2026-08-05',
    amountMinor: 1_000_000,
    reference: 'RCPT-101',
    description: 'deposit RCPT-101',
    ...over,
  };
}

describe('automatic matching', () => {
  it('matches the same amount, direction, date and reference without asking', () => {
    const outcome = matchStatement([ours()], [theirs()]);

    expect(outcome.auto).toHaveLength(1);
    expect(outcome.auto[0]).toMatchObject({ ledgerId: 'L1', statementLineId: 'S1' });
    expect(outcome.suggested).toEqual([]);
  });

  it('still matches automatically on the same date when neither side has a reference', () => {
    const outcome = matchStatement(
      [ours({ reference: null })],
      [theirs({ reference: null, description: 'cash deposit' })],
    );

    expect(outcome.auto).toHaveLength(1);
  });

  it('links each row once — one of ours is one of theirs, never two', () => {
    const outcome = matchStatement(
      [ours({ id: 'L1' })],
      [theirs({ id: 'S1' }), theirs({ id: 'S2' })],
    );

    const used = [...outcome.auto, ...outcome.suggested];
    expect(used.filter((pair) => pair.ledgerId === 'L1')).toHaveLength(1);
  });
});

describe('suggestions, where the engine is not sure', () => {
  it('suggests rather than matches when the date differs by a day', () => {
    const outcome = matchStatement(
      [ours({ reference: null })],
      [theirs({ businessDate: '2026-08-06', reference: null, description: 'cash deposit' })],
    );

    expect(outcome.auto).toEqual([]);
    expect(outcome.suggested).toHaveLength(1);
    expect(outcome.suggested[0]?.reasons).toContainEqual({
      label: 'Date',
      detail: 'Differs by 1 day',
      ok: false,
    });
  });

  it('suggests rather than matches when two of ours could be the same payment', () => {
    // Two ৳2,500 payments on one day. Which is which is not the engine's to
    // decide, so both become suggestions and the owner picks.
    const outcome = matchStatement(
      [
        ours({ id: 'L1', amountMinor: -250_000, reference: null, description: 'supplier payment' }),
        ours({ id: 'L2', amountMinor: -250_000, reference: null, description: 'supplier payment' }),
      ],
      [theirs({ id: 'S1', amountMinor: -250_000, reference: null, description: 'transfer out' })],
    );

    expect(outcome.auto).toEqual([]);
    expect(outcome.suggested).toHaveLength(1);
  });

  it('never auto-matches on wording alone', () => {
    // Same words, same amount, but four days apart and no reference: outside
    // the tolerance entirely, so it is not even a suggestion.
    const outcome = matchStatement(
      [ours({ reference: null, description: 'deposit from karim' })],
      [theirs({ businessDate: '2026-08-11', reference: null, description: 'deposit from karim' })],
    );

    expect(outcome.auto).toEqual([]);
    expect(outcome.suggested).toEqual([]);
  });
});

describe('what is never a match', () => {
  it('refuses a one-poisha difference', () => {
    const outcome = matchStatement([ours({ amountMinor: 1_000_000 })], [theirs({ amountMinor: 1_000_001 })]);

    expect(outcome.auto).toEqual([]);
    expect(outcome.suggested).toEqual([]);
  });

  it('refuses money out against money in, however well everything else agrees', () => {
    const outcome = matchStatement([ours({ amountMinor: 1_000_000 })], [theirs({ amountMinor: -1_000_000 })]);

    expect(outcome.auto).toEqual([]);
    expect(outcome.suggested).toEqual([]);
  });

  it('reports a shared reference with a different amount as a conflict, not a match', () => {
    const outcome = matchStatement([ours()], [theirs({ amountMinor: 999_000 })]);

    expect(outcome.auto).toEqual([]);
    expect(outcome.suggested).toEqual([]);
    expect(outcome.conflicts).toEqual([
      {
        ledgerId: 'L1',
        statementLineId: 'S1',
        reference: 'RCPT101',
        ledgerAmountMinor: 1_000_000,
        statementAmountMinor: 999_000,
      },
    ]);
  });
});
