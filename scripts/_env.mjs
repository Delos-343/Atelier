// Shared environment helpers for the migrate/seed scripts.
// Loads .env.local / .env, then validates DATABASE_URL and fails with an
// actionable, password-masked message instead of a raw stack trace.

import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFiles(files = ['.env.local', '.env']) {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
  }
}

/** Hide the password in a postgres URL's authority (best-effort, works on raw strings too). */
function maskUrl(url) {
  return url.replace(/(:\/\/[^:@/]+:)[^@/]*(@)/, '$1****$2');
}

/**
 * Resolve and validate DATABASE_URL. On any problem, prints a clear message
 * (with the password masked) and exits 1 — so a misconfigured connection
 * string never surfaces as an opaque "Invalid URL" stack trace.
 */
export function resolvePgUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw || !raw.trim()) {
    console.error('\n\u2716 DATABASE_URL is not set.');
    console.error('  Add it to .env.local (recommended) or your shell environment, e.g.:');
    console.error('    DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"   # local Supabase stack\n');
    process.exit(1);
  }
  const url = raw.trim();

  // Catch unreplaced placeholders / illegal raw brackets up front and name them:
  // angle-bracket (<REGION>) or square-bracket ([YOUR-PASSWORD]) tokens are the
  // usual leftover-from-a-template mistake, and either makes new URL() throw.
  const placeholders = [...url.matchAll(/<[^>]*>|\[[^\]]*\]/g)].map((m) => m[0]);
  if (placeholders.length > 0 || /YOUR[-_ ]?PASSWORD/i.test(url)) {
    console.error('\n\u2716 DATABASE_URL still contains placeholder text that must be replaced:');
    console.error('    ' + maskUrl(url));
    if (placeholders.length > 0) {
      console.error('  unresolved placeholder(s): ' + placeholders.join('  '));
    }
    console.error('  Replace each with the real value. The simplest source is the exact connection');
    console.error('  string in Supabase \u2192 Settings \u2192 Database \u2192 Connection string (Session pooler).');
    console.error('  (If a real password contains [ ] < >, percent-encode it: [\u2192%5B ]\u2192%5D <\u2192%3C >\u2192%3E.)');
    console.error('');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error('\n\u2716 DATABASE_URL is set but is not a valid URL:');
    console.error('    ' + maskUrl(url));
    console.error('  Likely fix:');
    if (/^["'].*["']$/.test(url)) {
      console.error('    \u2022 Remove the surrounding quotes (cmd.exe `set` keeps them literally; use');
      console.error('      PowerShell `$env:DATABASE_URL=...` or put the value in .env.local).');
    }
    console.error('    \u2022 If the password contains @ : / ? # [ ], percent-encode them:');
    console.error('      @\u2192%40  #\u2192%23  /\u2192%2F  :\u2192%3A  ?\u2192%3F');
    console.error('');
    process.exit(1);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    console.error(`\n\u2716 DATABASE_URL must be a postgres URL (postgres:// or postgresql://), got "${parsed.protocol}".`);
    console.error('    ' + maskUrl(url));
    if (parsed.protocol === 'https:') {
      console.error('  That looks like the Supabase project API URL. For migrations/seed you need the');
      console.error('  database connection string (Settings \u2192 Database \u2192 Connection string \u2192 Session pooler).');
    }
    console.error('');
    process.exit(1);
  }

  return url;
}
