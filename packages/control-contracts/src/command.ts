import { z } from 'zod';

/**
 * The only things the vendor may ask a customer installation to do (§17).
 *
 * **This list is the security boundary.** There is no "run this" command and
 * there will not be one: the agent switches on this enum and a type it does not
 * recognise is refused, so the set of things a stolen signing key could cause is
 * exactly what is written here. That is the difference between a management
 * channel and a backdoor, and it is enforced by there being no general case.
 *
 * Notice what is absent — no SQL, no shell, no file read, no "fetch me this
 * table". §13 and §27 forbid them, and the way to keep a forbidden capability
 * out of a system is to never give it a name.
 */
export const commandTypeSchema = z.enum([
  /** Take the signed licence in the payload and install it through the ERP. */
  'LICENCE_REFRESH',
  /** Send back the sanitized diagnostics already collected. */
  'COLLECT_DIAGNOSTICS',
  /** Report which release this machine is on and whether a newer one applies. */
  'CHECK_FOR_UPDATE',
  /** Download, verify and apply the named release. */
  'INSTALL_RELEASE',
  /** Run pending migrations for the release already installed. */
  'RUN_MIGRATION',
  /** Take a backup now, through the ERP's own backup service. */
  'CREATE_BACKUP',
  /** Run the health probes and report. */
  'HEALTH_CHECK',
  /** Open the reverse tunnel and accept the enclosed support grant. */
  'START_SUPPORT_SESSION',
  /** Close a support session and drop the tunnel, now. */
  'TERMINATE_SUPPORT_SESSION',
  /** Replace the cached feature-flag set. */
  'SET_FEATURE_FLAGS',
  /** Rotate this installation's own signing keypair. */
  'ROTATE_CREDENTIAL',
]);
export type CommandType = z.infer<typeof commandTypeSchema>;

/**
 * The envelope, signed by the control plane and verified by the agent (§3, §18).
 *
 * Every field below exists to make one specific attack fail:
 *
 * - `tenant_id` + `installation_id` — a command captured from shop A is refused
 *   by shop B, because the identifiers it names are not theirs. §3 asks for
 *   exactly this, and it is the reason the agent checks its own identity
 *   against the envelope rather than trusting that the message arrived on its
 *   own connection.
 * - `expires_at` — a command is a thing to do now, not a bearer token. An
 *   envelope recovered from a disk image months later is already dead.
 * - `idempotency_key` — a reply that is retried after a lost response must not
 *   deploy twice or take two backups. §18: replay of a completed command is a
 *   no-op that returns the original result.
 * - `issued_at` — orders a stream of commands and bounds clock skew.
 */
export const commandEnvelopeSchema = z
  .object({
    command_id: z.string().min(1).max(64),
    tenant_id: z.string().min(1).max(64),
    installation_id: z.string().min(1).max(64),
    type: commandTypeSchema,
    /** Command-specific, validated again by the handler that runs it. */
    payload: z.record(z.unknown()),
    issued_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    idempotency_key: z.string().min(1).max(128),
    /** Which control-plane key signed it, so the vendor can rotate. */
    signing_key_id: z.string().min(1).max(64),
  })
  .strict();
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** An envelope with its detached signature, as it travels. */
export const signedCommandSchema = z
  .object({
    envelope: commandEnvelopeSchema,
    /** Ed25519 over `SHERCMD1.` + canonical envelope, base64url. */
    signature: z.string().min(1).max(256),
  })
  .strict();
export type SignedCommand = z.infer<typeof signedCommandSchema>;

/**
 * Why the agent refused a command (§18).
 *
 * Reported back rather than swallowed: a rejected command is a fact the vendor
 * needs — `TENANT_MISMATCH` on a live fleet means something is badly wrong,
 * and silence would hide it.
 */
export const commandRejectionSchema = z.enum([
  'TENANT_MISMATCH',
  'INSTALLATION_MISMATCH',
  'SIGNATURE_INVALID',
  'UNTRUSTED_KEY',
  'EXPIRED',
  'UNKNOWN_TYPE',
  'INSTALLATION_REVOKED',
  'PAYLOAD_INVALID',
  'PRECONDITION_FAILED',
]);
export type CommandRejection = z.infer<typeof commandRejectionSchema>;

/** How a command ended, as the agent reports it and the console shows it. */
export const commandStatusSchema = z.enum([
  'PENDING',
  'DISPATCHED',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'EXPIRED',
]);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

/**
 * What the agent sends back when a command finishes.
 *
 * `result` is structured and small by design — it is fleet metadata, not a log
 * dump (§6, §22). A handler that wants to say more says it with more fields,
 * not with a paragraph of free text that might carry a customer's name.
 */
export const commandResultSchema = z
  .object({
    command_id: z.string().min(1).max(64),
    status: commandStatusSchema,
    /** Present only when the command was refused outright. */
    rejection: commandRejectionSchema.optional(),
    /** Structured, sanitized, no free-form log text. */
    result: z.record(z.unknown()).default({}),
    /** A stable code, never an exception message. */
    failure_code: z.string().max(64).optional(),
    completed_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CommandResult = z.infer<typeof commandResultSchema>;
