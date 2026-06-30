import { describe, it, expect } from 'vitest';
import { createUserSchema, inviteUserSchema } from '../account';

describe('account schemas', () => {
  describe('createUserSchema', () => {
    it('accepts a valid payload and defaults role to viewer', () => {
      const r = createUserSchema.safeParse({ email: 'a@b.com', password: 'supersecret' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.role).toBe('viewer');
    });

    it('rejects a malformed email', () => {
      expect(createUserSchema.safeParse({ email: 'nope', password: 'supersecret' }).success).toBe(
        false,
      );
    });

    it('rejects a password shorter than 8', () => {
      expect(createUserSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(
        false,
      );
    });

    it('rejects a password past bcrypt’s 72-char limit', () => {
      expect(
        createUserSchema.safeParse({ email: 'a@b.com', password: 'x'.repeat(73) }).success,
      ).toBe(false);
    });

    it('trims surrounding whitespace from the email', () => {
      const r = createUserSchema.safeParse({
        email: '  a@b.com  ',
        password: 'supersecret',
        role: 'admin',
      });
      expect(r.success && r.data.email).toBe('a@b.com');
    });
  });

  describe('inviteUserSchema', () => {
    it('accepts email + role with no password', () => {
      const r = inviteUserSchema.safeParse({ email: 'a@b.com', role: 'qc' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.role).toBe('qc');
    });

    it('defaults role to viewer', () => {
      const r = inviteUserSchema.safeParse({ email: 'a@b.com' });
      expect(r.success && r.data.role).toBe('viewer');
    });

    it('rejects a malformed email', () => {
      expect(inviteUserSchema.safeParse({ email: 'nope' }).success).toBe(false);
    });

    it('rejects an invalid role', () => {
      expect(inviteUserSchema.safeParse({ email: 'a@b.com', role: 'superuser' }).success).toBe(
        false,
      );
    });
  });
});
