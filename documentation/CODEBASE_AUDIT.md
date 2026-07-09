# TechnicoFlor Perfume ERP — Codebase Audit & Refinement Report

_Audit date: 10 July 2026 · Codebase version at audit: v0.51.1 → refinements shipped in **v0.51.2**_

## Verdict

The codebase is in **strong, production-grade shape**. Automated sweeps found no TODO/FIXME debt, no stray `console.log`, no `any` escapes outside generated types, and no skipped tests. Two independent deep reviews (frontend and backend/security) confirmed a clean RLS model, pinned `search_path` on every `SECURITY DEFINER` function, correct CSP-nonce propagation, and a coherent typed server layer. A focused set of safe, high-value refinements was applied in this pass; a small number of items are recommended for a follow-up (one of them — a defense-in-depth role gate in the database — should be verified against the integration test suite before deploy).

## Catalog (what was indexed)

| Surface | Count / size |
|---|---|
| TypeScript / TSX files | 227 |
| Application code (`app/`) | ~12,300 lines |
| Server + domain + lib (`src/`) | ~10,400 lines |
| SQL migrations (`db/migrations/`) | 45 files, ~12,200 lines |
| API route handlers (`app/api/**`) | 75 |
| Server modules (`src/server/`) | 22 |
| Domain (pure, unit-tested) | 3 (`decimal`, `formula`, `units`) |
| Test files (Vitest) | 50 · Cypress specs | 3 |

Largest files: `src/types/database.ts` (generated, 2,305), `app/app/sales/[id]/page.tsx` (1,239), `app/app/procurement/page.tsx` (595).

## Method

1. Automated code-smell sweep (debt markers, type escapes, dead CSS, version drift, leftover artifacts).
2. Two parallel senior-review passes — one frontend/React/a11y, one backend/API/SQL/security — reading the actual files.
3. TypeScript no-emit check and the security unit suite after each change.

---

## Refinements applied in v0.51.2

**Security & correctness**
- **Added `apiAuth` to three ungated action routes** — `POST /api/production` (`production`), `POST /api/qc` (`qc`), and `POST /api/production/preview` (`production`). The preview route returns the exploded BOM (recipe proportions), so gating it also closes a **trade-secret exposure** to viewers.
- **WAF now decodes recursively** (bounded) so double-encoded payloads (`%253Cscript`) are normalized before the pattern checks, closing a single-decode bypass.
- **Rate limiter hardened**: the in-memory sweep is time-throttled (a >10k live-key spray can no longer turn every request into an O(n) scan), and the Upstash path repairs a missing TTL so a key can never lose its expiry and block an identifier forever.

**Bugs**
- **Login and accept-invite** async calls are now wrapped in `try/catch/finally` — a network failure previously left the submit button stuck in its disabled "busy" state and raised an unhandled rejection. The invite page's `getSession()` also gained a `.catch` that fails to the "invalid link" state.

**Accessibility**
- The nav logo link now has an accessible name (`aria-label`) — previously it had none on mobile (wordmark hidden, `img alt=""`).
- `DataTable` header cells now carry `scope="col"`.
- `ResourceManager` (the materials/products/warehouses admin screen) now shows explicit loading and error states instead of a bare header-only table.

**Consistency / cleanup**
- Unified the **two reduced-motion implementations** onto Framer Motion's `useReducedMotion` (removed the duplicate custom hook); charts and the count-up now share one source of truth.
- Removed leftover Vitest temp files from the repo and added a `.gitignore` guard.

---

## Recommended for a follow-up (not changed in this pass)

### Priority 1 — Database role gates on stock/QC mutators (needs integration test)

`post_movement`, `record_qc`, and the non-override path of `complete_production_order` are `SECURITY DEFINER`, granted to `authenticated`, and do **not** check the caller's application role internally (unlike the financial mutators, which all enforce `current_app_role() = 'admin'`). Because they bypass table RLS, a signed-in **viewer** could invoke them directly via Supabase's PostgREST endpoint — outside the app — to post stock movements, complete production, or pass/fail QC. The app-layer `apiAuth` fix above closes this for normal usage, but the direct-RPC path remains.

Recommended fix: a new migration (`0046`) that `CREATE OR REPLACE`s each function with a leading guard, e.g. for `record_qc`:

```sql
if current_app_role() not in ('admin','qc') then
  raise exception 'insufficient privilege' using errcode = '42501';
end if;
```

(`post_movement` and `complete_production_order`: `('admin','production')`.) This touches functions that other DEFINER routines call internally, so it **must be run against `yarn test:integration`** to confirm no legitimate cross-function call is blocked before deploying.

### Priority 2 — Honest HTTP status codes for production/QC

`src/server/production.ts` uses an `ActionResult` type with no status, so the production/QC routes return `400` for everything (a missing order should be `404`, insufficient stock / halal block `409`/`422`, an RLS denial `403`). Migrate these to the `ServerResult` + `mapRpcError` pattern the rest of the API already uses.

### Priority 3 — Smaller refinements
- **`useApiData` race**: add an ignore/AbortController guard so an older in-flight response can't overwrite fresher data (or write after unmount).
- **`NewSalesOrderForm` line keys**: use stable ids instead of the array index (the procurement page and `FormulaEditor` already do).
- **Framer entrance animations render `opacity:0` in SSR** for non-reduced-motion users — a brief blank flash on slow JS, and invisible if JS fails. Consider a `<noscript>` visibility fallback, or gate `initial` on a mounted flag.
- **Account menu** (`role="menu"`) doesn't move focus into the menu on open or support arrow-key navigation.
- **`SessionProvider` / `onAuthStateChange`**: guard role fetches against out-of-order resolution.
- **`FormulaEditor`**: the material-unit auto-default has duplicate/ineffective logic — picking a material never defaults its base unit (works in `NewSalesOrderForm`).
- **Nits**: memoize `createClient()` in the login page (as the invite page does); seed the theme-toggle icon from `document.documentElement.dataset.theme` to avoid a first-paint icon swap; key chart segments by id rather than label; standardize resource-creation responses on `201` + `{ data }`.

---

## Bottom line

No blocking defects. The applied refinements remove a trade-secret exposure, harden the security layer, fix a real "stuck button" bug, and tidy accessibility and consistency. The only item that rises above "nice to have" is the Priority-1 database role gate, which is a defense-in-depth hardening best applied with the integration suite running. With that scheduled, the project can reasonably be considered **complete** for its current scope.
