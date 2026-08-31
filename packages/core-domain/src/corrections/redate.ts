/**
 * Moving a posted money document to the day it really happened (Phase 11.2,
 * D-43, owner decisions 2026-08-31).
 *
 * **Every refusal in one pure function**, so the dialog and the server reach
 * the same verdict from the same rule: the screen greys out a day it knows will
 * be refused, and the server refuses it again anyway, and neither owns a copy
 * of the rule the other could drift from.
 *
 * `correctionWindow` next door answers a different question. A *correction*
 * asks "the figures changed — where does the fix post?", and its answer for a
 * closed month is *today, as a prior-period adjustment*. A *date change* asks
 * "which day does this belong to?", and today is precisely the wrong answer:
 * the whole act is choosing a day. So a closed month is not routed around here
 * — it is refused, and an Owner may deliberately step through it (§5.3).
 */

/** What is refused, and the sentence the person reads. */
export interface RedateRefusal {
  readonly reason:
    | 'SAME_DATE'
    | 'FUTURE_DATE'
    | 'BEFORE_ALLOCATION'
    | 'COUNTED_DRAWER'
    | 'PERIOD_LOCKED';
  readonly message: string;
}

export interface RedatePlan {
  readonly businessDate: string;
  readonly originalBusinessDate: string;
  /**
   * `CORRECTED` always: a document that has been moved is a corrected one,
   * whichever direction it went. `BACKDATED` describes *when it was typed*
   * against *the day it claims*, which is `created_at`'s business and is not
   * touched by a move.
   */
  readonly entryMode: 'CORRECTED';
  /**
   * True when either month is closed. The Owner must confirm the warning and
   * re-enter their password before this posts (§5.3); everybody else has
   * already been refused above.
   */
  readonly closedPeriodOverride: boolean;
}

export interface RedateInput {
  /** The day the document sits on now. */
  readonly currentDate: string;
  readonly newDate: string;
  /** Today in the shop's timezone. */
  readonly today: string;
  readonly currentPeriodOpen: boolean;
  readonly newPeriodOpen: boolean;
  /**
   * Whether this person may reach into a closed month at all. False for
   * everyone but the Owner unless the shop granted the code deliberately.
   */
  readonly mayEnterClosedPeriod: boolean;
  /**
   * The invoices or bills this money settles, if any. A payment may not be
   * dated before the debt it clears.
   */
  readonly allocations: readonly { readonly number: string; readonly businessDate: string }[];
  /**
   * The business date of the cash session still open, when this document's
   * money went through a counted drawer. Null when it did not — a bank or
   * bKash account has nothing to count, so its date moves freely.
   */
  readonly drawerSessionDate: string | null;
}

export function planRedate(input: RedateInput): RedatePlan | RedateRefusal {
  if (input.newDate === input.currentDate) {
    return { reason: 'SAME_DATE', message: 'That is the day it is already on' };
  }

  if (input.newDate > input.today) {
    return { reason: 'FUTURE_DATE', message: 'A transaction cannot be dated in the future' };
  }

  /*
   * Money cannot pay a bill that does not exist yet (owner decision
   * 2026-08-31). Allowing it leaves the party ledger in an advance-then-invoice
   * shape that ageing reads as a customer in credit, and the statement shows a
   * payment sitting above the debt it clears. The earliest offender is named,
   * because "some invoice" is not something a shopkeeper can act on.
   */
  const tooEarly = [...input.allocations]
    .filter((allocation) => input.newDate < allocation.businessDate)
    .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))[0];
  if (tooEarly !== undefined) {
    return {
      reason: 'BEFORE_ALLOCATION',
      message:
        `This settles ${tooEarly.number} dated ${tooEarly.businessDate}` +
        ` — it cannot be dated ${input.newDate}`,
    };
  }

  /*
   * A drawer is counted once and its expected closing is immutable afterwards
   * (§5.16.8, UI-71). Moving cash into or out of a day somebody has already
   * counted would make that day's difference evidence of nothing, so a voucher
   * that touched the drawer may only move inside the session still open.
   */
  if (input.drawerSessionDate !== null && input.newDate !== input.drawerSessionDate) {
    return {
      reason: 'COUNTED_DRAWER',
      message:
        'This money went through the cash drawer, and that day has already been counted' +
        ` — it can only move to ${input.drawerSessionDate}`,
    };
  }

  const closedPeriodOverride = !input.currentPeriodOpen || !input.newPeriodOpen;
  if (closedPeriodOverride && !input.mayEnterClosedPeriod) {
    return {
      reason: 'PERIOD_LOCKED',
      message: !input.currentPeriodOpen
        ? 'That month is closed — ask the owner to move this'
        : 'The month you are moving it to is closed — ask the owner',
    };
  }

  return {
    businessDate: input.newDate,
    originalBusinessDate: input.currentDate,
    entryMode: 'CORRECTED',
    closedPeriodOverride,
  };
}

export function isRedateRefusal(result: RedatePlan | RedateRefusal): result is RedateRefusal {
  return 'reason' in result;
}
