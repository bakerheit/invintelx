import { z } from 'zod';
import { isoDateSchema, objectIdSchema } from './common.js';

export const ROLES = ['admin', 'member', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** Ranked least- to most-privileged, so `requireRole` can compare by index. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200, 'Password must be at most 200 characters');

export const emailSchema = z
  .string()
  .min(1, 'Email is required')
  .email('Enter a valid email address')
  .max(254)
  .transform((v) => v.trim().toLowerCase());

/** What the API returns about a user. Never includes the password hash. */
export const publicUserSchema = z.object({
  id: objectIdSchema,
  email: z.string().email(),
  name: z.string(),
  role: roleSchema,
  createdAt: isoDateSchema,
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const registerInputSchema = z.object({
  email: emailSchema,
  name: z.string().min(1, 'Name is required').max(120).trim(),
  password: passwordSchema,
  /**
   * Only meaningful for the registration that creates an instance's
   * administrator, and only when that instance requires one. Everything else
   * ignores it. See `setupStatusSchema` for how a client finds out.
   */
  setupToken: z.string().trim().max(200).optional(),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

/**
 * What an unauthenticated client may know about an instance's bootstrap state,
 * so the registration form can ask for the right things and say something true
 * about what the account it is about to create will be.
 */
export const setupStatusSchema = z.object({
  /** True while the instance has no accounts, so the next one becomes the administrator. */
  firstAccount: z.boolean(),
  /** True when that first registration must present the setup token from the server log. */
  setupTokenRequired: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const sessionResponseSchema = z.object({ user: publicUserSchema });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
