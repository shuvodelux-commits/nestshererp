# SherERP — Current State

**Date:** 2026-09-03
**Branch:** `feat/products-stock-hub`
**Last commit:** `6ebe3e5` — *feat(web,api): the screens a shopkeeper opens first, and the suite that keeps them honest*
**Working tree:** **clean.** The branch is pushed and in sync with `origin/feat/products-stock-hub` — 23 commits went up on 2026-09-03, only the newest of which was new work. `PR-4` is done: a fresh clone builds without a file from this machine.

---

## Where a new chat should pick up

**Phase 17 (vendor control plane) is CODE COMPLETE and verified, and is now committed.**

**Phase 18 is IN PROGRESS.** The owner said `START` on 2026-09-03. All fourteen
decisions are in `docs/DECISIONS.md` under *"Phase 18 — Daily-first workflow UI
and E2E coverage"*, and the slice plan is in `docs/NEXT_TASKS.md` under
*"NEXT UP"*. **Read those two sections rather than re-asking.**

Slice status, so a cleared chat resumes at the boundary rather than the top:

| Slice | State |
|---|---|
| 18.1 navigation + Global Search | **done** — `Daily` first and Dashboard inside it; `GET /api/v1/search` live and smoke-tested against `sher_dev`; `Ctrl K` palette in the top bar |
| 18.2 shared list pattern | **done** — Purchases, Daybook, Daily Cash, Counter and POS brought onto the Products/Parties pattern (page-level `.filters`, `AppShell` header, two empty states) |
| 18.3 declutter | **done** — Sync folded into Offline (nav entry removed, `/sync` kept as a route and an `activePrefix`); sync conflict JSON turned into words; `Stock value` off Products, `Items` off Purchases |
| 18.4 phone-first | **done** — shared `.list-cards` pattern below 640px on Products, Purchases, Daybook and Daily Cash; full-screen dialogs; `AmountInput` and `SearchField` given the right `inputmode` |
| 18.5 Playwright | **done — 19 of 19 green** |

**Running the suite.** `cd apps/web && pnpm test:e2e` (or `pnpm test:e2e` from
the root). It needs `pnpm --filter "@sher/api..." build` first — the E2E API
runs from `dist`, not from source — and Chromium's system libraries
(`sudo apt-get install -y libnss3`, done on this machine 2026-09-03).

It runs on its own ports (API 3100, Vite 5273) against its own `sher_e2e`
database, so it can run while the development stack is up on 3000/5173 and
neither can see the other's data.

Everything passes `pnpm build`, `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundaries`, `pnpm test:inventory` and `pnpm test:e2e`, and the tree is committed and pushed (`6ebe3e5`).
**The owner's UI walkthrough is the one thing outstanding** — it is the
acceptance gate for the module, and no row may reach `DONE` without it.

**Three defects the suite found**, all on screens inside Phase 18's scope:
Counter's cold-open load (fixed), five unlabelled icon buttons in POS (fixed),
and expense categories missing from `provisionTenant` (**open, reported, not
fixed** — see Known bugs; the fix touches `core-application`, which this
module's boundary forbids).

---

## Release status

**Feature-complete, not yet released.**

Every phase in the delivery ledger (`SRS_AND_BUILD_GUIDE.md` §6.1.1) from 0
through 12.5 is `CODE COMPLETE`. **No module is left to build for V1.** Phases
13 (Mobile), 14 (optional Tauri packaging), 15 (MCP) and 16 (reusable core
extraction) are post-V1 and deliberately not started.

The ledger itself was found incomplete during this audit and has been repaired
rather than trusted: **Phase 4 (money accounts and the cash drawer) had no row
at all**, despite every later payment depending on it; so did the Finance module
and slice 12.2. Rows 2 and 3 still read `IN PROGRESS` and are left that way,
because a historical row is never rewritten — a closing row now records that
their sub-paths finished. See "Rows reconstructed 2026-09-02". **No row is `DONE`** for the most recent work,
because only the owner sets `DONE` and he has not yet driven Phase 12.4 or the
licence-install screen in the UI. That walkthrough — not a green test run — is
the project's acceptance gate (`AGENTS.md` R-0 step 5).

Three things stand between this and an install in a real shop. Two are still
open and listed in `docs/NEXT_TASKS.md`: **no deployment artefacts exist**
(PR-1) and **no production licence keypair has been issued** (PR-2). The third,
**PR-4 — commit the working tree**, is **done**: the branch was committed and
pushed on 2026-09-03.

A fourth was found after that list was written and is now the smallest of the
blockers: **a brand-new shop cannot record an expense**, because
`provisionTenant` does not seed the §5.12 expense categories. See Known bugs.

---

## What works

The whole online V1 loop, verified by the owner module by module:

- Tenant registration, login (password / PIN / Google OIDC), password recovery,
  users, roles, permissions, settings, audit trail.
- Products, brands, categories, units and conversion, barcodes; parties
  (customer / supplier / vendor as role flags on one record); guided CSV import
  for products, parties and opening stock.
- Inventory: opening stock, movements, lots, FIFO and moving-average costing,
  valuation, negative-stock policy, stock adjustments, stock counts, expiry.
- Purchasing: bills, receipts, supplier dues and payments, purchase returns,
  purchase correction by reversal, purchase planner, supplier orders, landed
  costs typed on the bill.
- Sales and POS: sell, stock out, invoice, money in, customer ledger, sales
  returns, refunds, cancellation, invoice presentation, quotations and
  sales orders (hidden by default).
- Money: cash drawer sessions, day start and end, expected-vs-counted with
  `CASH_SHORT_OVER`, money accounts, transfers, expenses, owner current account,
  loans, bank and account reconciliation against a parsed statement PDF.
- Reporting, dashboard, Daybook with day-end print, "why" drill-downs, monthly
  profit target, period close, change-transaction-date, corrections and
  cancellations from the daybook and from each document's own screen.
- Serial and warranty tracking; vendor consignment stock and the Vendor
  Workspace hub.
- Backup and recovery: the business exported as one encrypted `.sherdb` file and
  restored into an empty installation.
- Licence: an offline Ed25519-signed key installed through Settings, with
  anti-rollback held outside the database and outside the backup.
- Offline: installable PWA, the D-24 storage gate, SQLite WASM over OPFS
  (SAH-pool VFS), the shop snapshot, single-writer device authority, cold PIN
  sign-in, the outbox, replay through the online services, quarantine, and
  per-device sale numbering.

**And, added 2026-09-03, the first thing here that is not part of the shop's
product — Phase 17, the vendor control plane.** Four new processes beside the
ERP rather than inside it: `apps/control-plane` with its own database,
`apps/admin` (the operator console), `apps/agent` (a sidecar on the customer's
machine) and `tools/signer` (loopback-only, the only process that reads a
private key). It manages a fleet — enrolment, licences, signed releases, staged
deployment, diagnostics and time-boxed remote support — and it is forbidden by
`pnpm test:boundaries` from importing the ERP's domain, application services or
database adapters. **The shop's independence is unchanged**: verified by killing
the control plane and watching the ERP keep trading, judging its licence
locally, while the sidecar backed off and caught up on its own.

---

## Verification — run on this tree, 2026-09-03

| Gate | Result |
|---|---|
| `pnpm build` | **clean** — all 15 workspace projects |
| `pnpm typecheck` | **clean** — 15 projects, including `vue-tsc` over both front ends |
| `pnpm lint` | **clean** |
| `pnpm test:boundaries` | **`Boundaries OK — no layering violations`**, now including the new `control-plane-no-erp-data-plane` rule |
| `pnpm test` — pure suites | **clean** — core-domain 166, shared-utils 83, web 191, boundaries 3 |
| `pnpm test` — API integration | **clean** — 24 files, **331 passed**, 41 minutes (see the note below) |
| Phase 17 end-to-end | **65 checks against the running stack**, all passing — see the note below |
| Migrations (ERP) | `0052` applied; database at 52 of 52 — **Phase 17 added none** |
| Migrations (control plane) | `0001_control_plane.sql` applied to `sher_control` |
| Seed-role backfill | ran clean — `license.install`, `sync.status.view`, `sync.conflict.resolve`, `sync.conflict.discard` all present |
| API boot | `/health` → **200**, security headers present, schema-version gate passes |
| Web dev server | **200** on `:5173` |
| Offline PIN scrypt | **verified correct** — reproduces RFC 7914 vector 2 and agrees with Node's `crypto.scrypt` on a live round trip |

**The API integration suite is green — 24 files, 331 tests — and it takes 41
minutes.** `resetDatabase` truncates roughly a hundred tables and runs in
`beforeEach`, before **every** test; on this WSL2 disk that one statement costs
several seconds, so each test costs 7–9. That is a pre-existing property of the
harness and worth fixing one day — a per-suite schema, or a transactional
rollback instead of a global TRUNCATE, would cut it to minutes — but changing
existing tests is R-H's to authorise, so it is recorded rather than done.

**A false alarm worth recording, because it will happen again.** An earlier run
in this session reported 22 failed files, all `deadlock detected` inside
`prepareTestDatabase` and `resetDatabase`. None of it was the code: overlapping
runs had left `TRUNCATE` statements stuck on `sher_test`, and the next run's
`GRANT … ON ALL TABLES` deadlocked against them. **Never start a second suite
run while one is going**, and if a run dies half way, clear the strays before
retrying:

```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = 'sher_test' AND pid <> pg_backend_pid();
```

The four suites that touch no database — **443 tests** across core-domain,
shared-utils, web and boundaries — pass in seconds, including
`navigation-architecture.spec.ts`, which covers the shell this phase modified.
**774 tests pass in total.**

**How Phase 17 was actually verified.** Not by unit tests — R-0 forbids writing
any — but by driving the whole stack: signer, control plane, sidecar and the
real ERP, all running, 65 checks. Enrolment and single-use tokens; signature,
body-hash, clock-skew and nonce-replay refusals; command signing, tenant
binding, expiry and idempotency; a licence issued, signed, delivered and
re-verified against the signer's published key; a release hashed from disk and
signed, a rollout halted by a reported migration failure and refusing to
advance; a support session opening a real outbound tunnel from the sidecar and
serving the shop's own `/api/v1/settings` into the vendor console, with the
forbidden routes refused and revocation cutting it off immediately; and the
§20/§21 outage invariants, tested by killing the control plane. **Two genuine
defects were found this way and not by the compiler** — the support grant
carried the vendor's tenant id where the ERP needed its own, and a queued
command waited 180 seconds before collection. Both fixed.

**Two of the four gates were broken when the previous session started** and were
fixed there: `pnpm build` failed with two type errors in `apps/web`, and
`pnpm lint` failed on an unused import. Both came from uncommitted Phase 8.2
work whose contract changes had not been carried into their callers.

**On running tests at all.** `AGENTS.md` R-0 tells agents not to run the suites
and never to write new test files — the owner verifies each module himself in
the running app. Since 2026-08-26 he asks for the existing suites to be run
**once, at a module gate**. No new test file was created in this session, and
none in Phase 17; the 65 end-to-end checks above were throwaway scripts run
against the live stack and left in `/tmp`, not committed to the repository.

---

## Known limitations

**Accepted for this release:**

- **Offline sales are due-only in practice.** The till has no local read for POS
  products or money accounts, so with the line down a cashier cannot search the
  product grid or take cash. Everything around it — sign-in, queue, replay,
  local invoice — works. See `docs/NEXT_TASKS.md` **TD-1**; it needs an owner
  decision about the snapshot's scope before it can be built.
- **The offline session object is forgeable** by anyone with physical access to
  the shop's one approved offline PC. The server-side consequence is now closed:
  replay quarantines any operation naming a user who is not on that device's
  permitted list. UI permissions were never a security boundary. **TD-2**.
- **The offline PIN hash sits in plaintext OPFS**, so a four-digit PIN is
  brute-forceable by someone holding the machine, and the local copy of the
  shop's data is unencrypted regardless of the PIN. This is inherent to the
  "PIN hash travels" decision and is disclosed on the page rather than papered
  over with a browser-held key.
- **Tokens live in `localStorage`** — a documented trade-off, not an oversight.
- **`IDENTITY_VERIFIER=otp` throws by design.** No SMS transport has been
  chosen; it must not be made to look as though it works.
- **VAT/tax is out of V1** (D-09). Columns reserved and `NULL`.
- **No VAT-compliant invoice, no full Bangla UI, no mobile app, no MCP server** —
  all deliberately deferred; see `docs/NEXT_TASKS.md` → Future Features.

**Not blockers, but true:** local builds run Node 22 while the manifest pins 20
(MT-1); CI never runs the full `pnpm build` (MT-2); two dependencies float on a
caret (MT-3).

---

## Known bugs

### OPEN · A new shop cannot record an expense — RELEASE BLOCKER

**Found by the Phase 18.5 E2E suite, 2026-09-03. Not fixed — reported.**

`provisionTenant` (`packages/core-application/src/auth/tenant-provisioning.ts`)
seeds a new tenant's roles, D-10 units and the D-02 walk-in party, but **not the
§5.12 expense categories**. `apps/api/src/backfill-seed-roles.ts` does seed them,
and `FUNCTION_MAP.md` states the rule: anything every tenant must own from day
one goes in **both**.

So a shop that registers today opens `Record expense` to a picker that says
*"No available options"* and cannot record rent, salary or electricity at all
until somebody runs `dist/backfill-seed-roles.js` on the server. The units loop
immediately above the gap carries the comment "a business created with an empty
unit list is a business that cannot add its first product" — the same sentence
is true of categories, and that is the whole argument for fixing it.

**Why it is not fixed here.** Phase 18's boundary (decision 1 of 2026-09-03) is
that if a file under `packages/core-domain` or `packages/core-application`
changes, the module has overstepped. The fix is one loop mirroring `SEED_UNITS`
and wants its own small slice. `apps/web/e2e/support/seed.ts` creates a category
through `POST /api/v1/expenses/categories` in the meantime, with a comment
naming this entry so the workaround is not mistaken for the design.

### FIXED · Five icon-only buttons in POS had no accessible name

Found by the same suite, 2026-09-03. The `=` (Exact amount) and trash on a
payment row, the eye (Show purchase price) and ✕ (Remove) on a cart line, and
the `+` (Add a vendor) carried a `title` but no accessible name, so a screen
reader announced each of them as "button" and nothing else. Given `aria-label`s.

This is the accessibility check the owner's decision 13 predicted: selectors
follow what a shopkeeper sees, and *"an element with no accessible name cannot
be found this way"* — the spec could not find the button because a blind cashier
could not either.

### FIXED · Counter lost its customer and supplier lists on a cold open

Also found by the E2E suite. `CounterPage.load()` decided what to fetch from the
permissions the session held, and on a cold open it could run before
`/api/v1/me` had answered — skipping the customer list, the supplier list and
the expense categories, with no retry, because the only other trigger was a
write. The screen looked normal (six tiles, the drawer figure) but
`Receive Money` opened an empty picker, so a cashier could not take money until
they left the page and came back. Fixed with one `watch` on the permission set
that re-runs the load once, on the single transition from unknown to known.

### Not a defect

One reported defect turned out not to exist and is recorded here so it is not
re-investigated: voiding a sales return does **not** brick the line's
returnability. `PostgresSalesReturnRepository.sourceAllocations`
(`packages/adapter-postgres/src/sales-return-repository.ts:237-246`) already
joins `sales_returns` and filters `status = 'POSTED' AND deleted_at IS NULL`, so
a voided return's reversal rows stop counting the moment the void commits.

---

## Deployment readiness

**NOT READY** — for two reasons, neither of them code quality:

1. **No deployment artefacts exist.** No Dockerfile, no compose file, no nginx
   config, no systemd unit is tracked. §6.5 describes the on-premise deployment
   in prose only, so nobody can install this twice the same way. (PR-1)
2. **No production licence keypair has been issued.** `EMBEDDED_KEYS` is `[]`
   and `EMBEDDED_LICENSE_PUBLIC_KEY` is `''` — deliberately, because a
   placeholder that looked like a key would produce a build that appears to
   verify and does not. Until a real keypair exists, no shop can be licensed.
   (PR-2)

The application itself is sound: boot validation refuses unsafe configuration
before serving, the schema-version gate refuses a mismatched database,
entitlement defaults to `license` so a missing environment line degrades to a
visible READ_ONLY rather than to unlimited trading, CORS is origin-scoped, RLS
is on, and no secret is committed anywhere in the tree.

---

## Git safety review

**No secrets are committed.** Every tracked file was scanned for private keys,
certificates and credential literals; every hit is a test fixture password or a
UI label. `apps/api/.env` and `apps/api/licence/` exist on disk and are ignored.
No `.pem` or `.key` file exists anywhere.

**No generated files are tracked.** `git ls-files` returns nothing under any
`dist/`, `node_modules/`, `*.tsbuildinfo` or `*.log`.

**Uncommitted work — 84 modified files.** Four streams: the offline licence-key
module, cold offline sign-in, Phase 8.2 serial and vendor-consignment
corrections, and this session's fixes.

**Untracked and REQUIRED — a fresh clone does not build without these:**

```
apps/api/src/deployment/license-codec.ts
apps/api/src/deployment/license-key-store.ts
apps/api/src/deployment/license-keys.ts
apps/api/src/deployment/license-machine-state.ts
apps/api/src/common/security-headers.ts
apps/web/src/offline/offline-session.ts
apps/web/src/offline/pin.ts
packages/core-application/src/licensing/entitlement-binding.ts
packages/core-application/src/licensing/license-install-service.ts
packages/core-application/src/licensing/license-ports.ts
packages/core-contracts/src/license-key.ts
packages/core-domain/src/licensing/license-clock.ts
packages/core-domain/src/licensing/license-regression.ts
migrations/0051_phase_8_2_serial_vendor_returns.sql
migrations/0052_warranty_replacement_serial_status.sql
tools/licence/          (source only; its dist/ is ignored)
```

Tracked code already imports every one of them, and the **tracked**
`pnpm-lock.yaml` names a `tools/licence` importer that is not in git — so
`pnpm install --frozen-lockfile` fails on a fresh clone before any gate runs.
**This is the single most consequential thing outstanding.**

**Untracked and new documentation:** `CLAUDE.md`, `apps/api/.env.example`,
`docs/AI_HANDOFF.md`, `docs/CURRENT_STATE.md`, `docs/NEXT_TASKS.md`,
`docs/DECISIONS.md`.

**Now ignored, deliberately:** `codex-skills/` (a third-party bundle carrying its
own `.git/` — one `git add .` from being swallowed whole), plus `*.pem`, `*.key`,
`*.p8` and `.env.*` with `!.env.example`, so "no keys in git" is a property of
the repository rather than a habit.

**Nothing was committed and nothing was deleted.** That is your call.

---

## Recommended next action

1. **Read the diff, then commit** — one commit per stream if you want the
   history readable, or one for the lot. Nothing else can be verified by anyone
   else until this is in git. (PR-4)
2. **Take the UI walkthrough on Phase 12.4 and the licence screen**, with the
   dev server already running (`:3000` and `:5173`). That is the acceptance gate,
   and it is the only thing that can move those ledger rows to `DONE`. (PR-3)
3. **Decide TD-1** — whether the offline snapshot may carry POS products and
   money accounts. Until then, an offline sale can only be a due sale to a named
   customer, which is probably not what "keeps selling with the line down" is
   meant to mean.
4. Then **PR-1 and PR-2** — the deployment artefacts and the production keypair.
