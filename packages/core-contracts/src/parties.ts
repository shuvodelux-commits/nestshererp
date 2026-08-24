import { z } from 'zod';

import { partySortSchema, sortDirectionSchema } from './sorting';

/**
 * Parties (Phase 2, path 2.3, §5.6, D-02, D-04).
 *
 * One identity with roles. A response says which roles a party holds rather than
 * which table it came from, because there is one table — selling to a supplier
 * has to be possible without inventing a second record for the same person.
 *
 * Money crosses the wire as **integer minor units** with a `Minor` suffix
 * (§5.26). `creditLimitMinor` is poisha; `null` means no limit, which is not the
 * same as a limit of zero.
 */
const ULID = z.string().length(26);

export const partyRoleSchema = z.union([
  z.literal('CUSTOMER'),
  z.literal('SUPPLIER'),
  z.literal('VENDOR'),
]);
export type PartyRoleValue = z.infer<typeof partyRoleSchema>;

export const partyStatusSchema = z.union([z.literal('ACTIVE'), z.literal('INACTIVE')]);
export type PartyStatusValue = z.infer<typeof partyStatusSchema>;

export const openingDirectionSchema = z.union([
  z.literal('RECEIVABLE'),
  z.literal('PAYABLE'),
]);
export type OpeningDirectionValue = z.infer<typeof openingDirectionSchema>;

/**
 * The opening balance a migrating shop enters with a party (§5.0, §5.6).
 *
 * `amountMinor` is always positive and `direction` carries the sign, so a
 * typo cannot silently flip a receivable into a payable — the two are separate
 * inputs on the form, and the server checks the pair against the party's role.
 *
 * `role` is required rather than inferred, because D-04 lets one party be both
 * a customer and a supplier, and "opening balance 5,000" against such a party
 * is ambiguous until someone says which side of the relationship it belongs to.
 */
export const openingBalanceRequestSchema = z
  .object({
    role: partyRoleSchema,
    direction: openingDirectionSchema,
    amountMinor: z.number().int().positive(),
    /** ISO date. The shop's go-live date, not necessarily today. */
    businessDate: z.string().date(),
  })
  .strict();

export type OpeningBalanceRequest = z.infer<typeof openingBalanceRequestSchema>;

/**
 * Correcting an opening already posted (§2.5).
 *
 * The same fields, plus D-32's optimistic lock. A correction never edits the
 * journal — the posted lines stay exactly where they are and a second entry
 * reverses them and posts the new figure, so the statement shows what the
 * opening was, that it was corrected, and what it became. `version` is the
 * document's, so two people correcting the same opening at once means the
 * second is told rather than silently winning.
 */
export const correctOpeningBalanceRequestSchema = openingBalanceRequestSchema
  .extend({ version: z.number().int().positive() })
  .strict();

export type CorrectOpeningBalanceRequest = z.infer<typeof correctOpeningBalanceRequestSchema>;

/**
 * An opening balance as the hub reads it back, so the correction dialog opens
 * on the figure that is actually posted rather than an empty form.
 *
 * `null` from the endpoint means this party has no opening for that role —
 * which is the common onboarding miss, and the reason the hub offers to set
 * one at all.
 */
export const partyOpeningResponseSchema = z
  .object({
    id: ULID,
    number: z.string(),
    role: partyRoleSchema,
    direction: openingDirectionSchema,
    amountMinor: z.number().int().positive(),
    businessDate: z.string().date(),
    version: z.number().int(),
  })
  .strict();

export type PartyOpeningResponse = z.infer<typeof partyOpeningResponseSchema>;

export const balanceDirectionSchema = z.union([
  z.literal('RECEIVABLE'),
  z.literal('PAYABLE'),
  z.literal('SETTLED'),
]);
export type BalanceDirectionValue = z.infer<typeof balanceDirectionSchema>;

/**
 * A party balance as the wire carries it (INV-06, §5.26).
 *
 * All three figures ship together even though `netMinor` determines the other
 * two, because the split is a domain decision (`partyBalanceOf`) and a client
 * re-deriving it is a client that can get the sign backwards — which on this
 * particular screen means telling a shopkeeper to collect money from someone
 * who is owed it.
 */
export const balanceSchema = z
  .object({
    /** Positive: the party owes the shop. Negative: the shop owes the party. */
    netMinor: z.number().int(),
    direction: balanceDirectionSchema,
    /** পাবো — unsigned. Zero unless `direction` is RECEIVABLE. */
    outstandingMinor: z.number().int().min(0),
    /** দিব — unsigned. Zero unless `direction` is PAYABLE. */
    advanceMinor: z.number().int().min(0),
  })
  .strict();

export type BalanceResponse = z.infer<typeof balanceSchema>;

export const partyResponseSchema = z
  .object({
    id: ULID,
    name: z.string(),
    /** D-04's role flags. At least one, and the order is fixed for the screen. */
    roles: z.array(partyRoleSchema),
    phone: z.string().nullable(),
    address: z.string().nullable(),
    guardianName: z.string().nullable(),
    nid: z.string().nullable(),
    email: z.string().nullable(),
    notes: z.string().nullable(),
    customerGroupId: ULID.nullable(),
    customerGroupName: z.string().nullable(),
    creditLimitMinor: z.number().int().nullable(),
    status: partyStatusSchema,
    /**
     * D-02's walk-in party. The screen shows it as what it is and offers no
     * edit, deactivate or delete — the server refuses all three regardless.
     */
    isSystemReserved: z.boolean(),
    /** Optimistic lock (D-32). Sent back on edit; a stale one is a 409. */
    version: z.number().int(),
    /**
     * The party's balance, on the row (§5.0's "a list shows what you came to
     * see"). Nobody should have to open a ledger to find out whether a customer
     * owes money — that is the one fact a counter actually needs from a list.
     *
     * Not a stored column: this is the INV-06 rollup of their journal lines,
     * computed in the same query as the row, so the list and the ledger cannot
     * disagree. See `balanceSchema` for what the three figures mean.
     */
    balance: balanceSchema,
    /**
     * Whether anything has ever posted against this party (§3.6).
     *
     * The row carries it because the `⋯` menu has to decide between `Delete`
     * and `Deactivate` before the shopkeeper opens anything, and a settled
     * balance is not the same question: a customer who owed 500 and paid it
     * nets to zero but has a statement, and hard-deleting them would orphan
     * the journal lines that statement is made of. Computed in the same query
     * as the row, so the menu and the server agree about the same party.
     */
    hasLedgerEntries: z.boolean(),
  })
  .strict();

export type PartyResponse = z.infer<typeof partyResponseSchema>;

/**
 * Counts for the summary tiles, from the same query as the rows, so a tile can
 * never disagree with the table under it (§2.7.I).
 */
export const partySummarySchema = z
  .object({
    total: z.number().int(),
    active: z.number().int(),
    inactive: z.number().int(),
    /** Customers with no group yet, while customer groups are switched on. */
    ungrouped: z.number().int(),
    /**
     * What the whole filtered set is worth, so the tiles answer "how much is
     * out there?" without anyone exporting the list and summing a column.
     *
     * Both are unsigned and both can be non-zero at once: across a set of
     * parties some owe and some are owed, and netting them into one figure
     * would hide a shop that is carrying 200,000 of receivables *and* 180,000
     * of advances behind a comfortable-looking 20,000.
     */
    totalOutstandingMinor: z.number().int().min(0),
    totalAdvanceMinor: z.number().int().min(0),
    /** Customers over their §5.6 credit limit. Zero when none has a limit set. */
    overCreditLimit: z.number().int(),
  })
  .strict();

export type PartySummary = z.infer<typeof partySummarySchema>;

export const partyListResponseSchema = z
  .object({
    data: z.array(partyResponseSchema),
    page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }).strict(),
    summary: partySummarySchema,
  })
  .strict();

/**
 * List filters (§5.6, §5.0's "search · filter · sort").
 *
 * `role` is the tab the shopkeeper is on — Customers, Suppliers or Vendors —
 * and it is **required**, because §5.6 is explicit that party selection never
 * shows every party type by default. `search` covers name and phone, which is
 * what someone types at a counter.
 */
export const partyQuerySchema = z
  .object({
    role: partyRoleSchema,
    search: z.string().trim().max(120).optional(),
    groupId: ULID.optional(),
    status: partyStatusSchema.optional(),
    /** Keyset cursor: the id of the last row of the previous page (§3.9). */
    cursor: ULID.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /** Which header was tapped, from the closed allow-list (UI-46). */
    sort: partySortSchema.optional(),
    direction: sortDirectionSchema.optional(),
  })
  .strict();

export type PartyQuery = z.infer<typeof partyQuerySchema>;

/**
 * §5.6's field set. Name and at least one role are always required; a phone is
 * required only when CUSTOMER is among the roles (D-02). Everything else is
 * optional, and G2.2 forbids making an optional field mandatory because a column
 * exists.
 *
 * Opening receivable/payable is accepted here as `opening`, but it is **not** a
 * field on the party — it is a document. The service posts it through
 * `openingBalancePosting` against `OPENING_EQUITY`, exactly as opening stock
 * goes through Phase 3's, so INV-06 stays true: the balance the list shows is
 * still the sum of journal lines, and this is simply how the first of those
 * lines gets written. A plain `openingBalanceMinor` column would be a balance
 * with no journal behind it, which is what §5.6 forbids.
 *
 * Create-only. On an edit `opening` must be absent: changing a posted opening
 * is a correction, and §2.5 says a correction reverses and reposts rather than
 * rewriting history in place.
 */
export const savePartyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    roles: z.array(partyRoleSchema).min(1).max(3),
    phone: z.string().trim().max(30).nullable(),
    address: z.string().trim().max(500).nullable(),
    guardianName: z.string().trim().max(200).nullable(),
    nid: z.string().trim().max(60).nullable(),
    email: z.string().trim().max(200).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    customerGroupId: ULID.nullable(),
    creditLimitMinor: z.number().int().min(0).nullable(),
    opening: openingBalanceRequestSchema.nullable().optional(),
  })
  .strict();

export type SavePartyRequest = z.infer<typeof savePartyRequestSchema>;

/**
 * An edit. `opening` is dropped rather than made optional: §2.5 corrects a
 * posted document by reversing and reposting it, never by rewriting it, so a
 * PATCH carrying an opening balance is a request the server has no honest way
 * to satisfy. `.strict()` then makes sending one a 400 rather than a silent
 * no-op — a shopkeeper who retypes an opening on the edit form must be told it
 * did not take, not left believing it did.
 */
export const updatePartyRequestSchema = savePartyRequestSchema
  .omit({ opening: true })
  .extend({ version: z.number().int().positive() })
  .strict();

export type UpdatePartyRequest = z.infer<typeof updatePartyRequestSchema>;

/**
 * Activate/deactivate is its own action endpoint (§5.26), not a PATCH on a
 * status field: it decides whether the party appears in every new sale or
 * purchase from that moment.
 */
export const setPartyStatusRequestSchema = z.object({ status: partyStatusSchema }).strict();
export type SetPartyStatusRequest = z.infer<typeof setPartyStatusRequestSchema>;

/** One customer group (§5.6). */
export const customerGroupResponseSchema = z.object({ id: ULID, name: z.string() }).strict();
export type CustomerGroupResponse = z.infer<typeof customerGroupResponseSchema>;

export const saveCustomerGroupRequestSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();

export type SaveCustomerGroupRequest = z.infer<typeof saveCustomerGroupRequestSchema>;

/**
 * Which of §5.21's optional customer fields the shop asks for.
 *
 * §5.6: "Settings may hide/disable optional fields such as NID and
 * Father/Guardian Name from normal forms while preserving stored historical
 * data." The form reads this instead of `/settings`, because a cashier who may
 * add a customer has no business holding `settings.setting.view` — and a form
 * that 403s while loading is not a form (UI-09).
 */
export const partyFieldVisibilitySchema = z
  .object({
    address: z.boolean(),
    guardianName: z.boolean(),
    nid: z.boolean(),
    email: z.boolean(),
    notes: z.boolean(),
  })
  .strict();

export type PartyFieldVisibility = z.infer<typeof partyFieldVisibilitySchema>;

/**
 * Everything the parties screens need before they can draw: the groups, whether
 * groups and vendors exist at all for this shop, and which optional fields to
 * ask for. One call, because a half-loaded form is three chances to get it wrong.
 */
export const partySetupResponseSchema = z
  .object({
    groups: z.array(customerGroupResponseSchema),
    features: z
      .object({ customerGroups: z.boolean(), vendors: z.boolean() })
      .strict(),
    fields: partyFieldVisibilitySchema,
  })
  .strict();

export type PartySetupResponse = z.infer<typeof partySetupResponseSchema>;

export type PartyListResponse = z.infer<typeof partyListResponseSchema>;

/**
 * D-02's walk-in customer, seeded with every business.
 *
 * "The walk-in customer is one real, `system_reserved` party exempt from the
 * constraint." One row, created with the tenant, because a fully paid guest sale
 * in Phase 6 has to point at a real party — and a shop whose first sale creates
 * it on the fly would have every sale racing to create it.
 */
export const WALK_IN_PARTY_NAME = 'Walk-in Customer';
