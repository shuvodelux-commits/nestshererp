import { z } from 'zod';

import { balanceSchema } from './parties';

/**
 * A party's ledger over the wire (§2.4, INV-06, INV-10).
 *
 * The statement a shopkeeper opens when the balance on the list is not enough
 * and they need to know *why* it is that number. Every row is one journal line
 * with the document that produced it, so any figure on this screen can be
 * traced back to a thing that happened rather than to a stored total.
 *
 * Money is integer minor units with a `Minor` suffix (§5.26).
 */
const ULID = z.string().length(26);

/**
 * One statement row.
 *
 * `debitMinor` and `creditMinor` are the unsigned display halves of the single
 * signed line, split server-side by `buildPartyLedger` so the ledger screen,
 * the printed statement and any later report split it identically.
 */
export const partyLedgerRowSchema = z
  .object({
    journalEntryId: ULID,
    journalLineId: ULID,
    businessDate: z.string().date(),
    /** `OPENING_BALANCE`, `SALE`, `PAYMENT`, … — what produced this line. */
    sourceDocumentType: z.string(),
    sourceDocumentId: ULID,
    /** The human-facing document number, which is what a customer quotes back. */
    sourceNumber: z.string(),
    account: z.string(),
    /** Signed, exactly as stored. Positive is a debit. */
    amountMinor: z.number().int(),
    debitMinor: z.number().int().min(0),
    creditMinor: z.number().int().min(0),
    /** The party's net balance after this row. */
    runningBalanceMinor: z.number().int(),
  })
  .strict();

export type PartyLedgerRow = z.infer<typeof partyLedgerRowSchema>;

export const partyLedgerResponseSchema = z
  .object({
    partyId: ULID,
    partyName: z.string(),
    /**
     * The net of everything before the first row shown — a date filter or a
     * second page both leave earlier lines out, and a running balance that
     * restarted from zero would be wrong in a way that looks plausible.
     */
    openingBalance: balanceSchema,
    rows: z.array(partyLedgerRowSchema),
    /** The same figure the parties list shows for this party. */
    closingBalance: balanceSchema,
    totalDebitMinor: z.number().int().min(0),
    totalCreditMinor: z.number().int().min(0),
    page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }).strict(),
  })
  .strict();

export type PartyLedgerResponse = z.infer<typeof partyLedgerResponseSchema>;

/**
 * Ledger filters.
 *
 * Dates are inclusive on both ends, which is what someone asking for "January"
 * means. They narrow the rows shown but never the opening balance — that is
 * always the true sum of everything earlier, or the statement would not add up.
 */
export const partyLedgerQuerySchema = z
  .object({
    fromDate: z.string().date().optional(),
    toDate: z.string().date().optional(),
    /** Keyset cursor: the journal line id of the last row of the previous page. */
    cursor: ULID.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type PartyLedgerQuery = z.infer<typeof partyLedgerQuerySchema>;
