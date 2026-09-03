import { z } from 'zod';

/**
 * What a customer failure looks like by the time the vendor sees it (§7, §22).
 *
 * **Redaction here is structural, not a filter.** The tempting design is to
 * ship the error message and strip secrets out of it on the way; that design
 * fails the first time a message interpolates something nobody predicted — a
 * customer's name, a price, a token in a URL — and it fails silently, on the
 * vendor's server, permanently. So there is no message field. There is nowhere
 * for free text to go, which means no list of patterns to maintain and no way
 * to be one regex behind.
 *
 * What is left is what actually identifies a bug: a stable code, the module and
 * route it happened in, the versions it happened on, and a correlation id that
 * ties a customer's phone call to the exact failure. That is enough to answer
 * "which installations hit this" and "is this the bug I fixed on Tuesday",
 * which is what §8's affected-installation count is built from.
 */
export const diagnosticEventSchema = z
  .object({
    /** Stable code from the ERP's own ErrorCode enum. Never a message. */
    code: z.string().min(1).max(64),
    /** Which part of the ERP — 'purchasing', 'sales', 'sync'. */
    module: z.string().max(64).default(''),
    /**
     * The route pattern, never the resolved URL.
     *
     * `/api/v1/purchases/:id` and not `/api/v1/purchases/01J8Z...`: the pattern
     * says where the bug is, the resolved path names a document belonging to a
     * customer and says nothing extra about the bug.
     */
    route: z.string().max(200).default(''),
    http_status: z.number().int().min(0).max(599).default(0),
    /** Ties a customer's "it failed at 3pm" to one event. Opaque, not personal. */
    correlation_id: z.string().max(64).default(''),
    app_version: z.string().max(64).default(''),
    schema_version: z.string().max(64).default(''),
    occurred_at: z.string().datetime({ offset: true }),
    /** How many identical failures this row stands for. */
    count: z.number().int().positive().default(1),
  })
  .strict();
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

/** A batch, as the agent uploads it. */
export const diagnosticsUploadSchema = z
  .object({
    events: z.array(diagnosticEventSchema).max(500),
  })
  .strict();
export type DiagnosticsUpload = z.infer<typeof diagnosticsUploadSchema>;

/**
 * The field names that must never appear in a diagnostic payload.
 *
 * Belt and braces on top of the schema above: `.strict()` already refuses an
 * unknown key, and this list is asserted by the control plane before a row is
 * stored, so a future contributor who adds a field with one of these names
 * fails loudly at the boundary instead of quietly writing a secret to disk.
 */
export const FORBIDDEN_DIAGNOSTIC_FIELDS: readonly string[] = [
  'password',
  'pin',
  'token',
  'secret',
  'key',
  'authorization',
  'hash',
  'card',
  'account_number',
  'message',
  'stack',
  'body',
  'params',
  'query',
];
