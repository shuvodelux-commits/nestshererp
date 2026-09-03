import { z } from 'zod';

/**
 * The local management agent's requests (Phase 17, §6, §17, §19).
 *
 * Here rather than in the controller because every other request shape in this
 * API is here, and because these three are part of the contract between two
 * separately-built processes — the ERP and its sidecar — which is exactly the
 * kind of agreement that drifts when each side keeps its own copy.
 *
 * They are deliberately tiny. A licence key, a flag list, a session marker:
 * nothing a client can post through these routes changes what the shop is
 * entitled to, what a posting means, or what any user may do.
 */

export const managementLicenceRequestSchema = z
  .object({
    /** The signed `SHERLIC1` string, exactly as the vendor issued it. */
    key: z.string().min(1).max(8192),
  })
  .strict();
export type ManagementLicenceRequest = z.infer<typeof managementLicenceRequestSchema>;

export const managementFlagsRequestSchema = z
  .object({
    flags: z.array(z.object({ key: z.string().max(64), enabled: z.boolean() })).max(200),
  })
  .strict();
export type ManagementFlagsRequest = z.infer<typeof managementFlagsRequestSchema>;

/**
 * The live support session, or `null` when one has ended.
 *
 * It drives the indicator a shop's own users see and **grants nothing**. The
 * authority on every support request is the signed grant checked per request;
 * a lie told through this route would show a banner without opening a door.
 */
export const managementSupportSessionRequestSchema = z
  .object({
    session: z
      .object({
        session_id: z.string().max(64),
        operator_name: z.string().max(120),
        reason: z.string().max(500),
        issued_at: z.string().max(40),
        expires_at: z.string().max(40),
      })
      .nullable(),
  })
  .strict();
export type ManagementSupportSessionRequest = z.infer<typeof managementSupportSessionRequestSchema>;
