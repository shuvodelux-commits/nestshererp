import { z } from 'zod';

/**
 * User administration (slice 1.3, §5.3).
 *
 * `confirmPassword` is the **caller's own** password, re-entered to satisfy the
 * step-up requirement on creating, disabling or re-privileging a user. It is
 * never the new user's: a password an administrator typed is a password the
 * administrator knows.
 */
export const createUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    username: z.string().min(3).max(50),
    /** Mobile or email — the same single field as signup (D-07). */
    identifier: z.string().min(1).max(120),
    roleId: z.string().length(26),
    confirmPassword: z.string().min(1).max(200),
  })
  .strict();

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    roleId: z.string().length(26),
    /** Required only when the role changes; renaming is not step-up. */
    confirmPassword: z.string().min(1).max(200).optional(),
  })
  .strict();

export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const setUserDisabledRequestSchema = z
  .object({
    disabled: z.boolean(),
    confirmPassword: z.string().min(1).max(200),
  })
  .strict();

export type SetUserDisabledRequest = z.infer<typeof setUserDisabledRequestSchema>;

/** Never carries a hash, and never a credential of any kind. */
export const userResponseSchema = z
  .object({
    id: z.string().length(26),
    username: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    roleId: z.string().length(26),
    roleName: z.string(),
    disabled: z.boolean(),
    /** False until they set one through forgot-password — they cannot sign in yet. */
    hasPassword: z.boolean(),
  })
  .strict();

export type UserResponse = z.infer<typeof userResponseSchema>;

export const roleSummarySchema = z
  .object({
    id: z.string().length(26),
    code: z.string(),
    name: z.string(),
  })
  .strict();

export type RoleSummaryResponse = z.infer<typeof roleSummarySchema>;

/**
 * The roles travel with the list so the screen can show a role name and offer
 * the choices in one round trip — there is no separate roles endpoint until
 * slice 1.4 gives roles a screen of their own.
 */
export const userListResponseSchema = z
  .object({
    users: z.array(userResponseSchema),
    roles: z.array(roleSummarySchema),
  })
  .strict();

export type UserListResponse = z.infer<typeof userListResponseSchema>;
