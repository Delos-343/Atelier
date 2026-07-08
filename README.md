# TechnicoFlor - Perfume ERP (Manufacturing Core) · v0.51.0

A ground-up rebuild of the **ERP Perfume: Manufacturing & Distribution System** for TFI,
on Next.js 14 + Supabase (PostgreSQL), shipped as an offline-capable PWA. Package manager: **Yarn**.

Build philosophy: the riskiest part of a manufacturing ERP is the integrity of the numbers, not
the screens. The data model and its invariants were verified against live PostgreSQL first; the
security layer, API, UI, offline support, and now a redesigned responsive front-end were
layered on a core that cannot silently corrupt stock or leak trade secrets.

## Version history

The complete version history — a condensed slice-by-slice summary plus detailed release notes for
every release from v0.5 through the current **v0.51.0** — is kept in a dedicated document,
**ERP Perfume - Version History & Release Notes.docx**, alongside this file. This README is the project's operating manual and technical
reference; the changelog lives there.

## The three invariants (and where they live)

| Invariant | Risk if wrong | Enforced in |
|---|---|---|
| **BOM math is exact** | Components drift off batch target; raw material over/under-issued | `src/domain/formula.ts` — decimal.js + Hamilton largest-remainder |
| **Stock never goes negative / FEFO holds** | Oversell, negative stock, expired issue, lost updates under load | `db/migrations/0002_functions.sql` — `post_movement()` locks the lot `FOR UPDATE` |
| **Genealogy is complete & atomic** | Recall can't trace raw → finished; partial consumption on failure | `complete_production_order()` + `0004_genealogy.sql` traversal |

Source of truth: `stock_movements` is append-only; `quantity_on_hand` is a projection mutated only
by `post_movement()` under a row lock. Security: RLS on all 14 tables; the ledger has no write
policy — stock changes go only through the audited SECURITY DEFINER functions.

## Architecture

```
Next.js 14 (App Router, offline PWA)
  middleware.ts                 WAF filter + rate limit + CSP nonce -> session refresh + route protection
  app/inventory/[id]/           lot drill-down: genealogy + ledger
  app/(formulas|production|qc|inventory)/  client pages -> /api, offline-cached reads
  app/api/                      typed route handlers (incl. production/preview, lots/[id])
  app/components/                SiteNav (responsive), DataTable (responsive), theme/
  app/components/motion/         Framer Motion helpers: Reveal (scroll), template.tsx page transitions
  app/components/theme/         ThemeProvider (light/dark/system) + ThemeToggle
  app/components/offline/       OfflineProvider, banner, AsyncView, useApiData
  src/lib/offline/              outbox (queue+flush), IndexedDB store, online hook
  src/lib/security/             rate limiter (in-memory/Upstash), WAF-lite, security headers, Turnstile
  src/server/production.ts      preview + create + complete + QC orchestration
  src/domain/                   PURE, fully unit-tested business math (no I/O)

PostgreSQL (Supabase)
  0001_init.sql       schema (14 tables, immutable formula versions)
  0002_functions.sql  integrity core (locked movements, FEFO, atomic completion, QC)
  0003_security.sql   RBAC + RLS + function hardening
  0004_genealogy.sql  recursive ancestor/descendant traversal
```

## Security hardening (v0.50)

An edge security layer sits in front of the Supabase auth/RLS core that has always
governed the data. It's defense-in-depth: every layer degrades safely, each is
independently switchable by env, and with nothing configured the app behaves exactly
as it did before v0.50. All of it lives in `src/lib/security/` and is wired through
`middleware.ts`.

**Rate limiting** — a fixed-window limiter with two interchangeable backends. In-memory
by default (edge-safe, zero-config, but per-instance and reset on redeploy); it upgrades
automatically to **Upstash Redis** — durable and shared across every instance — the moment
`UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, with no code change. The middleware applies a
broad per-IP throttle to `/api/**` (120/min) and a tighter one to the auth pages (30/min);
the expensive endpoints that send mail or mint accounts add their own per-route caps
(10/min) via `enforceRateLimit()`. Over-limit gets a `429` with `Retry-After`. An Upstash
outage fails open (falls back to in-memory and logs) — a limiter must never take down the app.

**CAPTCHA** — Cloudflare **Turnstile** on the login form. The widget renders only when
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set; its token is passed to Supabase Auth as
`captchaToken`, and **Supabase verifies it server-side** with the matching secret key
(configured in the Supabase dashboard, Auth → Settings → Enable CAPTCHA protection → Turnstile),
so this app never handles the secret. Unset ⇒ no challenge, unchanged behaviour. (The
`/accept-invite` flow is already gated by a single-use emailed token and takes no CAPTCHA.)

**WAF (application layer)** — two parts, both always-on (toggle with `SECURITY_WAF=off`):

- **Security headers** on every response — a nonce-based **Content-Security-Policy**
  (inline scripts must carry the per-request nonce; Next.js stamps its own bundles and our
  one theme script opts in via the same nonce, so injected `<script>`s won't run), **HSTS**,
  `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  a lean `Referrer-Policy` and `Permissions-Policy`. The Turnstile challenge origin and the
  configured Supabase origin (https + wss) are the only third parties allow-listed.
- A small **request filter** that sheds the loudest automated abuse before it reaches a
  route — path traversal, null-byte tricks, blatant reflected-XSS payloads, and scanner
  probes for secrets this app never serves (`.env`, `.git`, `wp-login.php`). It is tuned for
  zero false positives on real ERP traffic (UUIDs, ISO dates, ordinary query params all pass);
  genuine input validation stays where it belongs — Zod + parameterized SQL + RLS.

> **Deploy behind a real WAF/CDN too.** The app-layer filter is a backstop, not a substitute
> for a network WAF. In production, front the app with Cloudflare, Vercel's WAF, or AWS WAF +
> Shield for volumetric/DDoS protection and a managed ruleset, and set `UPSTASH_*` so rate
> limits are shared across instances. When a network WAF is doing the heavy lifting you can set
> `SECURITY_WAF=off` to avoid double-filtering; the security headers remain valuable regardless.

## Running it (Yarn)

The data layer and auth both run through **Supabase** (PostgREST + GoTrue), so how far the app runs
depends on whether a Supabase endpoint is connected. Three paths:

### A. UI preview — no backend (fastest)

See the redesign, theming, responsive layout, and flow. Data panels show a "not configured" notice.

```bash
yarn install
yarn dev            # http://localhost:3000 — no .env.local needed
```

### B. Full local stack — auth + data (recommended for real use)

Run the **whole Supabase stack locally** with Docker (no cloud). Requires Docker Desktop running
and the Supabase CLI (`scoop install supabase` on Windows, or `npx supabase`).

```bash
supabase init
supabase start                 # prints API URL (…:54321), anon key, and DB URL (…:54322)

# apply this repo's schema to the local stack's Postgres (auth roles already exist → db:migrate):
#   (use the DB URL printed by `supabase start`, port 54322)
$env:DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"   # PowerShell
yarn db:migrate
```

Then create `.env.local` with the values `supabase start` printed:

```
NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
NEXT_PUBLIC_SUPABASE_ANON_KEY="<anon key from supabase start>"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

Create a sign-in user in Supabase Studio (`http://127.0.0.1:54323` → Authentication → Add user),
then insert a matching role row so RLS recognises them:

```sql
insert into app_users (user_id, role) values ('<the new auth user id>', 'admin');
```

(Optional) load demo data so the console isn't empty — it reads `DATABASE_URL` from `.env.local`:

```bash
yarn db:seed        # seeds a warehouse, materials, a locked formula + stock; prints IDs for the form
```

```bash
yarn dev            # now login + all module data work end to end
```

You'll land on the **public dashboard at `/`** (open, aggregates only). *Sign in* → the console at
**`/app`** (Formulas / Production / Quality / Inventory). If your `app_users` role is `admin`, an
**Admin** entry appears, linking to **`/admin`**. Signing out returns you to `/`.

### C. Bare PostgreSQL — migrations & tests only

The migration runner and the test suite talk to Postgres **directly** (via `pg`), so a plain local
Postgres is all they need. The *app*, however, reaches data only through Supabase's API — so use
this path for schema + tests, and path B to actually run the app.

```bash
DATABASE_URL="postgres://postgres:YOURPASSWORD@localhost:5432/atelier" yarn db:test:setup
# unit + integration (Vitest)
yarn test               # 100 unit (domain, offline outbox, error mapper, schemas incl. payments/void, PDF specs incl. statement and running-account ledger, CSV serialiser, statement aggregation, mail transport incl. a loopback SMTP round-trip), no DB
yarn test:integration   # 194 DB tests: integrity, FEFO, genealogy, RLS, halal, costing, sales / shipment / returns, documents, sequences, invoice payments + void, documents register, due-date aging, credit-note allocation, accounts payable, tax & pricing, cash application, procurement, tax reporting, customer ledger, three-way match, faktur list, statement emails, billing exceptions, supplier ledger, email history
yarn test:all           # all 294
```

The runner reads `DATABASE_URL` from `.env.local` or the environment and **creates the database if
it doesn't exist**. Use `db:migrate` against Supabase (auth roles exist) and `db:test:setup`
against bare Postgres (adds an auth shim so `0003` loads). `yarn db:seed` works here too — it talks
to Postgres directly like the tests — though you'll need path B's Supabase API to view the data in the app.

## Cypress (end-to-end + component)

Both modes run against the dev server, so start it first, then in a second terminal:

```bash
yarn dev                 # terminal 1

yarn cypress:run         # terminal 2 — automated, headless E2E
yarn cypress:component   #            — automated, headless component ("unit") tests
yarn cypress:open        #            — manual, interactive runner (E2E + component)
yarn typecheck:e2e       # type-check the specs without running them
```

E2E covers the flow (landing, theme persistence, protected-route redirect, sign-in form);
component specs mount `OfflineBanner` and `DataTable` in isolation.

## Test coverage (310 tests, all passing)

- **Domain — 10**: unit conversion incl. density; validation; exact-sum scaling; 200-trial property test.
- **Offline — 4**: enqueue + ordering; flush success; offline retain; 4xx drop vs 5xx keep.
- **Integrity — 9**: no negative stock; expired/quarantine guards; reconciliation; FEFO + genealogy;
  atomic rollback; QC gating; 100 concurrent issues serialize under row locks.
- **Halal compliance — 13**: the `CHECK` rejects certifying without a number/expiry and permits
  `not_certified` / `in_review` bare; each offender reason (*not certified*, *in review*, *certificate
  expired*); every offender returned ordered by SKU with the compliant one omitted; a fully-certified
  version reads compliant; an empty version is vacuously compliant; the `as_of` boundary (valid through
  the expiry date, lapsed the day after); and the overview aggregate (one row per version, JSON offenders
  ordered by SKU, product-name join).
- **Halal gate — 4**: completing an order whose recipe has a non-certified material is blocked and the
  error names the offending sku, leaving the order un-completed with nothing produced (clean no-op); a
  certified, unexpired recipe completes; an expired certificate blocks; and an empty formula version
  passes silently.
- **Security — 6**: formulas hidden from viewers; ledger direct-write blocked even for admins;
  SECURITY DEFINER gateway works; role-gated writes.
- **WAF-lite — 6**: ordinary ERP traffic (ids, ISO dates, query params) passes; path traversal (raw
  and `%2e%2e`), null bytes, reflected-XSS payloads, and secret-file/scanner probes (`.env`, `.git`,
  `wp-login.php`) are blocked; legitimate dotted filenames (`invoice.pdf`) are not mistaken for probes.
- **Rate limiter — 6**: permits up to the limit then 429s with a Retry-After; windows key independently
  per identifier and per bucket; the window resets after it elapses; the header helper adds Retry-After
  only when blocked.
- **Security headers / CSP — 4**: the per-request nonce binds into `script-src`; the Turnstile origin is
  allowed in script/frame sources; framing and object embedding are locked (`frame-ancestors 'none'`,
  `object-src 'none'`); HSTS is emitted by default and omitted for plain-http dev.
- **Formula RPCs — 5**: create + clone; draft-save at any sum; lock rejected when percent ≠ 100;
  edit/delete blocked on a locked version; viewer denied.
- **Account guard — 5**: a deletable non-admin returns its email; deleting yourself is blocked; one
  admin can delete another while more than one remains; an unknown user gives P0002; a non-admin
  caller is denied.
- **Server errors — 5**: the shared `mapRpcError` status contract — 42501→403, P0002→404 (caller
  message vs. pass-through), P0001→409, unknown and null→500.
- **Account schemas — 9**: `createUserSchema` (email/password bounds incl. bcrypt's 72-char limit,
  email trim, role default) and `inviteUserSchema` (email + role, no password, role validation).
- **Metric RPC payloads — 9**: the `public_metrics`/`dashboard_metrics` Zod schemas — accept
  well-formed and empty-database payloads, tolerate additive keys, and reject missing/wrong-typed
  fields (the drift that used to surface as dashboard `NaN`s).
- **Genealogy — 3**: ancestors of a finished lot with consumed quantities; forward descendants; orphan lot.
- **Costing — 3**: material-cost roll-up with g→kg conversion freezes the finished lot's `unit_cost` and
  the per-consumption cost; a post-completion `standard_cost` change leaves the frozen cost untouched;
  `dashboard_metrics` values finished goods and unit-converted raw.
- **Sales — 4**: `create_sales_order` writes header + lines atomically; `product_available_cost`
  weighted-average and per-line expected margin; null estimate/margin when a product has no costed
  available stock; an invalid line rolls the whole order back.
- **Availability — 3**: `product_available_quantity` sums only available, in-warehouse, in-unit,
  unexpired, on-hand-positive lots (each exclusion isolated); returns 0 rather than null when nothing
  matches; date-aware (a lot whose expiry is today still counts).
- **Lot primitive — 2**: `_create_lot` is born empty (on-hand 0) with exactly the passed attributes,
  and its status / unit-cost defaults behave.
- **FEFO allocator — 3**: `fefo_allocate` takes earliest-expiry lots first (partial on the last needed),
  returns only what's available when the request exceeds stock, and draws only available, in-warehouse,
  unexpired lots.
- **Documents — 4**: `invoice_document` totals priced lines sorted by sku; `packing_slip_document`
  reports ordered vs shipped with no prices; `credit_note_document` carries the refunded lines, source
  order, and total; a missing id returns null (a 404 at the API).
- **Halal override — 4**: a non-compliant order is still blocked with no override; an admin completes it
  with a reason and the override is recorded (formula version, trimmed reason, `overridden_by` from
  `auth.uid()`, offending-input snapshot); a non-admin's override raises and changes nothing; and an
  admin override without a reason raises.
- **Document PDFs — 7**: the invoice / packing-slip / credit-note adapters map each DTO to the right
  columns, rows, and total (packing slips carry no prices; credit notes carry the source order); an
  issued snapshot's replaced identifiers surface as *Order* / *Ref* meta lines while live documents add
  none; the composer renders each to valid, non-trivial PDF bytes and tolerates empty lines / a missing
  warehouse; and the filename builder sanitizes a document code.
- **Issued documents — 4**: issuing freezes an invoice snapshot whose total holds at 100 while the live
  rebuild moves to 1998 after a price change, filed under the first series number with the snapshot
  self-contained (`snapshot.number = document_number`) and the order code preserved; a non-admin's
  issuance raises and records nothing; a credit note carries its `credit_note_id`, source order, and
  the manual code it replaced; and a bad source is rejected.
- **Document sequences — 5**: each kind advances its own year-scoped series (two invoices then a
  packing slip and credit note land as INV-…-00001/00002, PS-…-00001, CN-…-00001) with the snapshot
  self-contained and the replaced identifiers preserved; a rolled-back issuance returns its number to
  the series (gapless); 12 concurrent issuances serialize into 00001–00012 with no duplicates or gaps;
  the year scopes the series, widths widen past 99,999 rather than truncate, and an unknown kind
  raises; and the counter is fully locked away — reads, writes, and the number helper are all denied
  to authenticated clients.
- **Invoice payments — 13**: a payment records with trimmed method/reference attributed to the admin;
  the single derivation walks open → partially_paid → paid across payments; a sub-cent snapshot residue
  is the paper figure and settles to the cent, closing the invoice; overpayment (naming the balance and
  number), sub-cent precision, and non-positive amounts are rejected; payments attach to issued invoices
  only, never to a voided one, and only under admin clearance; voiding requires admin, a reason, and a
  not-already-void target, and is refused while payments remain; deleting a payment reopens the balance
  (admin-only); concurrent payments serialize so none breaches the claim; the register shows a voided
  invoice as void with its reason; and the payments table is locked against direct client writes.
- **Documents register — 3**: `issued_documents_register()` lists every issued document across two
  orders, each carrying its order code, customer, kind, and number, with a packing slip's claim and
  payment status null; emailing an invoice twice then paying it partially yields email_count 2 with the
  latest recipient and a `partially_paid` status reused from `invoice_receivables()` (paid 40 / open 60),
  while the packing slip shows no send or payment state; and a voided document reads back voided with its
  reason, readable by a viewer (the derivation is granted to authenticated; the route gates admin).
- **Due-date aging — 4**: issuing an invoice on Net-45 terms stamps a due date 45 days out and leaves
  it not overdue, while backdating the due date flips `overdue` true and settling it flips it back;
  `receivables_aging(as_of)` buckets each open invoice by days past due (not-due / 1–30 / 31–60 /
  61–90 / 90+); the boundaries land exactly (−10, 0 → current, 1, 30 → 1–30, 31, 60, 61, 90, 91 →
  90+); and paid and voided invoices drop out while a partially-paid one appears at its open balance
  reused from `invoice_receivables()` (total 100, paid 30, open 70).
- **Credit-note allocation — 5**: applying a 40 credit to a 100 invoice drops it to 60 open / 40
  credit / partially paid while the note's remaining goes to 0; a credit that covers the invoice
  settles it (open 0, paid status); the guards reject over-crediting the note, a non-invoice target, a
  different customer, a non-admin, and crediting past the invoice's open balance (pay 80, then a 40
  credit overflows) or a voided invoice; a credit splits across two of one customer's invoices, and
  removing an allocation reopens both the invoice and the note; direct table writes are denied while
  reads are allowed.
- **Statement & export — 6**: the CSV serialiser emits a header and CRLF-joined rows, quotes fields
  with commas / quotes / newlines (doubling embedded quotes) and renders null as empty while coercing
  numbers; the statement aggregation sums each customer's open invoices into their aging buckets and a
  grand outstanding (and zeroes cleanly for a nil balance); and the statement PDF adapter maps a
  customer's aged invoices to a five-column spec — overdue days or a dash, the bucket summary note,
  the outstanding total — and renders to a valid PDF.
- **Accounts payable — 7**: a bill takes its due date from the supplier's terms, or honours an
  explicit due date that overrides them, and its open balance derives from `bill_payables()`; payments
  settle a bill and the guards hold (over-payment, a voided bill, and a non-admin caller are each
  refused); deleting a payment reopens the balance; an unpaid bill voids while a paid one is refused;
  the aging buckets a supplier's bills by days past due and excludes the paid and the voided; and
  direct client writes to `bills` and `bill_payments` are denied while reads are allowed.
- **Tax & pricing — 5**: an invoice computes subtotal → per-customer discount → taxable base → PPN →
  total, and freezes every figure into the snapshot; an exempt customer is zero-rated regardless of the
  house rate; with no discount the whole subtotal is taxed; the tax-inclusive total flows into the
  issued invoice and its receivable; and the rate and the discount are frozen at issue, so changing
  either afterwards leaves an issued invoice untouched while a fresh draft reflects the new values.
  (The invoice PDF's breakdown block — subtotal, a signed discount, taxable, PPN, an emphasised total,
  with the discount rows omitted when there is none — is covered in the document-PDF adapter and
  composer tests.)
- **Cash application — 7**: one receipt clears several invoices at once and reconciles with the
  receivable (the applied figure comes back through invoice_receivables, proving the applications are
  ordinary payments); an unapplied remainder is held on account; a receipt's remaining balance is
  applied to more invoices later; an allocation beyond an invoice's open balance is refused, as are
  allocations totalling more than the receipt (and the whole call rolls back, banking nothing);
  deleting a receipt reverses every application so the invoices reopen; and the tables are admin-only
  and select-only — a viewer can neither apply a receipt nor write the rows directly.
- **Procurement — 7**: a purchase order is raised with lines (open and unbilled); receiving a line
  lands a raw lot in inventory with the right on-hand, status, expiry and cost, and closes the order; a
  partial receipt is tracked and then completed by a second delivery into a second lot; over-receiving a
  line is refused; billing a PO feeds payables and links the bill back to the order (defaulting to the
  received value); an order can be cancelled while open but not once it has received stock; and the
  tables are admin-only and select-only.
- **Tax report — 6**: output tax from invoices and input tax from bills are summed and netted to a
  payable; when input exceeds output the net is a credit; only documents inside the period are counted;
  voided invoices and voided bills are excluded from both sides; tax-exempt sales sit in the taxable
  base at zero tax while a pre-tax invoice (no frozen tax) is ignored entirely; and a bill whose PPN
  exceeds its own amount is refused.
- **Customer ledger — 5**: a running account opens with the prior balance and carries it down invoices,
  credit notes and receipts to the balance due; a direct payment shows as its own line while a
  receipt-tagged payment is folded into the receipt lump (cash counted once); a voided invoice drops
  out; pre-window activity nets into the opening balance while post-window activity is ignored; and an
  account with no history returns a single opening row at nil.
- **Three-way match — 5**: a bill equal to the received value reconciles to a nil variance and reads
  *matched*; a bill above it is flagged *over-billed* with the positive variance (the one to catch before
  paying); a bill short of it reads *under-billed* with the shortfall; goods received with nothing yet
  charged read *unbilled*; and the match is taken net of PPN, so a 55.50 bill carrying 5.50 tax ties out
  cleanly against 50.00 of received goods rather than crying a variance.
- **Faktur list — 6**: each taxed invoice becomes one output line and each bill one input line, carrying
  the counterparty, base and PPN; the output lines sum back to the report's output tax, taxable sales and
  invoice count, and the input lines to their counterparts, so the list decomposes the summary exactly; an
  exempt sale appears as a zero-PPN line while a voided invoice is excluded; only documents inside the
  window are listed; output faktur are ordered ahead of input; and each party's NPWP is carried onto its
  line (and left null when not on file).
- **Statement emails — 5**: a send records the period, the trimmed recipient and the real caller as
  `sent_by`; repeat sends accumulate as an append-only trail; a non-admin caller is refused and records
  nothing; a blank recipient and an unknown customer are rejected; and a direct table insert is denied
  even to an admin, so the DEFINER function is the only door.
- **Billing exceptions — 4**: the worklist lists only over- and under-billed orders, largest gap first;
  a matched order and an unbilled one are both excluded (neither needs attention); it filters to a single
  supplier when asked; and each row's variance and status agree with what the register reports for the
  same order, since the worklist reads the register rather than recomputing.
- **Supplier ledger — 4**: a running account opens with the prior balance and carries it down bills and
  payments to the balance owed; a voided bill drops out; pre-window bills net into the opening balance
  while post-window ones are ignored; and an account with no history returns a single opening row at nil.
- **Email history — 3**: document and statement sends fold into one log with the right shape per kind
  (a document carries its number and doc-kind, a statement its period), ordered most recent first across
  both trails, and empty when nothing has been sent.
- **Document emails — 5**: a send is recorded with the trimmed recipient and the real caller's
  `auth.uid()` as `sent_by`; repeated sends accumulate as separate append-only rows; a non-admin caller
  is refused with nothing recorded; a blank recipient and a missing issued document are rejected; and a
  direct table write is denied even to an admin — the DEFINER function is the only door.
- **Mail transport — 8**: `mailEnv` requires host + From, defaults to 587/STARTTLS, infers implicit TLS
  on 465 with an explicit `SMTP_SECURE` override, rejects unusable ports, and treats credentials as a
  pair; `sendMail` reports unconfigured cleanly, **delivers through a real loopback SMTP server** with
  the headers and the rendered PDF attachment verified intact, and returns a clean failure (no throw)
  when the relay is unreachable.
- **Email drafts — 3**: the default subject and body carry the kind label, document number, and brand;
  a missing or blank customer name degrades to a neutral greeting; every issued kind is labelled and an
  unknown kind reads "Document".
- **Document schemas — 6**: `issueDocumentSchema` pairs each kind with its required id and rejects an
  unknown kind; `emailDocumentSchema` trims every field, rejects malformed or blank recipients and
  whitespace-only subject/message, and enforces the 320 / 200 / 4,000-character bounds.
- **Payment schemas — 8**: `recordPaymentSchema` accepts a well-formed payment and defaults
  method/reference to empty strings, trims and carries them through, and rejects non-positive or
  more-than-2-dp amounts, a malformed date, a non-numeric or infinite amount, and an over-length method
  or reference; `voidDocumentSchema` accepts and trims a reason and requires a non-empty one within the
  length limit.
- **Shipment — 6**: a FEFO issue across two finished lots freezes realized COGS exactly (cross-batch,
  not averaged) and flips to `shipped`; a partial shipment ships available stock and backorders the
  rest (`partially_shipped`); a backordered order completes across dispatches with COGS accumulating;
  an unconfirmed order is refused; an order with no available stock raises; quarantined lots are never
  drawn.
- **Deliberate shipment — 4**: exact per-line quantities ship and complete across dispatches with COGS
  accumulating and available stock surfaced; a request beyond a line's outstanding is rejected; a
  request beyond stock rolls back; zero-quantity lines are skipped and an all-zero request is rejected.
- **Returns / credit notes — 4**: a return re-enters goods as a new available lot at the blended
  realized cost, reverses that COGS off the line, and raises a credit note; a return beyond what's still
  out with the customer is rejected and rolls back; multiple returns accumulate and stay bounded by the
  remaining net-out; a return against a `partially_shipped` order leaves the fulfilment status unchanged.
- **Costing depth — 8**: completion adds labor (hours × rate) and overhead (rate × prime cost) to the
  frozen unit cost; overhead applies to material + labor, not material alone; zero rates keep cost
  material-only whatever the labor hours; negative labor hours are rejected; the loaded unit cost flows
  through to a shipment's realized COGS; a per-product override replaces the plant-wide rate; an override
  with a null field inherits that rate per-field; and a product with no override falls back entirely.
- **Costing schema — 5**: `productCostingRateSchema` coerces both rates, treats a blank field as null
  (inherit) rather than zero, accepts an explicit null, rejects an all-inherit override (that is a
  removal, not a save), and rejects a negative rate or a malformed product id.
- **Sales schemas — 9**: `customerCreateSchema` (code/name required, empty contact fields dropped,
  email validated) and `createSalesOrderSchema` (uuid + line validation, `unitPrice` default, ≥1 line).
- **Contract — 1**: SQL `convert_qty` ≡ TS `convert`.

## Verified vs. needs-your-environment

Verified against live PostgreSQL: schema, all functions (incl. genealogy traversal, `public_metrics()`,
and the **costing roll-up** — completion freezes per-consumption cost and the finished lot's
`unit_cost`, `production_order_cost()` returns the frozen breakdown, and `dashboard_metrics` values
finished + unit-converted raw, all checked against exact expected figures), RLS, the domain engine,
and the offline outbox logic. **The anon safety of the
public dashboard was checked directly**: `public_metrics()` is callable as the `anon` role and
returns correct seeded aggregates, while `anon` is denied direct `SELECT` on sensitive tables
(e.g. `formula_components`). The app **compiles for production** (`yarn build` clean, 116 routes incl.
middleware) and is fully typed — both `yarn typecheck` (app) and `yarn typecheck:e2e` (Cypress specs)
are clean, and the **294-test** suite passes against a freshly migrated database.

**Not runnable in this sandbox:** the Cypress *binary* download is network-blocked here, so the
specs are written and type-checked but were not executed in-house — run them on your machine with
the commands above. Likewise the live **sign-in / logout, role-gated routing, in-browser offline
behaviour, and the UI** need a real Supabase project + a browser/deploy to exercise; the Supabase
endpoint is unreachable from this sandbox, so those paths are verified by build + type + server-side
logic rather than a live round-trip. **Document emailing** sits between the two: the SMTP
conversation, headers, and PDF attachment are exercised end-to-end in the suite against a local
`smtp-server`, so only your production relay — DNS, TLS, provider authentication, deliverability —
remains to be smoke-tested with real `SMTP_*` credentials.

## Type generation

`src/types/database.ts` is generated from the schema, not hand-written. After any migration that
changes tables, enums, or functions, regenerate it:

```bash
# Against a local Postgres holding the migrated schema:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/erp_dev yarn gen:types

# Or, for your live project, the canonical Supabase CLI path (emits FK Relationships too):
supabase gen types typescript --linked --schema public > src/types/database.ts
```

`yarn gen:types` runs `scripts/gen-types.mjs`, a small pg-introspection generator that emits the same
`Database` shape the Supabase CLI does — Tables/Functions/Enums plus FK `Relationships` (read from
`pg_constraint`), so nested PostgREST embeds type statically. It exists because the CLI's `gen types`
delegates to a containerized `postgres-meta`, which isn't available in every environment. The Supabase
CLI remains the canonical source for your live project (and resolves edge cases like multi-schema
references); the local generator keeps the committed types in sync with migrations in between.

## Roadmap

Done: domain core · integrity functions · RBAC + RLS · API · auth + middleware · module console ·
PWA shell · offline reads + write outbox · genealogy drill-down · production wizard ·
responsive redesign (light/dark themes) · Cypress E2E + component tests ·
Supabase-JWT login/logout · clearance-aware `/app` + `/admin` routing · public aggregates dashboard ·
admin CRUD for materials / products / warehouses · admin user management ·
animated operations dashboard · privilege lockdown on DB functions ·
a ledger-consistent demo seed that gives every dashboard real shape ·
**versioned formula editor with one-way locking** ·
**login-account create / delete with SQL-guarded deletion** ·
**email invitations with a self-service `/accept-invite` page** ·
**typed database layer (generated `Database` type with FK relationships, `SupabaseClient<Database>` throughout)** ·
**production order costing (frozen material-cost roll-up, finished-goods valuation, cost breakdown page)** ·
**distribution 2a (customers, sales orders with priced lines, atomic create, expected-margin preview)** ·
**distribution 2b (FEFO shipment on a new `'shipment'` ledger type, realized COGS frozen per line, realized margin)** ·
**partial / multi-shipment (ship-available with backorder, `partially_shipped` status, COGS accruing across dispatches)** ·
**deliberate per-line split shipment (admin-entered quantity per line, available-stock caps, shared FEFO/COGS primitive)** ·
**returns / credit notes (restock at blended cost on a new `'return'` ledger type, COGS reversal, credit-note documents, net realized figures)** ·
**costing depth (fully-loaded finished-goods cost = material + labor + overhead, standard rates in a costing-settings singleton with admin editor, completion UI, loaded COGS flowing through to realized margin)** ·
**SJPH halal compliance (per-material halal status + certificate, formula-version verdict derived from components and date-aware, offending inputs surfaced, admin-gated overview)** ·
**per-product costing rates (optional per-field labor/overhead override resolving product → plant-wide → 0 through one `effective_costing_rates` function, admin add/edit/remove editor)** ·
**hard halal gate at production (completion blocked when the formula version isn't halal-compliant as of the completion date, offending materials named, checked before any stock moves)** ·
**halal verdict surfaced on the production order (compliant badge or offending materials with reasons, Complete disabled when non-compliant, reusing the v0.22 verdict)** ·
**printable documents (invoice / packing slip / credit note built by `*_document(id)` JSON functions, rendered as chrome-free `/print` sheets and printed from the browser, admin-gated, no cost exposed)** ·
**halal verdict in the creation wizard + a logged admin override (non-compliant recipe flagged at batch preview before the order exists; an admin-only, reason-required override of the completion gate recorded in `production_halal_overrides` with an offending-input snapshot, the admin check running inside the `SECURITY DEFINER` function)** ·
**server-side PDF documents (each document route also serves `?format=pdf`, streaming an `application/pdf` rendered with pdf-lib from one generic composer over a per-document spec; same admin gate and RLS-governed builders, with a Download PDF action beside Print)** ·
**TechnicoFlor brand + real app icons (green leaf mark and wordmark across nav, auth screens, print sheets, and PDFs; 192/512 maskable PWA icons, a favicon, and a mark-embedded PDF letterhead)** ·
**issued-document archive (`issue_document()` freezes an invoice / packing slip / credit note as an immutable `issued_documents` record reusing the `*_document()` builders, admin-gated in-function with RLS select-only; downloads re-render from the frozen snapshot, and the sales order page issues and lists them)** ·
**document emailing (an issued document emailed to the customer with its frozen-snapshot PDF attached, over provider-agnostic SMTP with graceful degradation when unconfigured; every send recorded append-only in `document_emails` through an admin-gated DEFINER function — send-first, record-second — surfaced per document with a prefilled compose form, the SMTP round-trip loopback-verified in the suite)** ·
**numbered document sequences (a dedicated year-scoped series per issued kind — `INV-/PS-/CN-YYYY-NNNNN` — assigned at filing from a row-locked, transactional counter that is gapless on rollback and serialized under concurrency, written into `document_number` and the frozen snapshot with the replaced codes preserved and echoed on the PDF; counter and helper owner-only)** ·
**payments against issued invoices (each issued invoice a collectible claim frozen at `round(total, 2)`; payments recorded under the invoice's `FOR UPDATE` row lock and never past the open balance, corrected by explicit deletion; open / paid / status derived once in `invoice_receivables()` for both the order page and a new admin-only **Receivables** register; any mis-issued document **voided on the record** with a reason — refused while payments remain — rendering struck-through with a `VOID` PDF watermark and no longer emailable)** ·
**admin navigation as a responsive sidebar (a vertical, active-highlighted section list on desktop and a collapsible `Admin · {section}` bar on mobile, with the clearance gate kept server-side)** ·
**documents register (one admin screen over the whole issued archive — every invoice, packing slip, and credit note with its order, customer, send summary, and, for invoices, reused receivable status — derived once in `issued_documents_register()` that left-joins `invoice_receivables()` so it can't disagree with an order's page; read-only and SECURITY DEFINER granted to authenticated with the route gating admin, and the sequence-counter lockdown hardened to survive re-migration)** ·
**receivables aging & statements (every open invoice aged from its issue date into current / 31–60 / 61–90 / 90+ buckets by `receivables_aging(as_of)`, which reuses `invoice_receivables()` so it can't disagree with the register; an admin aging report of per-customer bucket totals drilling into each customer's statement of open invoices, read-only and SECURITY DEFINER granted to authenticated with the route gating admin)** ·
**credit-note allocation (a credit note applied against one or more of the same customer's open invoices, reducing their balances without cash; the credit note carries `allocated` / `remaining` and an invoice's open balance becomes `total − paid − allocated` — the change landing in `invoice_receivables()`, the single derivation, so the register, documents register, and aging all net credits automatically and backward-compatibly by column name; `allocate_credit_note()` guards under a stable-ordered dual row lock — same customer, neither voided, never past the note's remaining or the invoice's open — and `delete_credit_allocation()` reopens both balances, behind an invoice-centric Apply-credit UI)** ·
**due-date aging (customer payment terms in net days, editable from the admin; a due date computed at issuance as issue date + terms and frozen into the invoice snapshot; aging re-bucketed by that due date into Current / 1–30 / 31–60 / 61–90 / 90+ days past due — the standard five-bucket AR view replacing the four issue-date buckets — with the anchor moved in one place while `invoice_receivables()` gains `due_date` and an `overdue` flag so the register and order page mark late invoices; legacy invoices with no due date fall back to their issue date, and the invoice PDF and print sheet show the due date)** ·
**statement & register export (a per-customer statement of account — the customer's open invoices aged, the five-bucket summary, and the total outstanding — rendered as a sendable PDF from `receivables_aging()` filtered to one customer, so it can't disagree with the aging report, and composed through the same PDF pipeline as the other documents; plus a CSV export of the currently filtered documents register, serialised client-side through a small RFC-4180 writer with a UTF-8 BOM so what you see is what accounting gets)** ·
**payables — the AP mirror (suppliers mirroring customers, bills mirroring invoices, bill payments mirroring invoice payments; `bill_payables()` the single AP derivation reused by the payables register and `payables_aging()` exactly as `invoice_receivables()` is on the other side, with the same five due-date buckets; an AP workbench to enter bills and record or reverse payments, and a payables aging report — so money owed out is tracked with the same rigour as money owed in)** ·
**tax & pricing (invoices carrying PPN and per-customer pricing — a `tax_settings` singleton for the house rate, a per-customer discount and a tax-exempt flag, composed as subtotal → discount → taxable → PPN → total and frozen into the snapshot at issue exactly like line prices and due dates, so the tax-inclusive total flows into `issued_documents.total` and receivables carry the tax with nothing downstream to change; the invoice PDF and print view show the full breakdown)** ·
**cash application (one customer receipt clearing several invoices at once — a `customer_receipts` lump whose applications ARE invoice_payments tagged with the receipt, so the receivables register, aging and statements count them with nothing changed; each allocation validated against an invoice's true open balance, the unapplied remainder held on account and drawn down later, and a Receipts screen with an auto-apply oldest-first pass; deleting an application reopens its invoice and deleting a receipt cascades every application away)** ·
**procurement (purchase orders that receive into inventory and feed bills — raw-material lines with a quantity and unit cost; receiving each delivery as a raw lot through the same `_create_lot` primitive production uses, with a `'receipt'` movement so purchased stock enters FEFO and is immediately consumable; partial-receipt aware with per-line progress and its own open → partially received → received status; billing a PO reuses `create_bill` and stamps `bills.purchase_order_id`, defaulting to the received value, so money owed out traces back to the order; a register rolls up ordered/received/billed value and a Procurement screen raises, receives and bills)** ·
**tax reporting (output-vs-input PPN netted over a period — output tax read from the frozen `taxAmount` on each issued invoice's snapshot so it can't drift from what was billed, input tax captured on a new `bills.tax_amount` threaded through `create_bill`/`bill_purchase_order` and enterable on both bill forms; `tax_report(start, end)` sums each side over a date window, output by issue date and input by bill date, and nets to a PPN payable or a carried credit; credit notes stay untaxed, exempt sales sit in the base at zero tax, and pre-tax invoices are excluded; a Tax report screen with period presets breaks each side down to its base and count)** ·
**customer statements as a running account (the balance-forward counterpart to the aged statement — one dated ledger per customer that opens with a brought-forward balance, then carries a running balance down each in-window transaction; invoices raise it, credit notes / cash receipts / direct payments lower it; a receipt is counted in full and its internal applications left out so cash counts once, which means on-account credit nets against what's owed and the balance due can read below the aged sum; `customer_ledger(customer, start, end)` unions the four sources and nets everything before the window into the opening balance; a Statement of Account PDF and a Customer statement screen with period presets render and send it)** ·
**three-way match on procurement (the supplier's bill reconciled against the goods actually received, valued at the order's own prices — `received_value` is Σ received-qty × unit-cost, `billed_net` is Σ (bill amount − PPN) over the order's non-voided bills, and the variance between them reads as a match status: matched to the cent, over-billed when the bill runs ahead of receipt, under-billed when it falls short, unbilled when goods are in but nothing's charged; the comparison is net of tax so a 55.50 bill with 5.50 PPN ties out against 50.00 received; `purchase_order_register` carries the net billed, variance and status, so every PO shows a match badge next to its billed figure — no new tables, no new endpoints, a read over what's already recorded)** ·
**PPN filing export (the Faktur Pajak line list behind the tax report — `tax_report_lines(start, end)` lists every taxed sales invoice and purchase bill in the period under the same filters as the summary, so the output lines reconcile to output tax / taxable sales / invoice count and the input lines to their counterparts, a faithful decomposition rather than a recount; each row carries the document, date, counterparty, base and PPN, with zero-rated lines shown at 0 so the counts tie; the Tax report screen gains a Faktur detail section — two totalled tables, output and input — with a CSV export ready to reconcile or re-key)** ·
**statement delivery (emailing a customer their running-account statement in one click — the Customer statement screen gains an Email button that renders the period's PDF and sends it through the same mail transport that sends issued documents, with a prefilled, editable composer; a `statement_emails` row is written only after the relay accepts, through an admin-gated DEFINER function that is the table's only writer, so send history is trustworthy and `sent_by` is the real caller; the screen shows when it was last emailed and to whom, and disables the action with a reason when SMTP isn't set)** ·
**a match-exceptions worklist (the three-way match's over- and under-billed flags surfaced where bills are paid — `purchase_order_exceptions(supplier?)` filters the register down to just the orders billed out of line with the goods received, largest gap first, dropping the matched and unbilled ones; the payables screen leads with a Billing exceptions banner naming each flagged order, its variance and billed-vs-received, with a link into procurement, and the procurement list gains a one-tap exceptions filter; it reads the register, so it never disagrees with the badge)** ·
**supplier statements as a running account (the customer ledger mirrored for money owed out — `supplier_ledger(supplier, start, end)` folds a supplier's bills and payments into one dated ledger, a bill raising what we owe and a payment lowering it, opening with a brought-forward balance and carrying a running balance to what's outstanding; a Supplier statement screen with period presets and a printable PDF reusing the customer-statement rendering)** ·
**NPWP on customers and suppliers (each counterparty's Indonesian tax ID captured on the party record and surfaced in the admin editor, carried onto the Faktur Pajak export through a new `party_tax_id` on `tax_report_lines` and shown in both the on-screen faktur tables and the CSV, turning the reconciliation-grade line list into something close to an e-Faktur import)** ·
**a unified send-history log (the document and statement email trails surfaced as one chronological, searchable Email history screen — `email_history()` unions them read-only, tagging each send by kind and carrying the counterparty, recipient, subject and a reference, so the audit rows the DEFINER recorders write become something an admin can read)**.

The six-slice product build is complete; master-data authoring includes the versioned BOM, admins
manage login accounts end to end, finished goods are costed, and the distribution loop now runs a full
round trip — capture, confirmation, full / partial / deliberately-split FEFO shipment with backorder,
realized margin on what has shipped, and returns that restock inventory and credit the customer. With
costing depth in, that realized margin is now **fully loaded** — material, labor, and overhead — end to
end, and **SJPH halal compliance** now derives each formula version's verdict from its materials — with
labor and overhead now settable **per product** where a line carries its own rate, and the halal
verdict is now a **hard production gate** rather than a review-only surface — flagged in the new-order
wizard before an order exists and overridable only by an admin, with a reason, on the record — and the
sales and returns data now prints as **invoices, packing slips, and credit notes**, on screen or as
**server-rendered PDFs**, under the **TechnicoFlor** brand, each **issued** as an immutable record
under its **own gapless document number** and **emailed to the customer** with that frozen PDF
attached, every send on the record — and each issued invoice is now a **collectible claim**: payments
recorded against it under a row lock, its open balance and the whole book of receivables derived on
read, with any mis-issued document **voided on the record** rather than deleted — and the whole issued
archive is now browsable from one admin **documents register** that reuses that same receivable
derivation, and what's owed is now readable **by age** — an aging report bucketing every open invoice
and drilling into each customer's statement, a credit note can be applied against an open invoice, and
aging buckets by due date to surface what is overdue, and a customer statement and register CSV can be
exported, payables mirror it for money owed out, invoices carry PPN and per-customer pricing, and a
customer receipt clears several invoices at once, purchase orders receive into inventory and feed
bills, PPN nets to the tax owed over a period, a customer statement carries a running balance down
to what's due, a supplier bill is three-way matched against the goods received before it's paid,
the tax report breaks out to a per-document Faktur Pajak list ready to file, a customer's statement
can be emailed to them in one click, the orders billed out of line with what was received surface
as a worklist on the screen where bills are paid, a supplier's account reads as a running statement the
way a customer's does, each party carries its NPWP onto the Faktur Pajak export, and every recorded
email is searchable in one place.

That completes the roadmap this project was built against. The horizons beyond it are larger, optional
builds rather than near-term items — the pieces that would take it from a strong operational core toward
a full-suite ERP:
1. **A General Ledger / accounting close** — a chart of accounts, journal entries, trial balance, and
   the P&L / balance sheet, so the operational subledgers (AR, AP, inventory) roll up into financial
   statements rather than being reconciled in dedicated accounting software alongside.
2. **Planning & procurement workflow** — MRP / demand planning and production scheduling, plus a
   purchase-requisition → approval → PO flow, so what to make and buy is planned and authorised rather
   than entered directly.
3. **Integrations & access depth** — e-Faktur / Coretax and bank-reconciliation feeds, granular
   role-based access beyond admin/viewer, and ad-hoc reporting, so the system reaches the outside world
   and fits larger teams.
