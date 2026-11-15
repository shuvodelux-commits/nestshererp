import { z } from 'zod';

import {
  partyRoleSchema,
  partyStatusSchema,
  savePartyRequestSchema,
} from './parties';

/**
 * MOD-004 SEC-N02A (#306): contract-only foundation for a future selected-role
 * V2 Party directory creator. No route or service is registered by this module.
 *
 * An opening balance is a separate, source-linked noncash journal document,
 * not an ordinary directory field. It is deliberately NOT accepted here.
 */
export const partyV2CreateRequestSchema = savePartyRequestSchema
  .omit({ opening: true })
  .extend({ selectedRole: partyRoleSchema })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.roles.includes(input.selectedRole)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedRole'],
        message: 'The selected relationship must be included in the requested roles',
      });
    }
    if (new Set(input.roles).size !== input.roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'Duplicate Party relationships are not permitted',
      });
    }
  });

export type PartyV2CreateRequest = z.infer<typeof partyV2CreateRequestSchema>;

/**
 * Option B for a write-only caller: a deterministic, minimal acknowledgment.
 * CREATE or EDIT never implies permission to VIEW a Party's other roles,
 * balance, private profile or party-global journal history.
 *
 * The future HTTP handler must enforce same-UoW permissions and persist a
 * similarly scoped idempotency replay response. This schema alone does not.
 */
export const partyV2MutationReceiptSchema = z
  .object({
    id: z.string().length(26),
    version: z.number().int().positive(),
    selectedRole: partyRoleSchema,
    status: partyStatusSchema,
  })
  .strict();

export type PartyV2MutationReceipt = z.infer<typeof partyV2MutationReceiptSchema>;

export const partyV2MutationReceiptEnvelopeSchema = z
  .object({ data: partyV2MutationReceiptSchema })
  .strict();

export type PartyV2MutationReceiptEnvelope =
  z.infer<typeof partyV2MutationReceiptEnvelopeSchema>;
