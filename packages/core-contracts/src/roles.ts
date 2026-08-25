import { z } from 'zod';

/**
 * Roles and what they may do (slice 1.4, §5.26).
 *
 * `confirmPassword` is the caller's own, re-entered. Changing what a role may
 * do re-privileges everyone holding it in one move — a wider act than editing
 * one person — so §5.3's step-up rule applies at least as strongly here.
 */
/**
 * How much cash a role may hand back on a return (owner decision 2026-08-26).
 *
 * **A number on the role, not a permission.** The question a shop asks is "how
 * much can the boy at the counter give back", and the answer is an amount; a
 * permission per bracket would be a permission per shop. `null` is unlimited,
 * which is what Owner and Manager ship with. `0` is a role that may take
 * returns but never open the drawer for one — a real setting, not a mistake.
 *
 * Two caps, because they catch different things: one refund of ৳৫,০০০, and ten
 * of ৳৫০০ across the afternoon. Over either, the screen asks for a senior PIN.
 */
export const refundLimitsSchema = z
  .object({
    cashRefundPerReturnMinor: z.number().int().nonnegative().nullable(),
    cashRefundPerDayMinor: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type RefundLimits = z.infer<typeof refundLimitsSchema>;

export const createRoleRequestSchema = z
  .object({
    name: z.string().min(2).max(60),
    permissions: z.array(z.string().max(80)).max(200),
    cashRefundPerReturnMinor: z.number().int().nonnegative().nullable().default(null),
    cashRefundPerDayMinor: z.number().int().nonnegative().nullable().default(null),
    confirmPassword: z.string().min(1).max(200),
  })
  .strict();

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({
    name: z.string().min(2).max(60),
    permissions: z.array(z.string().max(80)).max(200),
    cashRefundPerReturnMinor: z.number().int().nonnegative().nullable().default(null),
    cashRefundPerDayMinor: z.number().int().nonnegative().nullable().default(null),
    confirmPassword: z.string().min(1).max(200),
  })
  .strict();

export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export const deleteRoleRequestSchema = z
  .object({ confirmPassword: z.string().min(1).max(200) })
  .strict();

export type DeleteRoleRequest = z.infer<typeof deleteRoleRequestSchema>;

export const roleDetailSchema = z
  .object({
    id: z.string().length(26),
    code: z.string(),
    name: z.string(),
    /** Shipped with the tenant (§5.26). System roles cannot be deleted. */
    isSystem: z.boolean(),
    /**
     * True for Owner alone: §5.26 says it "cannot be deleted or de-privileged",
     * so the screen shows its permissions without letting them be unticked.
     */
    locked: z.boolean(),
    permissions: z.array(z.string()),
    cashRefundPerReturnMinor: z.number().int().nullable(),
    cashRefundPerDayMinor: z.number().int().nullable(),
    /** How many active people hold it — a role in use cannot be deleted. */
    userCount: z.number().int(),
  })
  .strict();

export type RoleDetailResponse = z.infer<typeof roleDetailSchema>;

export const permissionDescriptorSchema = z
  .object({
    code: z.string(),
    group: z.string(),
    label: z.string(),
    detail: z.string(),
  })
  .strict();

export type PermissionDescriptorResponse = z.infer<typeof permissionDescriptorSchema>;

/**
 * The catalogue travels with the list so the screen can label every tick-box
 * without knowing the codes itself — and so a permission the server does not
 * recognise can never be offered.
 */
export const roleListResponseSchema = z
  .object({
    roles: z.array(roleDetailSchema),
    catalogue: z.array(permissionDescriptorSchema),
  })
  .strict();

export type RoleListResponse = z.infer<typeof roleListResponseSchema>;
