# Atelier — Perfume ERP (Manufacturing Core) · v0.19.0

A ground-up rebuild of the **ERP Perfume: Manufacturing & Distribution System** for TFI,
on Next.js 14 + Supabase (PostgreSQL), shipped as an offline-capable PWA. Package manager: **Yarn**.

Build philosophy: the riskiest part of a manufacturing ERP is the integrity of the numbers, not
the screens. The data model and its invariants were verified against live PostgreSQL first; the
security layer, API, UI, offline support, and now a redesigned responsive front-end were
layered on a core that cannot silently corrupt stock or leak trade secrets.

## What's new in v0.19.0 — deliberate per-line split quantities

Shipping gains a deliberate mode beside the one-click greedy one. **Ship available** still dispatches
everything stock allows in one go; **Ship specific…** opens a per-line form where an admin enters
exactly how much of each outstanding line to send now — for allocating scarce finished stock across
competing orders. `ship_sales_order_lines(order, [{line, qty}])` issues each requested amount FEFO and
freezes COGS just like the greedy path; in fact both now run over one shared primitive
(`_ship_order_line`), so FEFO, COGS accrual, and the `shipped`/`partially_shipped` status recompute are
defined once. A deliberate request beyond a line's outstanding quantity, or beyond the stock actually on
hand, raises and rolls back — a split never silently ships less than asked (the greedy path keeps its
ship-what-you-can behaviour). The order detail now surfaces **available finished stock per line** (sum
of available, in-unit lots in the order's warehouse), so each input is capped at `min(outstanding,
available)`; cancel stays guarded to pre-shipment states.

## What's new in v0.18.0 — partial / multi-shipment

`ship_sales_order` goes from all-or-nothing to **ship what's available now**, callable repeatedly.
Each dispatch issues `min(outstanding, on-hand)` per line FEFO, **accumulates** `shipped_quantity` and
`cogs` onto the line, and lands the order on `shipped` once every line is fully dispatched or the new
`partially_shipped` status while any remainder is on backorder. Restock and click **Ship available**
again; the next dispatch picks up the outstanding quantity and COGS keeps accruing — a sale split
across two production batches at different costs ends with the exact blended COGS, not an average. The
`stock_movements` ledger (already keyed by `sales_order`) is the per-dispatch history; no separate
shipments table.

This deliberately **replaces the v0.17.0 behaviour where short stock raised and rolled back** — a
shortfall now ships what it can and backorders the rest. The one case that still raises is when
*nothing* across the order can ship, so a click never silently no-ops. Realized figures now describe
the dispatched portion: the detail page shows **shipped revenue / realized COGS / realized margin**
(which tie out against each other) plus an ordered-vs-shipped line breakdown, so margin-on-shipped-so-
far is honest mid-fulfillment. Cancel is now guarded to draft/confirmed only — once stock has left,
unwinding it is a returns flow, enforced by a transition check, not just hidden in the UI.

## What's new in v0.17.0 — distribution (2b): shipment + realized COGS

The fulfillment half. A confirmed sales order can now be **shipped**: `ship_sales_order` issues each
line's finished lots **FEFO** out of the order's warehouse via `post_movement`, freezes the realized
**COGS** onto the line (`shipped_quantity` + `cogs`), and flips the order to `shipped` — atomically,
so a shortfall on any line rolls the whole shipment back with nothing issued. It mirrors
`complete_production_order`: production consumes raw lots and freezes material cost; shipment issues
finished lots and freezes COGS, and **realized margin = revenue − COGS** then replaces the 2a estimate
on the same order detail (the line table and the stat cards switch from expected to realized once
shipped).

Two invariants come for free from the reuse. The new movement is a first-class `'shipment'` type on
the ledger (distinct from production `'issue'`s), and because issuing routes through `post_movement`,
its `available`-only guard means a shipment **cannot draw quarantined or QC-failed stock** — only
QC-released finished goods leave. COGS is summed from each issued lot's own frozen `unit_cost`, so a
sale drawing across two batches at different costs is exact, not averaged.

`ship_sales_order` is SECURITY INVOKER: the admin-write RLS on the order tables is the gate (a
non-admin's line update fails and rolls the shipment back), while the ledger itself is written by the
SECURITY DEFINER `post_movement`; the API route also requires admin. Four integration tests cover the
FEFO issue with COGS freeze, the confirmed-only guard, the insufficient-stock rollback, and the proof
that quarantined lots are never drawn.

## What's new in v0.16.1 — shared number formatting (internal)

The 2-decimal money formatter that the production and sales detail screens were each defining locally
is now a single helper — `src/lib/format.ts` (`money({ decimals })` + `moneyOrDash`) — imported by
both. The sales list and detail screens also shared an identical `sales_order_status → badge class`
map; that moves to `app/app/sales/status.ts`. No behaviour change: the dashboard's distinct rounded,
zero-decimal stat/chart formatter stays in `charts.tsx`, and the inventory/production status-badge
maps (a different, domain-specific shape) are deliberately left alone — a generic `StatusBadge` to
fold those in is the natural next cleanup. Build, types, and the 82-test suite stay green.

## What's new in v0.16.0 — distribution (2a): customers + sales orders

The capture half of distribution. There's a new **customers** master-data screen (admin CRUD, the
same config-driven manager as materials/products/warehouses) and a **Sales** module at `/app/sales`
where an order is recorded against a customer and a fulfilling warehouse with any number of priced
lines. Creation goes through a single `create_sales_order(code, customer, warehouse, date, lines jsonb)`
function that inserts the header and all lines in **one transaction** — if any line is invalid the
whole order rolls back, closing the orphaned-header gap the production-order create still has.

Each line previews an **expected margin** without moving any stock. `product_available_cost` returns
the weighted-average `unit_cost` of a product's *available* finished lots, and
`sales_order_lines_costed(order_id)` joins that onto each line to show estimated unit cost, line
revenue, and `(price − est. cost) × qty`. Where a product has no costed finished stock on hand the
estimate — and the margin — read `—` rather than a misleading zero; the order detail page rolls the
lines up into revenue, expected COGS, and expected margin, and an admin can confirm or cancel from
there. The estimate assumes the sale unit matches the product's base unit; the **exact** figure
arrives in 2b, when shipment issues specific finished lots FEFO and freezes realized COGS from each.

Writes (customers, orders, status) are admin-gated for v1 — no dedicated `sales` role yet — while
reads are open to any authenticated user, mirroring the master-data policy. Four integration tests
cover the atomic create, the weighted-average estimate and per-line margin, the null-margin case, and
the rollback; a nine-test schema suite covers the customer and order payloads.

## What's new in v0.15.0 — production order costing

The first slice of the distribution/costing area, and the architectural prerequisite for sales
margins: finished goods now carry a **cost**. Until now `products` had no cost column and the
dashboard's inventory value was explicitly raw-only, so a completed batch produced an *unvalued*
finished lot. Completion now rolls up the actual material cost from the consumptions and **freezes**
it.

The freeze is deliberate (snapshot, not live): when `complete_production_order` consumes each raw lot
it computes that line's cost — `convert_qty(taken → material base unit) × standard_cost` — and writes
it onto the `production_consumptions` row, accumulating the total and stamping the finished lot's
`unit_cost` (total ÷ output quantity). Because the per-consumption cost is stored, a later edit to a
material's `standard_cost` does **not** retroactively rewrite the cost of a batch already made — the
historical number stays put. The cost is rolled up with proper unit conversion, so a component issued
in grams against a material priced per kilo costs correctly.

Two read surfaces expose it: `production_order_cost(po_id)` returns the per-material breakdown (frozen
costs), surfaced on a new **production order detail page** (`/app/production/[id]`, linked from the
order list) showing total material cost, unit cost, and the cost-by-material table. And
`dashboard_metrics` now splits inventory value into **raw** and **finished** — the raw line is also
made unit-correct (it converts each lot to the material's base unit before pricing, which the old
direct-multiply valuation didn't). Three integration tests cover the roll-up with conversion, the
snapshot freeze, and the dashboard valuation.

## What's new in v0.14.2 — validated RPC boundary

The two JSON-returning RPCs (`public_metrics`, `dashboard_metrics`) were the last place the server
*asserted* a shape (`data as unknown as …`) and then coerced with a permissive `num()` helper — so a
drifted payload would silently surface as `NaN`s on a dashboard. They're now **parsed** with Zod
schemas (`src/server/metrics-schemas.ts`): a mismatch is logged loudly and the page falls back to its
empty state instead of rendering garbage. The `num()`/`toNumberMap()` helpers and the assertion casts
are gone; the schemas drop straight onto the typed `Json` the RPCs already return.

Both RPCs build their payload from `count(*)` and `round(numeric, 4)`, which Postgres renders as JSON
numbers — verified by running the live RPC output back through the schemas — so the schemas are strict
(`z.number()`), catching missing or wrong-typed fields rather than masking them. Nine unit tests cover
the accept/reject behavior, including empty-database payloads and additive-key tolerance.

## What's new in v0.14.1 — FK relationships, embed casts dropped

The type generator now emits **`Relationships`** for each table — forward foreign keys read from
`pg_constraint`, in the same format the official Supabase CLI uses (`foreignKeyName`, `columns`,
`isOneToOne`, `referencedRelation`, `referencedColumns`). With those in place, PostgREST nested embeds
type statically, so the `formulas.ts` and `production.ts` embed mappings dropped their casts:

- **`listFormulas`** (2-level embed) and **`previewProductionOrder`** (3-level) are now fully typed —
  no casts; `f.products`, `f.formula_versions`, `version.formula_components` etc. carry real types.
- **`getFormulaDetail`** has a 4-level embed (`formulas → versions → components → raw_materials`),
  which exceeds supabase-js's select-string inference (it returns `GenericStringError` at that depth —
  a client limitation, not a schema one). That one query keeps a *single* documented shape-assertion
  and then maps with full typing — replacing the ~18 scattered per-field casts it had before.

Net: the nested-embed casts across the server dropped from ~20 to one documented boundary. What
remains elsewhere is deliberate — generic CRUD over dynamic tables, precision-preserving
decimal-string inserts, and `Json`→shape parsing.

## What's new in v0.14.0 — typed database layer

The Supabase client is now generic over a generated `Database` type, so `.from()` queries and
`.rpc()` calls are checked against the real schema — table columns, enum values, function args, and
return shapes. Threading it through immediately caught real issues (a production insert sending the
wrong type into a numeric column; an inventory filter accepting any string where the `lot_status`
enum was required), now fixed.

- **`src/types/database.ts`** — the generated `Database` type (Tables `Row`/`Insert`/`Update`,
  `Functions` args/returns, `Enums`). Produced by **`scripts/gen-types.mjs`** (a Postgres-introspection
  generator) via **`yarn gen:types`** — see *Type generation* below.
- **Typed clients** — `createServerClient<Database>`, `createBrowserClient<Database>`, and the
  service-role `createClient<Database>` all return `SupabaseClient<Database>` (aliased `DbClient`),
  threaded through `apiAuth` and the RPC-based server modules.
- **`ServerResult<T>`** — the four identical result types (`UserResult`, `AccountResult`, `FxResult`,
  `CrudResult`) now alias one shape in `pg-error.ts`, built on `HttpError`. Names kept for
  back-compat; `ActionResult` (no `status`) stays separate by design.
- **Casts** — the ones the typed client obviates are gone (e.g. the `admin_list_users` and
  `admin_check_user_deletable` results). What remains is deliberate: generic CRUD over dynamic table
  names (untyped by design), precision-preserving decimal-string inserts, `Json`→shape parsing, and
  nested PostgREST embeds — those last need FK *Relationships* metadata, which the local generator
  emits empty (`[]`); the official CLI populates them, which is what would let the `formulas.ts`
  embed casts drop.

**Dependency bump:** `@supabase/ssr` 0.5.2 → 0.12.0, required so its `SupabaseClient` generic arity
matches the installed `@supabase/supabase-js` (the older pairing produced a type skew). The cookie
API used by `server.ts`/`middleware.ts` is unchanged and the build is green, but auth/cookie
behavior is only fully verifiable against a live Supabase project — worth a smoke-test on deploy.

## What's new in v0.13.0 — email invitations

Account provisioning now offers a second path: instead of setting a temporary password for the new
user, an admin can **send an email invitation** and let the user choose their own password. The
Users screen's create form has a *Temporary password* / *Email invitation* toggle.

- **Send side.** `POST /api/admin/users` gains a `mode: 'invite'` branch (the default is unchanged,
  so the temp-password path is untouched). It calls `inviteAccount` →
  `auth.admin.inviteUserByEmail`, then assigns the initial role exactly as the password path does —
  the shared `assignInitialRole` helper now backs both. The redirect target is
  `<origin>/accept-invite`, derived from the request or `NEXT_PUBLIC_SITE_URL`.
- **Accept side.** A new `/accept-invite` page receives the invitee after they follow the link: the
  browser client establishes the session from the link, the user sets a password
  (`auth.updateUser`), and they're sent into the console. Invalid or expired links get a clear
  message.
- **Validation.** `inviteUserSchema` (email + role, no password) sits alongside `createUserSchema`,
  both covered by a new **9-test** schema suite.

Two requirements for invitations specifically: **SMTP must be configured** on your Supabase project
(the temp-password path needs no email), and **`<origin>/accept-invite` must be added to the
project's allowed redirect URLs** (Auth → URL Configuration). Because the email send → link click →
token → password set round-trip is Supabase- and browser-side, it's the least sandbox-verifiable
part of the build: the schema, routing, role assignment, types, and production build are verified
here; the live invitation flow needs your project to exercise end to end.

## What's new in v0.12.1 — shared server-error mapper (internal)

Housekeeping, no behaviour change. The three admin-RPC modules (`users`, `account-lifecycle`,
`formulas`) each carried their own copy of the Postgres-error → HTTP status mapping. The shared
*status-code contract* — `42501`→403, `P0002`→404, `P0001`→409, anything else→500 — now lives once in
`src/server/pg-error.ts` (`mapRpcError`), with each module supplying its own curated messages so the
wording stays domain-specific. The next admin RPC inherits consistent statuses for free, and the
contract is locked by a new **5-test** unit suite. (The constraint-focused mapper in `crud.ts` is
intentionally left separate — it maps table constraints like unique / FK / not-null, not the
raised-error contract.)

## What's new in v0.12.0 — account lifecycle

Admins can now **create and delete login accounts** from the Users screen. Previously only an
existing user's *role* could be changed; minting or removing the underlying `auth.users` account
meant a trip to the Supabase dashboard.

- **Service-role client, tightly contained.** Creating or deleting an auth user needs Supabase's
  Admin API and the **service-role key** (which bypasses RLS), so it lives in one server-only module
  (`src/lib/supabase/admin.ts`): read from `SUPABASE_SERVICE_ROLE_KEY` (no `NEXT_PUBLIC_` prefix, so
  Next never bundles it for the browser), constructed *per request, only after* `apiAuth('admin')`
  has already cleared the caller, with a `window` guard as a backstop. It is the second line of
  defense, never the first.
- **Create** (`POST /api/admin/users`) — email + temporary password + initial role, validated with
  Zod (8–72-char password, matching bcrypt's limit). A non-`viewer` role is written to `app_users`;
  `viewer` is the default and leaves no override row.
- **Delete** (`DELETE /api/admin/users/[id]/account`) — kept distinct from the existing
  `DELETE /api/admin/users/[id]`, which only removes a role override. The destructive guards live in
  audited SQL (`admin_check_user_deletable`, migration `0010`), run in the caller's own context so
  they can enforce **you can't delete yourself** and **you can't delete the last admin**; only then
  does the service-role client remove the auth user, followed by an explicit `app_users` cleanup
  (there's no FK cascade, and a stray `admin` row would corrupt the last-admin count).
- **Graceful degradation.** With no service-role key set, the screen hides the account controls and
  says so plainly while role management keeps working; the list endpoint reports `canManageAccounts`
  so the UI knows which mode it's in.

Guards are covered by a new **5-test** `account-lifecycle` suite. The one thing this sandbox can't
exercise is the actual `createUser` / `deleteUser` Admin-API round-trip — that needs a live Supabase
project; the SQL guards, types, and production build are verified here.

## What's new in v0.11.1 — shared API client (internal)

Housekeeping, no behaviour change. The identical client-side fetch wrapper (`api<T>()`) and error
narrower (`errMsg()`) that had been copy-pasted into all four console screens — `FormulaList`,
`FormulaEditor`, `ResourceManager`, `UserManager` — now live once in **`src/lib/api-client.ts`**.
A single definition of the `{ data } | { error }` response envelope and the `!res.ok → throw`
convention, so error handling can't drift between screens as new admin pages are added;
`UserManager`'s local `jsonFetch` alias was folded into the shared `api`. Typecheck, production
build, and the full 38-test suite are unchanged and green.



The last piece of master-data authoring, and the richest: you can now **create formulas and build
their versioned recipes** from `/admin/formulas`, with the percent-sum invariant enforced on both
sides of the wire.

- **Versioned BOM authoring.** A formula holds an ordered list of versions; each version is a
  `percent` recipe (components must sum to 100) or a `mass` recipe (absolute amounts). Add a version
  empty or **clone it from any existing version**, edit its components in a table (material, quantity,
  unit), and the editor shows a live **`Σ x / 100 ✓/✗`** readout for percent versions as you type.
- **Locking is one-way and meaningful.** A draft version can be saved at any sum and freely edited;
  **locking** freezes it immutably so a production order can safely reference a recipe that will never
  shift underneath it. The **Save & lock** button only enables when a percent version actually sums
  to 100 with no duplicate or empty components — and the database enforces the same rule, so the UI
  can't be bypassed. Locked versions render read-only with a one-click **"new version from this."**
- **Enforced where it counts — `0009_formula_admin.sql`.** Three SECURITY DEFINER RPCs
  (`admin_create_formula_version`, `admin_save_formula_version`, `admin_delete_formula_version`) do
  the create/clone, the atomic delete-and-reinsert of components, and the guarded delete. They are
  admin-gated, reject editing or deleting a locked version, and raise a check violation if a percent
  lock doesn't sum to 100 or a locked formula has no components — all **verified directly against
  PostgreSQL** (clone, draft-save, lock-rejected-at-90, lock-ok-at-100, edit/delete-locked blocked,
  viewer blocked). Header create/update/delete reuse the generic CRUD layer; every route is
  `apiAuth('admin')` + Zod validated, with RPC errors mapped to honest HTTP status codes.
- **Wired in.** Formulas now appears in the admin nav and the overview grid, and the work is covered
  by a new **5-test** `formula-admin` suite alongside the existing integrity and security tests.

This is the remaining master-data CRUD from the roadmap — deferred to its own step precisely because
a versioned, lockable BOM with a sum invariant is more than a flat table.



`yarn db:seed` now builds a believable end-to-end dataset, so the dashboard and every screen have
something to show — and it does it **through the real ledger**, not by faking rows.

- **Material costs** on all five raw materials (re-applied on every seed via `on conflict do update`),
  which is what lights up the inventory-value charts.
- **A second (R&D) warehouse** with its own stock, alongside the main warehouse.
- **Three completed production runs through `complete_production_order`** — each consumes raw lots
  FEFO and yields a quarantined finished lot — then QC'd via `record_qc`: one **passed** (→ available),
  one left **pending** (→ stays quarantine), one **failed** (→ rejected). Plus a **planned** and an
  **in-progress** order, so the pipeline shows every stage.
- **Idempotent and ledger-consistent.** Stock-moving and order-completing steps run only when their
  row is newly inserted; re-running doesn't double-post or re-consume (verified: on-hand and
  `stock_movements` are identical across runs). The result: inventory across available / quarantine /
  rejected, value split by material category, a 5-order pipeline, and a passed/pending/failed QC mix.

This completes the six-slice build from the product spec (auth → public dashboard → data CRUD →
user management → dynamic dashboard → richer seed).

## What's new in v0.9.0 — dynamic dashboard + a security fix

The signed-in landing (`/app`) is now a live operations dashboard, and a privilege-escalation gap in
the database functions was closed.

- **Animated operations dashboard at `/app`.** Four count-up stat cards (raw inventory value,
  available lots, orders in progress, QC pass rate) over four hand-rolled charts — inventory by
  status (bars), quality control (donut with an animated sweep), inventory value by material (bars),
  and the production pipeline (bars). **No charting library** — plain SVG/CSS, and every animation
  respects `prefers-reduced-motion` (it snaps straight to final values when reduced). Degrades to a
  friendly empty state with no backend, and the value charts fill in once materials have costs (the
  richer seed, next).
- **One authed aggregate function.** `dashboard_metrics()` (SECURITY DEFINER, authenticated only)
  returns counts and totals so the view is identical for every signed-in role; the sensitive detail
  (formula compositions, per-item costs) is never exposed. Verified against Postgres on both a thin
  and an enriched dataset.
- **🔒 Security fix — privileged functions were callable by `anon`.** PostgreSQL grants function
  `EXECUTE` to `PUBLIC` by default, so the SECURITY DEFINER **stock mutators** (`post_movement`,
  `complete_production_order`, `record_qc`), the **genealogy** functions, the **user-admin**
  functions, and the new dashboard aggregate were all reachable by the anonymous role. Migration
  `0008` revokes `PUBLIC` and re-grants to `authenticated` only — verified: `anon` now gets
  `permission denied`, while `public_metrics()` (the public dashboard) stays intentionally open.

## What's new in v0.8.0 — admin user management

Admins can now see everyone who signs in and assign each a clearance level — all from inside the app.

- **A users screen at `/admin/users`** listing every authenticated user with their email, effective
  role, and join date. Change a role inline from a dropdown (admin / production / quality / viewer);
  it saves optimistically and reverts with an inline message if the server rejects it. A "Remove"
  action clears an explicit role and reverts the user to the default (viewer).
- **Reads `auth.users` safely.** Listing users requires the Supabase `auth.users` table, which the
  anon/authenticated client can't touch — so three `SECURITY DEFINER` functions (`admin_list_users`,
  `admin_set_user_role`, `admin_revoke_user`) are the controlled access point. Each is gated on
  `current_app_role() = 'admin'` internally, with `apiAuth('admin')` as the first line and RLS still
  the backstop. **No service-role key in the browser.**
- **Last-admin guard.** You can't demote or remove the last remaining admin (`P0001`), and you can't
  assign a role to a non-existent user (`P0002`) — verified directly against Postgres alongside the
  admin/viewer clearance checks.
- **Still deferred (by design):** creating, inviting, or deleting actual login accounts needs the
  service-role key and belongs in a locked server route — a deliberate later step. This release
  manages clearance for users who already exist.
- **Stays testable locally.** The local auth shim now emulates a minimal `auth.users` table so these
  functions load and run against bare PostgreSQL; on Supabase the real `auth.users` is used and the
  shim is never run.

## What's new in v0.7.0 — role-aware data management (admin CRUD)

Admins can now manage the catalog from inside the app, with clearance enforced at every layer.

- **Full CRUD for the three master-data tables** — raw materials, products, and warehouses — under
  the admin-gated `/admin` area (`/admin/materials`, `/admin/products`, `/admin/warehouses`). Create,
  edit, and delete, each through a generic, config-driven manager (one component, three field/column
  configs) with a responsive table, an inline create/edit panel, and a two-step delete confirm.
- **Defense in depth on writes.** Each write route calls `apiAuth('admin')` first (a JSON `403` for
  anyone below admin, `401` if signed out, `503` if the backend is unconfigured), and **row-level
  security is the backstop** — verified directly against Postgres: an admin's inserts/updates/deletes
  succeed, a viewer's insert is rejected by RLS (`42501`) and update/delete affect zero rows.
- **Friendly database-error mapping.** A shared CRUD helper translates Postgres errors to clean
  statuses: a duplicate SKU/code → `409`, and **deleting a record that's still referenced**
  (e.g. a material used by a formula, a warehouse holding lots) → `409` with a "still referenced"
  message instead of a raw foreign-key error.
- **Online-only by design.** Catalog edits need immediate server validation (unique keys, "in use"
  checks) and would risk last-write-wins conflicts if queued — so they bypass the offline outbox,
  which stays focused on operational capture (production / QC).

> Scope note: formula editing (the versioned BOM with live percent-sum validation) is its own
> larger sub-feature and is the immediate next step, not folded into this release.



This release turns the internal console into a product surface: a public front door, real sign-in/out,
and clearance-aware routing — without weakening the trade-secret protection on the data.

- **Authentication on Supabase's signed JWT (not hand-rolled).** Sign-in issues a signed access +
  refresh token via Supabase Auth; our RLS reads its claims. That's the right primitive, so v0.6
  builds *on* it rather than inventing a parallel token scheme. **Logout** is a first-class action in
  the nav (account menu on desktop, inline on mobile), with a no-JS `POST /api/auth/signout` fallback.
- **A session/role context.** A server helper (`getUserAndRole`, request-deduped) seeds a client
  `SessionProvider` exposing `useSession` / `useRole` / `signOut`, kept live by `onAuthStateChange`.
  The nav adapts to who you are — module links and an **Admin** entry appear only with clearance.
- **Clearance-aware secured routing (SPA).** The authenticated modules moved under **`/app/**`**
  (any signed-in role) and an **`/admin/**`** area (admin only). Enforced **twice**: middleware gates
  the path prefixes (and bounces a signed-in user off `/login`), and each protected layout re-checks
  server-side via `requireAuth()` / `requireRole('admin')` — middleware can fail-open on a transient
  RPC error because the server check is the authoritative, fail-closed gate.
- **A public dashboard as the main page (`/`).** Open to everyone, showing **only non-sensitive
  aggregates** — product/material/lot counts, production throughput, a stock-status mix bar, and QC
  pass-rate — via a single `SECURITY DEFINER` function (`public_metrics()`) granted to `anon`.
  Formula compositions, costs, and quantities stay locked to authenticated roles by RLS. The page is
  auth-aware (an *Enter console* / *Sign in* call-to-action) and degrades to a friendly empty state
  when no backend is connected.
- **Preview mode still works.** With `NEXT_PUBLIC_SUPABASE_*` unset, the gates pass through so the
  whole UI — including `/app` and `/admin` — stays explorable without a backend.
- **Migration runner fix.** `db:test:setup` (`migrate.mjs --local`) now enumerates `db/migrations`
  dynamically and splices the local auth shim in after `0002`, so new migrations (`0005`, and future
  ones) are always applied — previously the `--local` path used a hardcoded list and silently skipped
  anything past `0004`.



- **Styling rebuilt on Tailwind CSS v3.4.** The entire front-end was refactored to utility-first
  Tailwind. The look is unchanged on purpose: design tokens still live as CSS variables, and
  Tailwind's semantic colors (`bg-surface`, `text-accent`, …) resolve to them — so light/dark and
  the sea-blue gradient are driven by the same `data-theme` toggle as before. `darkMode` keys off
  `[data-theme="dark"]`, so the existing `ThemeProvider` needs no `dark:` variants. A small
  `@layer components` holds the few primitives that need real CSS: the responsive table's
  `attr(data-label)` card-stacking, the `color-mix` surfaces, buttons, and badges. Installed and
  managed with **Yarn** (`tailwindcss` + `postcss` + `autoprefixer` as devDependencies).
- **One-command demo data.** `yarn db:seed` populates a runnable dataset — a warehouse, five raw
  materials (with densities), a locked percent formula summing to 100, and received raw-material
  lots created **through `post_movement`**, so the ledger and on-hand projection stay consistent.
  It prints the Product / Formula-version / Warehouse IDs to paste into the New Production Order
  form, and is idempotent (safe to re-run). See path B below.
- **Hardened read routes.** The `formulas`, `inventory`, and `lots/[id]` GET routes now wrap their
  database calls in `try/catch` with structured logging, returning a clean `502` instead of an
  unhandled rejection if the database is unreachable — matching the error discipline already used
  on the write paths.

## What's new in v0.5 — front-end redesign + Cypress

- **Two deliberate themes.** A serene **milky-white** light mode and an atmospheric **sea-blue
  gradient** dark mode, tied together by one deep-teal/aqua accent (the "sea" thread). Preference
  follows the OS by default, is toggleable from the nav, persists, and is applied **before first
  paint** (no flash). Minimalist throughout — the boldness is spent on the dark gradient itself.
- **Mobile-responsive end to end.** The nav collapses to a menu; the generic **`DataTable`** renders
  as a real table on desktop and **stacks into labelled cards on mobile**; forms, the production
  wizard, the lot drill-down, badges, and the offline banner all reflow cleanly down to phone width.
- **Clean, justified type.** Descriptive prose is justified with hyphenation for a settled column;
  data and labels stay aligned on a consistent grid (numbers are tabular and right-aligned).
- **Cypress by default.** End-to-end specs (landing, theme persistence, access-redirect, sign-in)
  plus **component "unit" specs** (`OfflineBanner`, `DataTable`) — runnable headless (automated)
  or in the interactive runner (manual). See *Testing* below.
- **Resilient route protection.** Middleware now degrades an unreachable auth endpoint to
  "signed out" (redirect to `/login`) instead of erroring — also what lets the E2E flow run
  without a live Supabase.
- **Runs without a backend (v0.5.1).** If `NEXT_PUBLIC_SUPABASE_*` is unset, the Supabase clients
  return null instead of throwing: the UI, theming, nav, and flow all render, and data calls report
  a clean "not configured" 503 rather than crashing the page. Connect a backend to light up data.

## Slice history

- **v0.1** domain core — fixed-precision BOM engine + lot-tracked schema, integrity functions.
- **v0.2** security + API + console — RBAC + RLS, ledger writable only via SECURITY DEFINER
  functions, typed API routes, Supabase auth + middleware, module UI, PWA shell.
- **v0.3** offline depth — cached reads + IndexedDB write outbox with auto-replay on reconnect;
  toolchain migrated to Yarn.
- **v0.4** UI depth — batch **genealogy drill-down** (recursive SQL traversal, per-lot ledger),
  **production wizard** (preview the exact exploded BOM before committing), `AsyncView` refactor.
- **v0.5** front-end — responsive redesign (light / sea-blue-dark themes), Tailwind CSS v3.4 rewrite,
  one-command demo seed, Cypress E2E + component specs, graceful no-backend preview.
- **v0.6** product surface — Supabase-JWT auth + logout, session/role context, clearance-aware
  `/app` + `/admin` routing (middleware + server defense-in-depth), and a public aggregates-only
  dashboard at `/`.
- **v0.7** data management — admin CRUD for raw materials, products, and warehouses (generic
  config-driven manager), API-level clearance checks + RLS backstop, friendly DB-error mapping.
- **v0.8** user management — admin users screen with inline role assignment over `app_users`,
  SECURITY DEFINER access to `auth.users`, last-admin guard.
- **v0.9** dashboard + hardening — animated operations dashboard at `/app` (hand-rolled SVG charts,
  reduced-motion aware), and a fix revoking PUBLIC EXECUTE on privileged functions (`0008`).
- **v0.10** demo dataset — a ledger-consistent, idempotent seed: costs, a second warehouse, three
  completed runs (passed/pending/failed QC), and a full production pipeline, so every chart has shape.
- **v0.11** formula editor — versioned BOM authoring at `/admin/formulas` with clone-from, a live
  percent-sum readout, and one-way locking enforced in the UI and the database (`0009`).
- **v0.11.1** internal — de-duped the client `api()`/`errMsg()` helpers into `src/lib/api-client.ts`
  across the four console screens; no behaviour change.
- **v0.12** account lifecycle — admins create and delete login accounts from the Users screen via a
  server-only service-role client (`SUPABASE_SERVICE_ROLE_KEY`), with destructive guards (no
  self-delete, no last-admin) enforced in SQL (`0010`) and graceful degradation when the key is absent.
- **v0.12.1** internal — unified the Postgres-error → HTTP *status contract* into
  `src/server/pg-error.ts` (`mapRpcError`), de-duped across the three admin-RPC modules; messages stay
  per-domain, behaviour unchanged.
- **v0.13** email invitations — admins can invite a user by email (`inviteUserByEmail`) as an
  alternative to a temp password; the invitee sets their own password on a new `/accept-invite` page.
- **v0.14** typed database layer — a generated `Database` type (`yarn gen:types`) parameterizes every
  Supabase client; RPCs and direct queries are schema-checked, and the four result types unify as
  `ServerResult<T>`. Bumped `@supabase/ssr` to 0.12.0 to align client generics.
- **v0.14.1** FK relationships — the generator emits `Relationships` from `pg_constraint`, so nested
  embeds type statically; the `formulas.ts`/`production.ts` embed casts dropped from ~20 to one.
- **v0.14.2** validated RPC boundary — the `public_metrics`/`dashboard_metrics` JSON payloads are
  parsed with Zod (not asserted), so shape drift is logged and degrades gracefully instead of NaNs.
- **v0.15** production order costing — completion freezes actual material cost (`convert_qty` × standard
  cost) onto each consumption and the finished lot's `unit_cost`; a cost breakdown page and a raw/finished
  dashboard split surface it. Snapshot semantics: later `standard_cost` edits don't rewrite made batches.
- **v0.16** distribution (2a) — customers master data + a sales module: orders captured against a
  customer/warehouse with priced lines via an atomic `create_sales_order`, and an expected-margin
  preview (`product_available_cost` weighted-average × line) shown per line and rolled up on the order
  detail. Admin-gated writes; realized COGS deferred to 2b (shipment).
- **v0.16.1** internal — extracted the duplicated 2-decimal `money`/`moneyOrDash` formatter into
  `src/lib/format.ts` and the shared sales status-badge map into `app/app/sales/status.ts`; no
  behaviour change.
- **v0.17** distribution (2b) — shipping a confirmed order issues finished lots **FEFO** via
  `post_movement` (new `'shipment'` movement type), freezes realized **COGS** onto the lines, and flips
  it to `shipped`; realized margin = revenue − COGS replaces the estimate. Atomic, admin-gated, and
  unable to draw non-QC-released stock by construction.
- **v0.18** partial / multi-shipment — `ship_sales_order` ships available stock now and backorders the
  rest (new `partially_shipped` status), accumulating `shipped_quantity` + COGS across repeated
  dispatches; realized figures track the shipped portion (shipped revenue / realized COGS / margin).
  Replaces the v0.17 all-or-nothing raise; cancel is now transition-guarded to pre-shipment states.
- **v0.19** deliberate per-line shipment — a "Ship specific…" form dispatches an admin-entered quantity
  per outstanding line (`ship_sales_order_lines`), capped at the available finished stock now surfaced
  per line; greedy and deliberate paths share one FEFO/COGS primitive. Over-outstanding or over-stock
  requests raise and roll back.

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
  middleware.ts                 Supabase session refresh + route protection
  app/inventory/[id]/           lot drill-down: genealogy + ledger
  app/(formulas|production|qc|inventory)/  client pages -> /api, offline-cached reads
  app/api/                      typed route handlers (incl. production/preview, lots/[id])
  app/components/                SiteNav (responsive), DataTable (responsive), theme/
  app/components/theme/         ThemeProvider (light/dark/system) + ThemeToggle
  app/components/offline/       OfflineProvider, banner, AsyncView, useApiData
  src/lib/offline/              outbox (queue+flush), IndexedDB store, online hook
  src/server/production.ts      preview + create + complete + QC orchestration
  src/domain/                   PURE, fully unit-tested business math (no I/O)

PostgreSQL (Supabase)
  0001_init.sql       schema (14 tables, immutable formula versions)
  0002_functions.sql  integrity core (locked movements, FEFO, atomic completion, QC)
  0003_security.sql   RBAC + RLS + function hardening
  0004_genealogy.sql  recursive ancestor/descendant traversal
```

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
yarn test               # 37 unit (domain, offline outbox, error mapper, schemas, RPC payloads), no DB
yarn test:integration   # 32 DB tests: integrity, FEFO, genealogy, RLS, conversion contract, formula RPCs, account guard, costing
yarn test:all           # all 66
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

## Test coverage (92 tests, all passing)

- **Domain — 10**: unit conversion incl. density; validation; exact-sum scaling; 200-trial property test.
- **Offline — 4**: enqueue + ordering; flush success; offline retain; 4xx drop vs 5xx keep.
- **Integrity — 9**: no negative stock; expired/quarantine guards; reconciliation; FEFO + genealogy;
  atomic rollback; QC gating; 100 concurrent issues serialize under row locks.
- **Security — 6**: formulas hidden from viewers; ledger direct-write blocked even for admins;
  SECURITY DEFINER gateway works; role-gated writes.
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
- **Shipment — 6**: a FEFO issue across two finished lots freezes realized COGS exactly (cross-batch,
  not averaged) and flips to `shipped`; a partial shipment ships available stock and backorders the
  rest (`partially_shipped`); a backordered order completes across dispatches with COGS accumulating;
  an unconfirmed order is refused; an order with no available stock raises; quarantined lots are never
  drawn.
- **Deliberate shipment — 4**: exact per-line quantities ship and complete across dispatches with COGS
  accumulating and available stock surfaced; a request beyond a line's outstanding is rejected; a
  request beyond stock rolls back; zero-quantity lines are skipped and an all-zero request is rejected.
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
(e.g. `formula_components`). The app **compiles for production** (`yarn build` clean, 51 routes incl.
middleware) and is fully typed — both `yarn typecheck` (app) and `yarn typecheck:e2e` (Cypress specs)
are clean, and the **92-test** suite passes against a freshly migrated database.

**Not runnable in this sandbox:** the Cypress *binary* download is network-blocked here, so the
specs are written and type-checked but were not executed in-house — run them on your machine with
the commands above. Likewise the live **sign-in / logout, role-gated routing, in-browser offline
behaviour, and the UI** need a real Supabase project + a browser/deploy to exercise; the Supabase
endpoint is unreachable from this sandbox, so those paths are verified by build + type + server-side
logic rather than a live round-trip.

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
**deliberate per-line split shipment (admin-entered quantity per line, available-stock caps, shared FEFO/COGS primitive)**.

The six-slice product build is complete; master-data authoring includes the versioned BOM, admins
manage login accounts end to end, finished goods are costed, and the distribution loop runs end to end
— capture, confirmation, full / partial / deliberately-split FEFO shipment with backorder, and realized
margin on what has shipped. Natural next steps:
1. **Returns / credit notes** — the inverse of shipment: take shipped stock back into inventory as a new
   lot, reverse the realized COGS on the line, and record a credit. It closes the one remaining gap that
   currently makes a shipment irreversible (which is why cancel is blocked once stock has left).
2. **Costing depth / compliance** (post-MVP) — labor & overhead on top of material cost; SJPH halal
   compliance · replace placeholder PWA icons.
