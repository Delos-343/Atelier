# TechnicoFlor — Perfume ERP · Environment Variable Checklist (v0.50.0)

Where each value comes from, whether you need it, and where it goes. **Runtime (Vercel)** = set in the Vercel project's Environment Variables. **Build-time** vars (`NEXT_PUBLIC_*`) are baked into the client bundle, so **redeploy after changing them**. `DATABASE_URL` is **local-only** (migrations/seed/tests) — do **not** put it in Vercel.

Legend: ✅ required · 🟡 optional (feature degrades gracefully when unset) · 🔒 secret (server-only, never `NEXT_PUBLIC_`).

---

## Core — Supabase (required)

| Variable | Need | Where it's set | Where to get it | Notes |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Vercel (build) | Supabase → Settings → API → **Project URL** | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Vercel (build) | Supabase → Settings → API → **anon / publishable key** | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` also accepted |

Unset ⇒ app runs in **UI-preview mode**: pages render, but sign-in and all data calls report "not configured".

---

## Admin account lifecycle (optional)

| Variable | Need | Where | Source | Notes |
|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | 🟡 🔒 | Vercel (runtime) | Supabase → Settings → API → **service_role key** | Enables **create/delete login accounts** from the Users screen. Bypasses RLS — server-only, no `NEXT_PUBLIC_`. Unset ⇒ account controls hidden, role management still works. |

---

## App origin / invitations (optional)

| Variable | Need | Where | Source | Notes |
|---|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | 🟡 | Vercel (build) | Your production origin | Used to build the `<origin>/accept-invite` link when behind a host-rewriting proxy. Also add that URL to **Supabase → Auth → URL Configuration → Redirect URLs**. |

---

## Security layer — v0.50 (all optional)

| Variable | Need | Where | Source | Notes |
|---|---|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | 🟡 | Vercel (build) | Cloudflare → Turnstile → **Site key** | Renders the login CAPTCHA. The matching **Secret key** goes in **Supabase → Auth → Settings → CAPTCHA protection**, *not* here — Supabase verifies the token. Unset ⇒ no challenge shown. |
| `UPSTASH_REDIS_REST_URL` | 🟡 | Vercel (runtime) | Upstash → DB → REST API | Durable, cross-instance rate-limit store. Unset ⇒ in-memory per-instance limiter (resets on redeploy). |
| `UPSTASH_REDIS_REST_TOKEN` | 🟡 🔒 | Vercel (runtime) | Upstash → DB → REST API | Pair with the URL above. |
| `SECURITY_RATE_LIMIT` | 🟡 | Vercel (runtime) | — | Master switch, default **on**. Set `off` to disable all throttling. |
| `SECURITY_WAF` | 🟡 | Vercel (runtime) | — | Master switch, default **on**. Set `off` to disable the request filter (e.g. when a network WAF fronts the app). Security **headers** stay on regardless. |

> The Turnstile **secret key** is deliberately absent from this list — it never touches the app. It lives only in the Supabase dashboard.

---

## Email / SMTP (optional — documents & statements)

Enable by setting at least `SMTP_HOST` + `MAIL_FROM`. Any provider works (Resend, SES, Mailgun, Postmark, corporate relay).

| Variable | Need | Where | Notes |
|---|---|---|---|
| `SMTP_HOST` | 🟡 | Vercel (runtime) | Required to enable emailing. |
| `MAIL_FROM` | 🟡 | Vercel (runtime) | Required. `"TechnicoFlor <documents@your-domain>"` — an address your provider lets you send as. |
| `SMTP_PORT` | 🟡 | Vercel (runtime) | Default `587`. |
| `SMTP_USER` | 🟡 | Vercel (runtime) | Omit both user+pass for an IP-authorised relay. |
| `SMTP_PASS` | 🟡 🔒 | Vercel (runtime) | Secret. |
| `SMTP_SECURE` | 🟡 | Vercel (runtime) | `true` forces implicit TLS; otherwise inferred (true on 465, STARTTLS elsewhere). |

Unset ⇒ the "Email…" actions are disabled with a note; nothing else changes.

---

## Local only — never on Vercel

| Variable | Need | Where | Notes |
|---|---|---|---|
| `DATABASE_URL` | 🟡 | `.env.local` on your machine | Consumed by `yarn db:migrate` / `db:seed` / tests via the `pg` driver. Must be a `postgresql://` URI with your **DB password** (the Session Pooler URI from Supabase → Settings → Database) — **not** the API URL or anon key. The running app never uses it. |

---

## Minimal vs. recommended production set

**Minimal (just works):**
```
NEXT_PUBLIC_SUPABASE_URL=…
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
```

**Recommended production:**
```
NEXT_PUBLIC_SUPABASE_URL=…
NEXT_PUBLIC_SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…            # admin account lifecycle
NEXT_PUBLIC_SITE_URL=https://erp.yourdomain.com
NEXT_PUBLIC_TURNSTILE_SITE_KEY=…       # + secret in Supabase dashboard
UPSTASH_REDIS_REST_URL=…               # durable rate limiting
UPSTASH_REDIS_REST_TOKEN=…
SMTP_HOST=…                            # emailing (optional)
MAIL_FROM="TechnicoFlor <documents@yourdomain.com>"
```
