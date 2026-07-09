# TechnicoFlor — Perfume ERP · Deployment Runbook

**Target stack:** Supabase (Postgres + Auth) · Vercel (Next.js 14 hosting) · optional Cloudflare Turnstile (CAPTCHA) and Upstash Redis (durable rate limiting).
**Applies to:** v0.50.0.

This is a step-by-step, do-it-once runbook to take the repo from zero to a live, secured deployment. It pairs with two companion files: the bundled schema (`technicoflor_erp_schema_v0.50.0.sql`) and the environment checklist (`ENV_CHECKLIST.md`).

---

## 0. Before you start — what you'll need

- A GitHub (or GitLab/Bitbucket) repo holding this project.
- A [Supabase](https://supabase.com) account.
- A [Vercel](https://vercel.com) account.
- *(Optional, recommended for production)* a [Cloudflare](https://dash.cloudflare.com) account for Turnstile and an [Upstash](https://upstash.com) account for Redis.
- *(Optional)* SMTP credentials from any provider (Resend, SES, Mailgun, Postmark, or a corporate relay) if you want to email invoices/statements and invitations.

Nothing about the security layer is required to boot: with none of the optional keys set, the app runs with in-memory rate limiting, no CAPTCHA, and the always-on security headers + request filter.

---

## 1. Create the Supabase project

1. Supabase dashboard → **New project**. Pick a name, a strong **database password** (save it — you'll need it for the seed step), and a region close to your users.
2. Wait for provisioning to finish (~2 minutes).
3. Open **Project Settings → API** and copy, for the next steps:
   - **Project URL** → `https://<project-ref>.supabase.co`
   - **anon / publishable key** (the public client key)
   - **service_role key** (secret — needed only for admin account create/delete)

---

## 2. Apply the database schema (paste, don't wire the CLI)

Use the bundled SQL so you don't have to set up the Supabase CLI for a one-off.

1. Supabase dashboard → **SQL Editor → New query**.
2. Open `technicoflor_erp_schema_v0.50.0.sql`, copy the **entire** file, paste it in.
3. Click **Run**.

The file bundles all 45 migrations in order inside a single transaction — it either fully applies or rolls back cleanly. It assumes the Supabase-managed `auth` schema exists (it does on every Supabase project), so the local-only auth shim is intentionally excluded.

**Verify:** SQL Editor → run `select count(*) from information_schema.tables where table_schema='public';` — you should see the ERP's tables (materials, products, warehouses, inventory_lots, stock_movements, formulas, app_users, sales_orders, bills, issued_documents, …).

> Run this once on a fresh project only. Re-running against a project that already holds the schema is not supported.

---

## 3. Create your first admin user (bootstrap)

Every signed-in user defaults to `viewer`. The first admin has to be set directly, because the in-app admin tools require an existing admin.

1. Supabase dashboard → **Authentication → Users → Add user**. Create your login (email + password). Copy the new user's **UUID**.
2. SQL Editor → run (substitute the UUID):

   ```sql
   insert into app_users (user_id, role) values ('<the-new-auth-user-id>', 'admin');
   ```

That user is now an admin; from inside the app they can create and manage everyone else.

---

## 4. Configure Supabase Auth (URLs, CAPTCHA, SMTP)

### 4a. Redirect / site URLs
**Authentication → URL Configuration:**
- **Site URL:** your production origin, e.g. `https://erp.yourdomain.com` (or the Vercel URL for now — update after step 6).
- **Redirect URLs:** add `<origin>/accept-invite` so email invitations can complete.

### 4b. CAPTCHA protection (Cloudflare Turnstile) — optional but recommended
This is what makes the login CAPTCHA real. **Supabase verifies the token server-side**, so the secret key lives here, not in the app.
1. Cloudflare dashboard → **Turnstile → Add site**. Add your domain. Copy the **Site key** (public) and **Secret key** (secret).
2. Supabase → **Authentication → Settings → Enable CAPTCHA protection** → provider **Turnstile** → paste the **Secret key** → Save.
3. Keep the **Site key** for Vercel env `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (step 6).

If you skip this, the login form simply shows no challenge.

### 4c. Auth emails / SMTP — optional
If you want invitation emails (and Supabase's own auth emails) to send, configure **Authentication → Emails → SMTP settings** with your provider. The same credentials typically work for the app's document/statement emailing (step 6, `SMTP_*`).

---

## 5. (Optional) Provision Upstash Redis for durable rate limiting

Without this, rate limiting uses an in-memory window that is per-instance and resets on redeploy — fine to start, not ideal across Vercel's many lambdas.
1. Upstash → **Create Database** (Redis). Pick a region near your Vercel region.
2. Open the database → **REST API** → copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** for step 6.

---

## 6. Deploy to Vercel

1. Vercel → **Add New… → Project** → import your Git repo.
2. **Framework preset:** Next.js (auto-detected). Leave build command (`next build`) and output as defaults.
3. **Environment Variables** — add these (see `ENV_CHECKLIST.md` for the full table). At minimum:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | your Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon/publishable key |

   Recommended / optional:

   | Variable | Purpose |
   |---|---|
   | `SUPABASE_SERVICE_ROLE_KEY` | admin account create/delete (server-only) |
   | `NEXT_PUBLIC_SITE_URL` | your production origin (invite links behind a proxy) |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile **site** key (login CAPTCHA) |
   | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | durable rate limiting |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | emailing documents & statements |

   Leave `DATABASE_URL` **out** of Vercel — it's only used by migrations/tests/seed, never by the running app.

4. Click **Deploy**.
5. After the first deploy, copy the production URL and go back to **Supabase → Auth → URL Configuration** to set the real **Site URL** and the `<origin>/accept-invite` redirect. Also add your production domain to the **Cloudflare Turnstile** site if you set that up. Redeploy if you changed `NEXT_PUBLIC_*` values (they're baked in at build time).

---

## 7. (Optional) Seed demo data

The seed is not part of the bundled SQL. To load a runnable demo dataset, run it from any machine with the repo:

```bash
# .env.local, using the Session Pooler URI from Supabase → Settings → Database:
DATABASE_URL="postgresql://postgres.<project-ref>:<DB-PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres"

yarn install
yarn db:seed
```

It's idempotent (safe to re-run) and prints the Product / Formula-version / Warehouse IDs to paste into the New Production Order form.

---

## 8. Post-deploy smoke test

- [ ] Visit the production URL → the **public dashboard** at `/` renders (aggregates only).
- [ ] **Sign in** with your admin user → you land in `/app` and an **Admin** entry appears.
- [ ] If Turnstile is on: the login form shows the "I'm human" widget and sign-in requires it.
- [ ] Open DevTools → Network → the document response carries `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
- [ ] Hit a bogus path like `/.env` or `/app/../../etc/passwd` → **403 Forbidden** (the request filter).
- [ ] Hammer an endpoint past its limit → **429** with a `Retry-After` header (rate limiting).
- [ ] If SMTP is set: issue an invoice and email it; confirm the PDF arrives.

---

## 9. Rollback & operations notes

- **Schema:** the bundled SQL runs in one transaction — a failed paste leaves nothing behind. For app rollbacks, Vercel keeps every deployment; **Promote** a previous one from the dashboard.
- **Turning security layers off:** set `SECURITY_WAF=off` or `SECURITY_RATE_LIMIT=off` in Vercel env (e.g. when a network WAF already fronts the app) and redeploy. The security **headers** stay on regardless.
- **Behind a real WAF:** for production, also front the app with Cloudflare / Vercel WAF / AWS WAF + Shield for volumetric/DDoS protection; the app-layer filter is a portable backstop, not a substitute.
- **Secrets hygiene:** `SUPABASE_SERVICE_ROLE_KEY` and `SMTP_PASS` are server-only — never prefix them with `NEXT_PUBLIC_`. The Turnstile **secret** lives in Supabase, never in the app.
