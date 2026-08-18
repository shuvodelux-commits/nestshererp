import { z } from 'zod';

/**
 * The audit trail (slice 1.6, §5.22).
 *
 * Read-only over the wire. There is no create, edit or delete schema here and
 * there never will be: `audit_events` is append-only (R-C7), written inside the
 * transaction of the thing it describes, and "audit logging cannot be disabled
 * by configuration" (§5.26). An endpoint that could write one directly would be
 * a way to forge history.
 */
export const auditEventSchema = z
  .object({
    id: z.string().length(26),
    /** UTC, ISO-8601. Rendered in the tenant's timezone by the screen (§3.5). */
    occurredAt: z.string(),
    /** Who did it, resolved to a name the owner recognises — never a bare ULID. */
    actorName: z.string(),
    actorId: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    action: z.string(),
    /** null for a create. Values exactly as stored — an audit that rounds is not evidence. */
    before: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
    /** null for a delete. */
    after: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
    reason: z.string().nullable(),
    /** Where the mutation came from: API, DAYBOOK, SYNC, MCP (§5.22). */
    source: z.string(),
  })
  .strict();

export type AuditEventResponse = z.infer<typeof auditEventSchema>;

/**
 * Keyset pagination (§3.9 — `OFFSET` is banned). The cursor is the last id
 * seen; ids are ULIDs, so ordering by id descending is ordering by time
 * descending, and one column serves as both sort key and cursor.
 */
export const auditPageSchema = z
  .object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export const auditListResponseSchema = z
  .object({
    events: z.array(auditEventSchema),
    /**
     * The tenant's timezone, so the screen renders each instant on the day the
     * business considers it to have happened (§3.5). Sent rather than assumed:
     * the tenant can change it in Settings, and a screen holding its own copy
     * would keep showing the old one.
     */
    timezone: z.string(),
    page: auditPageSchema,
    /**
     * The distinct actions and entity types this tenant actually has, so the
     * filters offer real choices rather than a hard-coded list that drifts as
     * later modules add their own events.
     */
    actions: z.array(z.string()),
    entityTypes: z.array(z.string()),
    /** Everyone who has ever appeared as an actor, for the "who" filter. */
    actors: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  })
  .strict();

export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

/**
 * Filters (§5.0: search · filter · sort). Dates are tenant-local `YYYY-MM-DD`
 * and inclusive on both ends — "the 5th to the 7th" means three days, which is
 * what a shopkeeper means by it.
 */
export const auditQuerySchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    actorId: z.string().length(26).optional(),
    entityType: z.string().max(60).optional(),
    action: z.string().max(60).optional(),
    /** Matches an entity id exactly — the "what happened to this record" path. */
    entityId: z.string().max(60).optional(),
    cursor: z.string().length(26).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).optional(),
  })
  .strict();

export type AuditQuery = z.infer<typeof auditQuerySchema>;
