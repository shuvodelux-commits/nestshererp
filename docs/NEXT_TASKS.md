# SherERP — Remaining Work

**Written 2026-09-02.** The V1 feature build is complete: every phase from 0 to
12.4 is `CODE COMPLETE` in the delivery ledger (`SRS_AND_BUILD_GUIDE.md`
§6.1.1). What follows is what is left, and **nothing here is a reason to delay
the owner's UI acceptance pass** except the items marked **RELEASE BLOCKER**.

Status vocabulary is the ledger's: an agent may set `CODE COMPLETE`; **only the
owner sets `DONE`**, after driving the workflow himself.

---

## NEXT UP

### Seed the expense categories a new shop needs — RELEASE BLOCKER

**Status: found 2026-09-03 by the Phase 18 E2E suite, reported, not started.**

`provisionTenant` (`packages/core-application/src/auth/tenant-provisioning.ts`)
seeds a new tenant's roles, D-10 units and the D-02 walk-in party, but not the
§5.12 expense categories — which only `apps/api/src/backfill-seed-roles.ts`
creates. A shop registering today opens `Record expense` to "No available
options" and cannot record rent, salary or electricity at all.

**Priority.** P0, and the smallest of the blockers: one loop mirroring the
`SEED_UNITS` loop directly above it, plus the same in `provisionTenant`'s test
of record. Phase 18 was forbidden from making it — the file is under
`packages/core-application`, and that module's boundary was explicit.

**Acceptance.** A tenant registered through the API, with no backfill run
afterwards, can record an expense from the Counter and from Expenses.

---

### Phase 18 · Daily-first workflow UI and E2E coverage — CODE COMPLETE

**Status: all five slices delivered and committed (`6ebe3e5`, 2026-09-03).
Awaiting the owner's click-by-click acceptance pass**, which is the gate that
lets any row move to `DONE`. The walkthrough was handed over as an artifact on
the same day.

19 of 19 Playwright specs pass. Full detail — slice by slice, plus the three
defects the suite found — is in `docs/CURRENT_STATE.md`. The fourteen owner
decisions remain in `docs/DECISIONS.md`; **a new or cleared chat should read
those rather than re-asking.**

**Goal.** Make the daily-user workflow faster and less cluttered, then protect
it with focused Playwright coverage. **No accounting, stock, permission or
business-logic change** — every screen keeps calling the use case it calls
today.

**Five slices, run straight through, one walkthrough at the end:**

| | Slice | What it does |
|---|---|---|
| 18.1 | Navigation + Global Search | `Daily` first and the landing route; Dashboard folds into it; the disabled search box in `AppTopBar.vue` becomes real (products, parties, documents by number, plus a separately grouped `Go to…`) |
| 18.2 | Shared list pattern | Products, Customers, Suppliers, Purchases, POS, Counter, Daybook, Daily Cash behave identically — same filters, search, row actions, empty state. Polish, not redesign |
| 18.3 | Declutter | Raw ids and permission codes out of ordinary screens; Sync and Storage Check folded into Offline; empty states given a sentence and a button; table columns trimmed |
| 18.4 | Phone-first | The same eight screens below ~640px. Desktop density untouched |
| 18.5 | Playwright | `apps/web/e2e` against a dedicated `sher_e2e` database: Manager daily flow, Cashier permission smoke, mobile Chromium, upgrade safety |

**The two things most easily got wrong**, both owner decisions and both
non-negotiable:

- **The E2E reset must abort if the database is not exactly `sher_e2e`.** It may
  never touch development, acceptance or production data — the rule
  `apps/api/vitest.config.ts` already applies to `sher_test`.
- **SQL manages the test database; the ERP creates the business state.** No
  stock balance, customer due, supplier balance or journal total may be written
  by raw SQL. Opening stock goes through its real workflow so the movements and
  entries exist.

**Test files.** R-0 §1 forbids writing them; the owner authorised **Playwright
specs only**, in conversation, on 2026-09-03. No new vitest suite alongside them.

---

## POST-RELEASE — needed before this is installed in a real shop

### PR-1 · Deployment artefacts — RELEASE BLOCKER

**Goal.** A repeatable install. Today there is no Dockerfile, no compose file,
no nginx config and no systemd unit tracked anywhere, so §6.5's on-premise
deployment exists only as prose.

**Priority.** P0 — the product cannot be installed twice the same way.

**Files.** New: `Dockerfile` (or two), `docker-compose.yml`, `deploy/nginx.conf`,
`deploy/shererp-api.service`. Reference: `SRS_AND_BUILD_GUIDE.md` §6.5,
`apps/api/.env.example`, `apps/api/src/deployment/boot-validation.ts`.

**Dependencies.** None.

**Acceptance.** A clean machine with Docker reaches a working login screen from
a documented command sequence. nginx serves the web build, proxies `/api`, and
sets **no** COOP/COEP headers (§6.5 — the SAH-pool VFS needs none and they break
Google sign-in). The API starts under systemd with `WorkingDirectory` set, and
the licence and backup paths resolve to the same place they do in development.

### PR-2 · Issue the production licence keypair — RELEASE BLOCKER

**Goal.** `EMBEDDED_KEYS` in `apps/api/src/deployment/license-keys.ts` is `[]`
and `EMBEDDED_LICENSE_PUBLIC_KEY` in `apps/api/src/config.ts` is `''` — by
design, because a placeholder that *looked* like a key would produce a build
that appears to verify and does not. No production keypair exists yet.

**Priority.** P0 — no shop can be licensed.

**Files.** `tools/licence/src/keygen.ts`, `issue.ts`; then the public half into
`apps/api/src/deployment/license-keys.ts` or `LICENSE_TRUSTED_KEYS`.

**Dependencies.** PR-1, so the key lands in a real deployment.

**Acceptance.** A key issued by the tool installs on a fresh installation
through Settings → Licence, the entitlement state leaves READ_ONLY, and the
private key exists only in `~/.sher/licence-keys/` mode 0600 — never in the
repository, never on a customer machine, never in a backup.

### PR-3 · Owner's UI acceptance pass on the offline module (12.4) and licence install

**Goal.** No UI manual has ever been written for Phase 12.4 or for the licence
install screen, and the owner's click-by-click pass is the acceptance gate for
both (`AGENTS.md` R-0 step 5).

**Priority.** P0 — the ledger cannot reach `DONE` without it.

**Files.** None — this is a walkthrough, not code.

**Dependencies.** OFF-1 below, which is the one thing that would make the
walkthrough fail.

**Acceptance.** The owner registers a device, takes a snapshot, pulls the
network, sells, signs in cold with a PIN, reconnects, watches the queue drain,
resolves a quarantined operation, and confirms the figures. Then he sets `DONE`
on rows 12.4 and 10.x.

### PR-4 · Commit the working tree — **DONE 2026-09-03**

Was: source files that tracked code imported were untracked, so the branch as
committed did not build for anybody else.

Committed as `6ebe3e5` and pushed to `origin/feat/products-stock-hub` — 333
files, and 23 commits in total went up, only the newest of which was new work.
The tree is clean and every gate passes on it. Kept here rather than deleted
because the acceptance criterion below is the one worth re-running before a
release, on whatever the tip is then.

**Acceptance.** A fresh clone of the branch runs `pnpm install --frozen-lockfile`
and all four gates without a file from this machine.

---

## MAINTENANCE

### MT-1 · Node engine mismatch

**Goal.** `package.json` pins `>=20 <21` and `.nvmrc` says `20`, but this machine
runs v22.23.2. CI uses `.nvmrc` and so tests 20; local builds run on an engine
the manifest forbids, and only a warning says so.

**Priority.** P2. **Files.** `package.json`, `.nvmrc`. **Dependencies.** None.

**Acceptance.** Either `nvm use` is part of the documented start-up and local
builds run 20, or the engine range is deliberately widened to admit 22 after
checking the build on it. Not left as a permanent warning.

### MT-2 · CI does not run the full build

**Goal.** `.github/workflows/ci.yml` runs lint, typecheck, boundaries, test and
then only `pnpm --filter @sher/web run build`. `pnpm build` — the API and every
package's `tsconfig.build.json` — is never run in CI, so a build-only breakage
reaches `main` green. This session found exactly that class of breakage.

**Priority.** P1. **Files.** `.github/workflows/ci.yml`. **Dependencies.** None.

**Acceptance.** CI runs `pnpm build` and fails on a build-only error.

### MT-3 · Two floating dependency ranges

**Goal.** Every dependency in the workspace is pinned exactly except
`pdfjs-dist: ^6.3.289` (`apps/api/package.json`) and `html2canvas-pro: ^2.4.0`
(`apps/web/package.json`) — both parsers of untrusted input (bank-statement
PDFs, DOM→canvas), which is the worst category to float.

**Priority.** P2. **Files.** those two manifests, `pnpm-lock.yaml`.

**Acceptance.** Both pinned exactly, lockfile regenerated, bank reconciliation
and invoice sharing still work.

### MT-4 · `appVersion` silently reads `0.0.0`

**Goal.** `apps/api/src/infrastructure/build-info.ts:48` joins
`'../../../package.json'`, which resolves one directory too high
(`apps/package.json`), so the version falls back to `'0.0.0'` without
complaining.

**Priority.** P2. **Files.** `apps/api/src/infrastructure/build-info.ts`.

**Acceptance.** `/health` or the build-info surface reports the real version.

### MT-5 · Duplicate migration prefix 0039

**Goal.** `0039_prior_period_entry_mode.sql` and `0039_reconciliation.sql` share
a prefix. Ordering between them is decided by the text after the underscore,
which is arbitrary relative to authoring order. Harmless today (neither depends
on the other) but a trap.

**Priority.** P3 — do **not** renumber applied migrations; the runner keys
`schema_migrations` by full filename and renaming would re-run them. Record the
hazard instead and never create another duplicate.

**Files.** `migrations/`, `packages/adapter-postgres/src/migrator.ts`.

### MT-6 · Sort collation differs between the runner and the schema gate

**Goal.** `migrator.ts:32` sorts with bare `.sort()` (UTF-16 code units);
`apps/api/src/infrastructure/build-info.ts:29` uses `localeCompare`. Two
collations over the same directory means "last applied" and "newest migration"
can in principle disagree.

**Priority.** P3. **Acceptance.** One collation, used by both.

---

## TECHNICAL DEBT

### TD-1 · Offline POS cannot sell from the local copy — the largest real gap

**Goal.** Cold offline sign-in, the outbox, replay and the local invoice all
work, but two reads have no offline path, so the till has nothing to sell
**from**:

- `fetchPosProducts` (`apps/web/src/api/sales.ts`) does not go through
  `offlineFallback`, and `@sher/adapter-sqlite-wasm` exports only
  `localProducts` / `localParties` — there is no local POS-product read at all.
  Under an offline session the product grid is empty and nothing can be added to
  a cart by search or barcode.
- `fetchAccounts` has no offline fallback either, so `payments` defaults to an
  empty `accountId` and `readyToSell` blocks any sale carrying a payment amount.
  Offline sales can therefore only be fully-due sales to a named customer.

**Priority.** P1 — everything around it works, and without it "the shop that
keeps selling with the line down" is not true for a cash sale.

**Files.** `packages/adapter-sqlite-wasm/src/local-reads.ts`, `local-schema.ts`,
`index.ts`; `packages/core-application/src/devices/snapshot-service.ts`;
`apps/web/src/api/sales.ts`, `apps/web/src/api/money.ts`.

**Dependencies.** **Owner decision first.** The 2026-09-01 snapshot scope is
"products, parties and prices; not documents, ledgers or reports". Money
accounts are master data, not documents, but they were not named — so adding
them to the snapshot is a scope question for the owner, not an agent's call
(`AGENTS.md` critical rule 12).

**Acceptance.** With the network down and a cold PIN sign-in, a cashier can find
a product by name and by barcode, take cash, see the change, print the slip, and
watch the sale replay unchanged when the line returns.

### TD-2 · The offline session object is forgeable

**Goal.** `sher.offlineSession` is plain JSON in `localStorage`, including the
permission array. Writing that key by hand yields a signed-in state with
arbitrary permissions and an arbitrary user id.

**Partly mitigated this session:** `ReplayService` now checks
`op.context.userId` against `device_user_access` and quarantines an operation
naming anybody else — so forged work can no longer be posted under a colleague's
authority. **The check is skipped when the device's permitted-user list is
empty**, deliberately, because quarantining a whole day on a decision the owner
was never asked to make would cost more than it protects.

**Priority.** P2 — the attacker needs physical access to the shop's one approved
offline PC, and UI permissions were never a security boundary (the server
refuses regardless).

**Files.** `apps/web/src/auth/session.ts`,
`packages/core-application/src/sync/replay-service.ts`.

**Acceptance.** Either the offline session is signed/sealed against something
the attacker does not hold, or the permitted-user check is made unconditional
after the owner is asked to tick users on every offline device.

### TD-3 · The offline PIN lockout lives where the attacker can clear it

**Goal.** Five failures give a five-minute lock, persisted — correctly — rather
than held in memory. But it is stored in `localStorage`
(`sher.offlinePinLock`), which anyone with the machine can clear from devtools.
It is also **per machine, not per user**, so one person mistyping locks every
cashier out of the counter.

**Priority.** P2 (the per-user part is a usability defect, not a security one).

**Files.** `apps/web/src/offline/offline-session.ts`.

**Acceptance.** The lock is keyed by user and stored where clearing site data
does not reset it — the local SQLite database is the obvious home.

### TD-4 · Offline scrypt runs on the main thread

**Goal.** `verifyPin` derives scrypt at N=32768, r=8 — about 1 M salsa20/8
rounds and a 32 MB allocation — on the UI thread, after a `paint()` hack.
Realistically 2–5 s of frozen UI on a shop PC, not the ~1 s the comment claims.
The implementation itself is **verified correct** (it reproduces RFC 7914 vector
2 and agrees with Node's `crypto.scrypt` on a live round trip).

**Priority.** P2. **Files.** `apps/web/src/offline/pin.ts`,
`apps/web/src/pages/LoginPage.vue`.

**Acceptance.** Derivation runs in a Worker; the sign-in button shows honest
progress; the result is unchanged.

### TD-5 · A revoked device still offers the offline door

**Goal.** `apps/web/src/offline/status.ts:151-158` deliberately keeps the local
copy while the outbox is non-empty, so the shop does not lose unsent work.
Nothing then stops that revoked machine offering offline sign-in and queueing
*more*.

**Priority.** P2. **Acceptance.** A revoked device may drain, and may not
accept new work.

### TD-6 · Offline sign-in skips the tenant and schema guard

**Goal.** `offlineSignInOptions` reads `localDbExists(LIVE_FILE)` and
`localUsers()` directly, skipping the `readStoredSnapshot(tenantId,
SCHEMA_VERSION)` check every read path uses. A copy from an older schema, or one
belonging to another tenant, is still good enough to sign in against.

**Priority.** P2. **Files.** `apps/web/src/offline/offline-session.ts`.

### TD-7 · The offline session never expires

**Goal.** `sher.offlineSession` survives reboots indefinitely. A machine that
stays offline for a week never asks for the PIN again.

**Priority.** P2. **Files.** `apps/web/src/auth/session.ts`.

### TD-8 · `Entitlement.clockBehindMs` is now signed, and its port doc is not

**Goal.** To surface a clock running *ahead* without touching
`packages/core-application/src/ports/entitlement-provider.ts`, `behindMs` was
made signed — positive behind, negative implausibly ahead — and documented at
both ends. The port's own doc comment still says "how far behind".

**Priority.** P2. **Files.** `ports/entitlement-provider.ts`,
`apps/api/src/deployment/license-entitlement-provider.ts`,
`apps/api/src/deployment/license-machine-state.ts`.

**Acceptance.** Split into `clockBehindMs` / `clockAheadMs`, or document the
sign on the port.

### TD-9 · Lock-ordering inconsistency between cancel and receipt

**Goal.** `cancel-sale-service.ts:67,76` locks the **sale** row then the
**party** row; `receive-payment-service.ts:146` and
`vendor-product-settlement-service.ts:62` lock the **party** first and then
touch sales (allocation inserts take `FOR KEY SHARE` on `sales`). A cancel and a
receipt against the same customer, concurrently, can deadlock.

**Priority.** P2 — low probability in a single-shop deployment, and PostgreSQL
aborts one side cleanly. **Acceptance.** One ordering everywhere.

### TD-10 · Race guards throw bare `Error`, so a recoverable refusal reads as a 500

**Goal.** `sales-return-repository.ts:706,950`, `sale-repository.ts:941`,
`vendor-stock-repository.ts:216` each guard a genuine race ("that serial was
sold again") but throw a bare `Error` rather than the `AppError` their
neighbours use, so the user sees a server error instead of a sentence.

**Priority.** P2.

### TD-11 · `WITH_SUPPLIER` holds an active serial number

**Goal.** `WITH_SUPPLIER` is in `ACTIVE_SERIAL_STATUSES`, so sending a `SOLD`
unit to the supplier makes its serial active again. If the shop has meanwhile
received a new unit bearing the same manufacturer number, that transition trips
`inventory_units_active_serial_unique`.

**Priority.** P3 — needs a number reused within the life of one claim. Fixing it
means rethinking which statuses hold a number, which is a real design call.

### TD-12 · Dead code in the licence and serial paths

- `clockLooksWrong` (`packages/core-domain/src/licensing/license-clock.ts`) —
  exported, never called, and now covers only the backwards half of the problem.
- `licenseAllowsWrites` (`license-state.ts`) — no production caller; READ_ONLY
  is enforced by the HTTP guard alone.
- `countUnserialised` (`core-application/src/inventory/serial-repository.ts`) —
  declared, implemented, called nowhere, **and wrong if it ever were**: it sums
  owned-only lots against all `IN_STOCK` units, so consignment units under-report.
- `'WRITTEN_OFF'` is a serial status no code path ever writes.

**Priority.** P3. Remove or wire up deliberately; do not delete in passing.

### TD-13 · `apps/web/public/config.json` carries a real Google client id

**Goal.** It is a public identifier by design — it ships to every browser — but
it is a per-customer value baked into a tracked file, which is exactly what
`apps/web/src/api/client.ts:11` argues against for the API base URL.

**Priority.** P3. **Acceptance.** Supplied at deploy time like `apiBaseUrl`.

---

## FUTURE FEATURES — specified, deliberately not built

None of these blocks V1. They are recorded in the SRS and were consciously
deferred; **do not treat any of them as unfinished work.**

- **Phase 13 — Mobile.** After offline is accepted.
- **Phase 14 — optional Tauri packaging.** Deferred until after Mobile, and
  optional. PWA remains the canonical offline runtime (D-20, D-21).
- **Phase 15 — `apps/mcp`.** Not created; creating the package early is
  speculative scaffolding.
- **SaaS surface** — signup, billing, platform-operator tooling, the SMS credit
  wallet (§5.24). The multi-tenant data model and RLS are already built and
  enforced; only the commercial surface is deferred.
- **`IDENTITY_VERIFIER=otp`** — throws by design: no SMS transport has been
  chosen (§5.24). It must not be made to appear to work.
- **VAT / tax** — removed from V1 by owner override (D-09, 2026-08-16). Columns
  are reserved and `NULL`. Accepted consequence: no VAT-compliant invoice until
  V2.
- **Full Bangla UI** (D-12) — V1.1. Today English is primary with small muted
  Bangla helpers. The app-wide sweep to put Bangla *under* rather than *beside*
  the English label is still the owner's open decision.
- **LIFO costing** — permanently removed (D-05). Do not resurrect it.
- **Loyalty / premium features, generic CRM, a promotion rule engine, customer
  portals, configurable import machinery** — explicitly out of scope.
- **Quotation → sales order → invoice, and customer-group pricing** — built but
  shipped **disabled by default and hidden**. Leave them that way.
- **WebUSB ESC-POS receipt printing** (D-22) — the browser print-dialog fallback
  is mandatory and posting a sale is never coupled to printing.

---

## Open items the SRS still tracks

- **O-5** — POS p95 performance numbers, never measured.
- **O-6** — SQLite WASM + OPFS real-world numbers. Deliberately not blocked on a
  lab measurement: `device_authorizations` now reports measured bytes, usage,
  quota and elapsed time after every snapshot. The row closes when a few real
  shops have reported.
- **O-9** — print stylesheets beyond D-22 and §5.27.
