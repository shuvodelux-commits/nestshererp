import { z } from 'zod';

/**
 * Roles and what they may do (slice 1.4, §5.26).
 *
 * `confirmPassword` is the caller's own, re-entered. Changing what a role may
 * do re-privileges everyone holding it in one move — a wider act than editing
 * one person — so §5.3's step-up rule applies at least as strongly here.
 */
export const createRoleRequestSchema = z
  .object({
    name: z.string().min(2).max(60),
    permissions: z.array(z.string().max(80)).max(200),
    confirmPassword: z.string().min(1).max(200),
  })
  .strict();

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .object({
    name: z.string().min(2).max(60),
    permissions: z.array(z.string().max(80)).max(200),
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
