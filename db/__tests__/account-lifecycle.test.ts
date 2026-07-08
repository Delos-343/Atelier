import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, q, truncateAll } from './helpers';
import type { PoolClient } from 'pg';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const ADMIN2 = '33333333-3333-3333-3333-333333333333';
const VIEWER = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  await truncateAll();
  // The emulated auth.users (local shim) isn't part of truncateAll's table list.
  await q('delete from auth.users');
});
afterAll(async () => {
  await pool.end();
});

/** Run as a Supabase `authenticated` user with a given JWT subject (→ auth.uid()). */
async function asUser<T>(sub: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('set role authenticated');
    await client.query(`set app.jwt_sub = '${sub}'`);
    return await fn(client);
  } finally {
    await client.query('reset role').catch(() => {});
    client.release();
  }
}

const check = (c: PoolClient, target: string) =>
  c
    .query('select admin_check_user_deletable($1) as email', [target])
    .then((r) => r.rows[0].email as string | null);

/** Seed auth.users (+ optional app_users role) rows. */
async function seedUsers(rows: Array<{ id: string; email: string; role?: string }>) {
  for (const r of rows) {
    await q('insert into auth.users(id, email) values($1,$2)', [r.id, r.email]);
    if (r.role) await q('insert into app_users(user_id, role) values($1,$2)', [r.id, r.role]);
  }
}

describe('admin_check_user_deletable (account-deletion guard)', () => {
  it('returns the email for a deletable non-admin user', async () => {
    await seedUsers([
      { id: ADMIN, email: 'admin@x.com', role: 'admin' },
      { id: VIEWER, email: 'viewer@x.com', role: 'viewer' },
    ]);
    await asUser(ADMIN, async (c) => {
      expect(await check(c, VIEWER)).toBe('viewer@x.com');
    });
  });

  it('rejects deleting your own account', async () => {
    // Two admins so the self-guard (not the last-admin guard) is what fires.
    await seedUsers([
      { id: ADMIN, email: 'admin@x.com', role: 'admin' },
      { id: ADMIN2, email: 'admin2@x.com', role: 'admin' },
    ]);
    await asUser(ADMIN, async (c) => {
      await expect(check(c, ADMIN)).rejects.toThrow(/your own account/i);
    });
  });

  it('lets one admin delete another admin when more than one remains', async () => {
    await seedUsers([
      { id: ADMIN, email: 'admin@x.com', role: 'admin' },
      { id: ADMIN2, email: 'admin2@x.com', role: 'admin' },
    ]);
    await asUser(ADMIN, async (c) => {
      expect(await check(c, ADMIN2)).toBe('admin2@x.com');
    });
  });

  it('returns P0002 for an unknown user', async () => {
    await seedUsers([{ id: ADMIN, email: 'admin@x.com', role: 'admin' }]);
    await asUser(ADMIN, async (c) => {
      await expect(check(c, VIEWER)).rejects.toThrow(/no such user/i);
    });
  });

  it('rejects a non-admin caller with 42501', async () => {
    await seedUsers([
      { id: ADMIN, email: 'admin@x.com', role: 'admin' },
      { id: VIEWER, email: 'viewer@x.com', role: 'viewer' },
    ]);
    await asUser(VIEWER, async (c) => {
      await expect(check(c, ADMIN)).rejects.toThrow(/admin clearance/i);
    });
  });
});
