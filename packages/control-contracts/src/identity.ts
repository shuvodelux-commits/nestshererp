import { z } from 'zod';

import { healthStateSchema, licenceStateSchema } from './states';

/**
 * How an installation becomes somebody the control plane will listen to (§3).
 *
 * **The private key is generated where it lives and never travels.** The
 * dashboard mints a single-use enrolment token; the agent makes its own Ed25519
 * pair on the shop's machine, sends the *public* half with the token, and the
 * control plane binds that key to that installation and burns the token. There
 * is no moment at which the vendor holds the customer's private key, which
 * means there is no backup, no log and no laptop from which every installation
 * in the fleet could be impersonated.
 *
 * The token is single-use and short-lived for the obvious reason and one less
 * obvious one: it is the only part of enrolment a human copies by hand, so it
 * is the only part that ends up in a chat message.
 */
export const enrolmentRequestSchema = z
  .object({
    /** The one-time token, exactly as the dashboard printed it. */
    token: z.string().min(16).max(128),
    /** SPKI DER, base64 — the half the control plane keeps. */
    public_key: z.string().min(1).max(512),
    /**
     * The ERP's own tenant id, read from the installed database.
     *
     * §2: identity is never inferred from a domain name, which a customer can
     * change on a whim and an attacker can claim. This is the stable identifier
     * the shop's own rows are keyed by, and binding to it is what makes
     * "installation X belongs to tenant Y" a checkable statement.
     */
    erp_tenant_id: z.string().min(1).max(64),
    /** What the shop calls itself, for the console. Metadata, never identity. */
    business_name: z.string().max(200).default(''),
    agent_version: z.string().min(1).max(64),
    app_version: z.string().min(1).max(64),
    schema_version: z.string().max(64).default(''),
    /** Where the ERP answers on the shop's own network. Never used for auth. */
    local_url: z.string().max(300).default(''),
  })
  .strict();
export type EnrolmentRequest = z.infer<typeof enrolmentRequestSchema>;

/**
 * What the agent is told once it is trusted.
 *
 * It receives the control plane's **public** command-signing key and pins it.
 * From then on the agent verifies every command against a key it already holds,
 * so a control plane that has been replaced — a hijacked DNS record, a proxy in
 * the middle — cannot issue commands to this shop, only fail to be believed.
 */
export const enrolmentResponseSchema = z
  .object({
    tenant_id: z.string().min(1).max(64),
    installation_id: z.string().min(1).max(64),
    /** SPKI DER base64 of the key that signs commands, pinned by the agent. */
    command_public_key: z.string().min(1).max(512),
    command_signing_key_id: z.string().min(1).max(64),
    /** Seconds between check-ins the control plane would like. */
    checkin_interval_seconds: z.number().int().positive(),
  })
  .strict();
export type EnrolmentResponse = z.infer<typeof enrolmentResponseSchema>;

/**
 * The heartbeat (§6).
 *
 * **Operational metadata only.** Every field here answers a fleet question —
 * is it up, what is it running, is its licence about to lapse, did its backup
 * work, is its queue draining. None of it answers a business question, and
 * nothing in it names a customer, a product, a price or an amount. §22 draws
 * that line and this schema is where it is enforced: a field that would carry
 * business data has nowhere to go.
 *
 * `error_counters` is counts keyed by error code — `{"PURCHASE_POST_FAILED": 3}`
 * — never messages. See `diagnostics.ts` for why that is structural rather than
 * a redaction pass.
 */
export const checkInRequestSchema = z
  .object({
    tenant_id: z.string().min(1).max(64),
    installation_id: z.string().min(1).max(64),
    agent_version: z.string().min(1).max(64),
    app_version: z.string().min(1).max(64),
    release_id: z.string().max(64).default(''),
    schema_version: z.string().max(64).default(''),
    /**
     * A hash of the installed licence, not the licence.
     *
     * Enough to tell whether the machine has the licence the vendor last
     * issued, without the control plane needing to hold a copy of what it
     * signed to compare against.
     */
    licence_fingerprint: z.string().max(128).default(''),
    licence_state: licenceStateSchema.default('UNKNOWN'),
    licence_valid_until: z.string().max(40).default(''),
    /** e.g. "linux 6.1 / node 20.19.9". Coarse on purpose. */
    runtime: z.string().max(200).default(''),
    uptime_seconds: z.number().int().nonnegative().default(0),
    last_backup_at: z.string().max(40).default(''),
    last_backup_ok: z.boolean().default(false),
    /** Percentage points, 0–100. A shop with a full disk cannot trade. */
    disk_used_percent: z.number().int().min(0).max(100).default(0),
    /** How many operations the offline queue is still holding (Phase 12). */
    sync_pending: z.number().int().nonnegative().default(0),
    sync_conflicts_open: z.number().int().nonnegative().default(0),
    migration_state: z.string().max(64).default(''),
    /** Error code → count since the last check-in. Codes only. */
    error_counters: z.record(z.number().int().nonnegative()).default({}),
    health: healthStateSchema.default('UNKNOWN'),
    sent_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

/**
 * The reply: the work waiting for this machine.
 *
 * Commands ride back on the response to the agent's own outbound request, which
 * is the whole reason this design needs no inbound port, no port forwarding and
 * no public URL for the shop (§1, §16). The control plane never dials a
 * customer; the customer asks, and is answered.
 */
export const checkInResponseSchema = z
  .object({
    /** Signed commands, oldest first. May be empty, and usually is. */
    commands: z.array(z.unknown()),
    /** Seconds until the next check-in — the control plane may slow a fleet down. */
    next_checkin_seconds: z.number().int().positive(),
    /** Set when the vendor has revoked this installation. The agent stops. */
    revoked: z.boolean().default(false),
  })
  .strict();
export type CheckInResponse = z.infer<typeof checkInResponseSchema>;

/**
 * The headers that authenticate one agent request (§3).
 *
 * The signature covers a canonical document rather than the raw body, so a
 * proxy that re-serialises JSON does not break it, and covers a body **hash**
 * so the body cannot be swapped. `nonce` plus a bounded `issued_at` window is
 * what stops a captured request being replayed: the control plane remembers
 * recent nonces for longer than the window it accepts.
 */
export const agentAuthDocumentSchema = z
  .object({
    installation_id: z.string().min(1).max(64),
    method: z.string().min(1).max(16),
    path: z.string().min(1).max(300),
    /** SHA-256 of the raw request body, hex. Empty string for no body. */
    body_sha256: z.string().max(64),
    issued_at: z.string().datetime({ offset: true }),
    nonce: z.string().min(8).max(64),
  })
  .strict();
export type AgentAuthDocument = z.infer<typeof agentAuthDocumentSchema>;

/** Header names the agent sets and the control plane reads. */
export const AGENT_HEADER_INSTALLATION = 'x-sher-installation';
export const AGENT_HEADER_ISSUED_AT = 'x-sher-issued-at';
export const AGENT_HEADER_NONCE = 'x-sher-nonce';
export const AGENT_HEADER_SIGNATURE = 'x-sher-signature';

/** How far apart the two clocks may be before a request is refused, in seconds. */
export const AGENT_CLOCK_SKEW_SECONDS = 300;
