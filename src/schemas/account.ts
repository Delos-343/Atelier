import { z } from 'zod';

/** The four clearance levels, matching the `app_role` enum in the database. */
export const appRoleSchema = z.enum(['admin', 'production', 'qc', 'viewer']);

/**
 * Payload to create a login account. Password bounds: a sane 8-char minimum, and
 * a 72-char maximum because bcrypt (GoTrue's hashing algorithm) silently
 * truncates input beyond 72 bytes — rejecting it is clearer than hashing a prefix.
 */
export const createUserSchema = z.object({
  email: z.string().trim().email('A valid email address is required.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(72, 'Password must be at most 72 characters.'),
  role: appRoleSchema.default('viewer'),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Payload to invite a user by email. No password — Supabase emails an invitation
 * link and the invitee sets their own password on /accept-invite.
 */
export const inviteUserSchema = z.object({
  email: z.string().trim().email('A valid email address is required.'),
  role: appRoleSchema.default('viewer'),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
