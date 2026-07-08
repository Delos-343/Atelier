// Cross-platform migration runner (Windows / macOS / Linux).
// Uses the `pg` dependency directly — no shell loops, no psql on PATH required.
// Creates the target database if it does not exist yet.
//
//   node scripts/migrate.mjs            # apply db/migrations/*.sql in order (Supabase / prod)
//   node scripts/migrate.mjs --local    # bare local Postgres: inserts the auth shim before RLS
//
// DATABASE_URL is read from the environment or from .env.local / .env.

import { readFileSync, readdirSync } from 'node:fs';
import { loadEnvFiles, resolvePgUrl } from './_env.mjs';
import { join } from 'node:path';
import pg from 'pg';


loadEnvFiles();
const url = resolvePgUrl();

// Create the target database if connecting to it fails with "does not exist" (3D000).
async function ensureDatabase(connectionString) {
  let dbName;
  try {
    dbName = decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  } catch {
    return; // unparseable — let the main connection surface the error
  }
  if (!dbName || dbName === 'postgres') return; // maintenance db always exists

  const probe = new pg.Client({ connectionString });
  try {
    await probe.connect();
    await probe.end();
    return; // already exists
  } catch (err) {
    await probe.end().catch(() => {});
    if (err.code !== '3D000') throw err; // a real connection error (host/password/refused)
  }

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`create database "${dbName.replace(/"/g, '""')}"`);
    console.log(`-- created database "${dbName}"`);
  } finally {
    await admin.end();
  }
}

const local = process.argv.includes('--local');

const allMigrations = readdirSync('db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => join('db/migrations', f));

// For bare local Postgres, insert the auth shim (Supabase roles + auth.uid())
// immediately after 0002 so the RLS migration (0003+) can reference them.
// Built dynamically so new migrations (0005, 0006, …) are always included.
const files = local
  ? allMigrations.flatMap((f) =>
      f.endsWith('0002_functions.sql')
        ? [f, 'db/__tests__/_setup_local_auth.sql']
        : [f],
    )
  : allMigrations;

try {
  await ensureDatabase(url);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(file, 'utf8');
      process.stdout.write(`-- applying ${file}\n`);
      await client.query('begin');
      try {
        await client.query(sql); // each file applied atomically
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`${file}: ${err.message}`);
      }
    }
    console.log(`\nDone. ${files.length} migration file(s) applied.`);
  } finally {
    await client.end();
  }
} catch (err) {
  console.error(`\nMigration failed — ${err.message}`);
  if (err.code === 'ECONNREFUSED') {
    console.error('No Postgres server is reachable at that host/port. Is Postgres running?');
  }
  if (/tenant or user not found|tenant\/user .* not found/i.test(err.message ?? '')) {
    console.error('The Supabase pooler did not recognize this tenant. Usually the region in the host');
    console.error('is wrong — copy the exact "Session pooler" string from Supabase → Settings →');
    console.error('Database → Connection string, and confirm the user is postgres.<project-ref>.');
  }
  if (err.code === 'ENOTFOUND') {
    console.error('That host did not resolve. Re-check the pooler host (region and aws-0/aws-1 prefix)');
    console.error('against the dashboard connection string.');
  }
  process.exitCode = 1;
}
