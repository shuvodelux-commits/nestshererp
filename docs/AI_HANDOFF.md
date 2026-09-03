# SherERP — AI Handoff

**Written 2026-09-02.** For a developer or AI coding agent picking this project
up with no access to the conversation that built it.

Read this file first, then `docs/CURRENT_STATE.md` for where the work stands,
then `AGENTS.md` — which carries the owner's binding working protocol and
outranks everything here.

---

## 1. What SherERP is

A multi-tenant ERP for **Bangladeshi SME retail** — a shop that buys stock on
credit, sells over a counter, takes part-payments, lends goods on consignment,
and keeps its real books in a notebook. The product's job is to be the notebook,
correctly, for someone who is not an accountant and may have low literacy.

Two shapes, one codebase:

- **V1, the shipped shape:** a **single-business installed product**. One
  business, on-premise or on a small VPS, entitled by an offline Ed25519-signed
  **licence key** rather than a subscription (owner decision 2026-08-30).
- **SaaS multi-tenancy** is fully built into the data model and enforced
  everywhere (every table has `tenant_id`, RLS is on), but the SaaS signup,
  billing and platform-operator surface is deferred. The permissive
  subscription entitlement stub still exists and must be asked for by name
  (`ENTITLEMENT_SOURCE=subscription`).

Design constants that follow from the user, not from taste: **English primary
labels with small muted Bangla helpers**, few steps, one obvious action per
screen, and every number on a transaction screen recomputing the instant
anything changes.

---

## 2. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.7, strict |
| Runtime | Node 20 LTS (`.nvmrc`; the manifest pins `>=20 <21`) |
| Package manager | pnpm 9.15.9, workspace monorepo |
| API | NestJS, controllers ≤20 lines, REST + zod contracts |
| Database | PostgreSQL 16, Drizzle ORM, row-level security |
| Web | Vue 3 + Vite, PWA, PrimeVue 4 (styled mode, self-hosted) |
| Offline store | SQLite WASM over OPFS, **SAH-pool VFS** |
| Tests | vitest |
| CI | GitHub Actions — lint, typecheck, boundaries, test, web build |

**Rejected, deliberately:** T3/tRPC (breaks the REST/OpenAPI contract mobile,
on-prem and MCP all share), Tauri as the primary offline runtime (PWA is
canonical; Tauri is a possible later packaging shell), IndexedDB as the offline
engine (cannot express transactional multi-table writes), Vuetify and
Tailwind+headless (see D-37), bcrypt/argon2 (Node's own scrypt is used).

---

## 3. Repository structure

```
packages/shared-utils/        Money, Qty, UnitCost, Ulid, Clock  — the primitives
packages/core-domain/         PURE TS: entities, invariants, costing, posting rules
packages/core-application/    Use cases, repository interfaces, permissions, audit, ports
packages/core-contracts/      zod schemas, DTOs, error codes, permission catalogue
packages/adapter-postgres/    Drizzle + PostgreSQL implementations of the interfaces
packages/adapter-sqlite-wasm/ The browser's local database (Phase 12)
apps/api/                     NestJS HTTP API
apps/web/                     Vue 3 + Vite PWA
tools/boundaries/             The layering checker CI runs
tools/licence/                Offline licence keygen + issue CLI (operator-side)
migrations/                   Numbered .sql files, applied in filename order
```

**Dependencies flow one way and CI enforces it:**
`api → application → domain → shared-utils`.

- `core-domain` imports only `shared-utils` and `zod`. No NestJS, Drizzle, pg,
  express, DOM types.
- `core-domain` and `core-application` are **browser-safe** — no `fs`, `path`,
  or `node:crypto` — because the same domain arithmetic runs in the till.
- `pnpm test:boundaries` fails the build on any violation. **Never bypass it.**

`packages/core-application/src/` is organised by business area: `auth`, `catalog`,
`parties`, `inventory`, `purchasing`, `sales`, `returns`, `money`, `expenses`,
`periods`, `corrections`, `reporting`, `daybook`, `reconciliation`, `warranty`,
`vendors`, `devices`, `sync`, `licensing`, `backup`, `imports`, `settings`,
`users`, `audit`.

---

## 4. The canonical documents

`AGENTS.md` names four, and they are the only place a requirement, a decision or
a delivery status may be recorded:

| File | Read it for |
|---|---|
| `SRS_AND_BUILD_GUIDE.md` (412 KB) | **WHAT** to build — requirements, final decisions D-01…D-43, module specs §5.x, golden invariants §3.11, delivery status ledger §6.1.1, and a CHANGE LOG at the end that records every decision later revised |
| `AI_CODING_INSTRUCTIONS.md` | **HOW** — R-0 the owner's protocol, write-path classes, layering, Definition of Done |
| `AGENTS.md` | Orientation, critical rules, scope discipline |
| `FUNCTION_MAP.md` (62 KB) | **WHAT ALREADY EXISTS** — a reuse index of services, endpoints, repository methods and shared components with file paths. **Read it before searching the codebase.** |

Plus this handoff set (`docs/AI_HANDOFF.md`, `CURRENT_STATE.md`,
`NEXT_TASKS.md`, `DECISIONS.md`) and `CLAUDE.md`. **Do not create other `.md`
files.** `docs/archive/` holds superseded planning documents — do not read them,
they contradict the current spec.

**The delivery status ledger (`SRS_AND_BUILD_GUIDE.md` §6.1.1) is the only
record of what is built.** A row is `IN PROGRESS` when a module starts and
`CODE COMPLETE` when the code is done and the gates are green. **Only the owner
sets `DONE`**, after driving the workflow in the UI himself.

---

## 5. Accounting and data invariants that must never be violated

These are `SRS_AND_BUILD_GUIDE.md` §3.11 and §2.4. Breaking one silently
corrupts the shop's books.

1. **Every journal entry balances.** Σ debit = Σ credit, always, in the same
   transaction as the document.
2. **The internal account list is CLOSED.** `AR`, `AP`, `CASH:{id}`,
   `BANK:{id}`, `LOAN:{id}`, `INVENTORY`, `COGS`, `SALES`, `EXPENSE:{cat}`,
   `VENDOR_PAYABLE`, `CUSTOMER_ADVANCE`, `SUPPLIER_ADVANCE`, `VENDOR_ADVANCE`,
   `WARRANTY_EXPENSE`, `CASH_SHORT_OVER`, `STOCK_ADJUSTMENT`,
   `OWNER_CURRENT_ACCOUNT`, `ROUNDING`, `OPENING_EQUITY`. An agent that needs an
   account not on this list must **stop and report** — a new account changes
   what every report means.
3. **Reports derive money from `journal_lines` and `stock_movements`, never
   from document fields** (INV-10). A second profit figure computed from a
   document is a defect even when it happens to agree.
4. **Money and quantity are integers in minor units** — money scale 2, quantity
   scale 3, unit cost scale 4. Float arithmetic on either is forbidden.
5. **Nothing posted is ever mutated or row-deleted.** Corrections are
   append-only: reverse, then re-post. Movements, journal lines and audit events
   are append-only. Soft delete (`deleted_at`) everywhere else.
6. **Cash is moved, never assigned.** An opening cash figure that differs from
   the previous counted close needs a posted movement with a named source or
   destination. A stored expected drawer amount is **immutable** — the
   difference posts to `CASH_SHORT_OVER`; it never edits the expectation.
7. **Every table has `tenant_id`, sourced from `TenantContext`** — never from a
   request body, query string or URL. **Cross-tenant denials return 404, not
   403**, so a probe cannot confirm a record exists.
8. **All ids are ULIDs generated in application code.** No autoincrement, and
   no id generated in SQL — which is why seed permissions are backfilled by a
   script rather than by a migration.
9. **Balances are derived and recomputable** (`party_balance`, `stock_balance`,
   `account_balance`), never the source of truth.
10. **Time comes from the `Clock` port.** `new Date()` and `Date.now()` are
    legal in exactly one file, `packages/shared-utils/src/clock.ts`. The
    boundary checker enforces this, including inside Vue components.
11. **Transaction Date is `business_date`** and is the basis for every ledger,
    report and period lock. **Entry Date is the immutable `created_at`**, for
    audit only. Tenant-local day boundaries are converted to instants **in the
    use case, never in SQL** — Dhaka's 18th begins at 18:00 UTC on the 17th.

---

## 6. Write-path classes

Not every write runs the same path — inventing fake steps is as wrong as
skipping real ones (`AI_CODING_INSTRUCTIONS.md` R-D):

- **Class T — financial / stock / document writes.** The full ten-step path in
  one transaction: permission, entitlement, period guard, idempotency, numbering,
  document, stock movement, lot, journal entry, audit, outbox.
- **Class S — security / identity writes.** Permission, the write, audit.
- **Class M — master / configuration writes.** Permission, validation, the
  write, audit.

**Idempotency:** `Idempotency-Key` and `operation_id` are one value. It is
retained permanently and uniquely indexed, so a sync replay after the 30-day
prune cannot duplicate. Every create that must survive a retry sends it — the
header is in the CORS allow-list for exactly this reason.

---

## 7. API conventions

- REST under `/api/v1/…`. Controllers are thin (≤20 lines) and hold no business
  logic — they resolve context, call one application service, and return.
- **Error envelope:** `{ error: { code, message, details } }`. Clients switch on
  `code`, never on `message`. `details` carries the machine-readable reason that
  lets a screen offer a *different screen* rather than different wording — e.g.
  `reason: CASH_DAY_NOT_STARTED` becomes a "start the day" button beside the
  half-typed bill.
- **CORS is origin-scoped** to `WEB_ORIGIN`, never wildcarded, and the allowed
  header list lives in one place (`apps/api/src/common/cors.ts`). A header
  missing there is not rejected with a readable status — the request is never
  sent, and the screen shows a dead network.
- Security headers are set for every response in
  `apps/api/src/common/security-headers.ts`. No CSP: that belongs on the origin
  that serves the app, not the one that serves JSON.
- **Keyset pagination on the ULID id.** `OFFSET` is banned.
- Boot refuses unsafe configuration before anything is constructed
  (`apps/api/src/deployment/boot-validation.ts`), and a schema-version gate
  refuses to start against a database that does not match the build
  (`schema-version-gate.ts`).

---

## 8. Frontend conventions

- **Use the design that already exists. Never invent one.** This repository is
  built by more than one AI tool and nothing wrecks a product faster than each
  bringing its own ideas. Open two or three similar screens and follow them.
- Shared components: `AppCard`, `StatCard`, `EmptyState`, `ErrorNotice`,
  `HelpTip`, `SortableHeader`, `DateOnlyPicker`, `SearchField`, `QuickAddSelect`.
  Tokens are `--sher-*`; global classes are in `apps/web/src/design/components.css`.
- **The shell is mounted once, above the router.** A page must not re-mount the
  chrome. Page spacing is owned by the shell, not by each page.
- **Four required states on every screen:** loading, empty, error, content.
- **One modal for every one-task action** — edit, delete, receive payment, pay
  supplier, return, refund, stock adjustment, owner withdrawal. Same compact
  ~38 rem two-column dialog, opened from the list or the document it acts on,
  **never a route of its own**. `StockAdjustDialog.vue` is the house pattern. A
  full page is only for a workflow genuinely too large for a modal — POS, a
  multi-line purchase, a stock count sheet.
- **Instant recalculation.** Every derived figure on a transaction screen —
  line total, discount, grand total, paid, due, change, stock effect, party
  balance — updates as the user types, computed in the client from the **same
  `@sher/core-domain` functions the server runs**. Never duplicate the
  arithmetic. The server response confirms what the screen already showed.
- **Unpermitted actions are absent, not disabled** (UI-09).
- The API base URL is read at **runtime** from `/config.json`.
  `import.meta.env.VITE_API_URL` is banned — baking it in forces a per-customer
  frontend build.
- **All assets are self-hosted** — fonts, icons, images. No CDN.
- Bangla helper text is small and muted (`.label-bn`), inline beside the English.
  Where it would crowd a compact surface, use the shared tooltip instead.

---

## 9. Offline and sync

The canonical offline runtime is the **installed PWA**, not a desktop app.

- **One writer per tenant, bound to a browser profile keypair** (D-01) — not to
  a device. A different browser or a cleared profile is a different writer, and
  copying OPFS files does not carry write authority. The partial unique index
  on `device_authorizations` makes `OFFLINE_RW` single-occupancy.
- **Storage engine: SQLite WASM over OPFS, SAH-pool VFS** (D-23). The SAH pool
  is used specifically because it needs **no COOP/COEP headers**, and those
  headers break the Google sign-in flow most shopkeepers use. §6.5's original
  instruction to set them is superseded. **Do not add them back.**
- **Eviction gate (D-24):** PWA installed and `navigator.storage.persist()`
  granted before any offline write.
- **Nothing under `core-application/src/sync/` posts.** `operation-registry.ts`
  maps the thirteen offline operation types onto the same services the online
  controllers call. Idempotency is inherited; every rule is re-checked at replay
  time. This is the module's one architectural rule — a replayed sale obeys the
  rules a counter sale obeys because it *is* a counter sale arriving late.
- **Refusals are quarantined, never auto-discarded.** A closed month, a revoked
  permission or a deleted product stops the operation and puts it in front of a
  person.
- Per-device sale numbering is `S-{YEAR}-{DEVICE}-{SEQ}`. Thirteen document
  tables carry an origin trail; a synced offline sale is an **ordinary posted
  sale** in every respect — same journal, same corrections, counted in every
  report without qualification.
- **Offline sign-in** verifies a PIN against the scrypt hash the snapshot
  brought down. Only the **PIN** hash travels, never the password hash — a
  password opens far more than a till. A user with no PIN simply cannot work
  offline. The browser scrypt implementation is verified to agree with Node's
  (RFC 7914 vector 2 and a live round trip).
- **`outbox` has been written since Phase 0** and nothing read it until Phase 12.
  That is the deliberate exception to YAGNI: a sync engine built later against a
  partial change history cannot reconstruct what it missed. **Do not remove
  outbox writes as unused code.**

---

## 10. Security and authentication

- Password and PIN hashing is **Node's own scrypt**, N=32768 r=8 p=1, parameters
  stored inside the hash string so the cost can be raised without invalidating
  existing credentials. No bcrypt/argon2 dependency.
- **OTP is for signup verification and password recovery only — never daily
  login** (D-07). Daily login is email/phone + password, PIN, or Google.
- Google sign-in uses the **OIDC redirect flow**, verified against Google's JWKS
  with Node's own crypto — not Google's script (UI-06). A verified unknown
  Google email may create a tenant, leaving `password_hash`/`pin_hash` NULL.
- Refresh tokens are **server-stored, rotating and revocable**. A recovery reset
  revokes every session.
- **Step-up is the caller's own password, re-entered. A PIN never satisfies it.**
- **Tokens live in `localStorage`** — a documented trade-off, not an oversight.
- **RLS is on and the tests connect as an unprivileged role**, because a
  superuser bypasses RLS and would make the isolation tests pass against nothing.
- The licence is Ed25519, signed over a **re-canonicalised** payload (not the
  attacker-supplied text) with the format prefix inside the signed bytes. The
  private key never reaches a customer machine and never this repository; it is
  written to `~/.sher/licence-keys/` mode 0600 by `tools/licence`. An
  anti-rollback high-water mark lives **outside** the database and outside the
  backup, so a restore cannot wind the licence clock back.

---

## 11. Database and schema conventions

- Migrations are numbered `.sql` files in `migrations/`, applied in **filename
  order**, each in its own transaction, recorded in `schema_migrations` by full
  filename. Two files may share a numeric prefix (0039 does); ordering between
  them is then decided by the text after the underscore, so **do not create a
  duplicate prefix where order matters**.
- Standard columns on every table: `id` (ULID), `tenant_id`, `created_at`,
  `updated_at`, `created_by`, `updated_by`, `deleted_at`.
- No `FLOAT`, no `NUMERIC` for money or quantity — integers in minor units, and
  the same rule applies to the SQLite dialect so online and offline can never
  diverge numerically.
- Document numbering is per tenant and concurrency-safe (§3.7, D-30).
- New **permission codes are backfilled onto existing tenants by a script**
  (`dist/backfill-seed-roles.js`), not by a migration, because ULIDs must come
  from application code. **Forgetting it hides the whole new module from the
  sidebar** — UI-09 removes any entry whose permission is missing, so the
  feature looks unbuilt.

---

## 12. Deployment

- Single business, on-premise or small VPS. PostgreSQL 16 in Docker
  (`sher-pg`), API from compiled `dist`, web served as static files from its own
  origin (nginx, §6.5).
- **The API runs from `dist`, not from source.** A change in a workspace package
  is invisible until those packages are rebuilt.
- Boot validation refuses unsafe combinations before serving (§4.4), and the
  schema-version gate refuses a database that does not match the build.
- Entitlement defaults to `license`, so an installation that lost a line from
  its environment file degrades to a visible READ_ONLY asking for a key — never
  to unlimited trading on the permissive stub.
- **No deployment artefacts are tracked** — there is no Dockerfile, compose file
  or nginx config in the repository. See `docs/NEXT_TASKS.md`.

**External services:** Google OAuth (sign-in, optional). No SMS provider has
been chosen — `IDENTITY_VERIFIER=otp` throws by design rather than pretending.
Nothing else.

**Environment variable NAMES** are documented with their meanings and defaults
in `apps/api/.env.example`. Required: `DATABASE_URL`, `JWT_SECRET`. Everything
else has a default. Never commit a filled-in `.env`.

---

## 13. Commands

```bash
# Setup
nvm use                                   # Node 20, per .nvmrc
pnpm install
docker start sher-pg                      # PostgreSQL 16; sher_dev + sher_test

# The four gates — run these, every time
pnpm build
pnpm typecheck                            # 9 projects, incl. vue-tsc over templates
pnpm lint
pnpm test:boundaries                      # layering — never bypass

# Tests — see the protocol note below before running these
pnpm test

# Development
pnpm --filter "@sher/api..." build         # the API runs from dist
cd apps/api && node --env-file=.env dist/migrate.js
node --env-file=.env dist/backfill-seed-roles.js   # NEW PERMISSIONS — easy to forget
node --env-file=.env dist/main.js &        # :3000 — .env is NOT auto-loaded
cd ../web && pnpm dev &                    # :5173

# Licence operator tooling (never run on a customer machine)
pnpm licence:keygen -- …
pnpm licence:issue  -- …
```

**On `pnpm test`:** `AGENTS.md` R-0 tells agents not to run the suites and never
to write new test files — the owner verifies each module by driving the running
app himself, and that walkthrough is the acceptance gate. Since 2026-08-26 he
asks for the existing suites to be run **once, at a module gate**. Updating a
guard test that a legitimate change invalidated (for example the route list in
`apps/web/test/navigation-architecture.spec.ts`) is maintenance, not new
test-writing. **Writing a new test file requires the owner asking for it in the
current conversation.**

---

## 14. Important files

| Path | Why it matters |
|---|---|
| `packages/shared-utils/src/clock.ts` | The only file allowed to construct a `Date` |
| `packages/core-domain/src/` | Costing, posting rules, `saleTotals` — shared by server and till |
| `packages/core-contracts/src/permissions.ts` | The permission catalogue; seed roles derive from it |
| `packages/core-contracts/src/modules.ts` | Licensable module codes and unwind permissions |
| `packages/core-application/src/sync/operation-registry.ts` | The thirteen offline operation types → the online services |
| `packages/core-application/src/sync/replay-service.ts` | Decides what may be tried and what is quarantined; posts nothing |
| `packages/adapter-postgres/src/migrator.ts` | How migrations are ordered and recorded |
| `packages/adapter-sqlite-wasm/src/local-database.ts` | The SAH-pool decision, recorded beside the code |
| `apps/api/src/deployment/` | Boot validation, licence, read-only guard, schema gate |
| `apps/web/src/components/shell/navigation.ts` | The single source for both sidebar frames |
| `apps/web/src/design/components.css` | `.field`, `.label-bn`, `.btn-ghost`, `.btn-primary` |
| `tools/boundaries/` | The layering checker |

---

## 15. Safe places to work next

- New **report** screens over existing journal and movement data (derive, never
  store).
- New **expense categories**, settings and master-data screens — Class M writes.
- **UI polish** inside an existing screen that follows the established pattern.
- **Deployment artefacts** — Dockerfile, compose, nginx — there are none, and
  adding them touches no business logic.

## 16. Decisions a future agent must NOT casually redesign

Each of these was decided deliberately, and reversing one silently breaks
something a shopkeeper depends on. `docs/DECISIONS.md` gives the full reasoning.

- **The closed account list.** Needing a new account is a **stop and report**.
- **Append-only corrections.** Never mutate or delete a posted document.
- **Integer money and quantity.** Never introduce a float.
- **`tenant_id` from `TenantContext` only**, and 404 for cross-tenant.
- **The `Clock` port.** Never an ambient `new Date()`.
- **The layering direction**, and `core-domain` / `core-application` staying
  browser-safe. The till and the server must share arithmetic.
- **Nothing under `sync/` posts.** Replay goes through the online services.
- **Quarantine, never auto-discard**, for a refused offline operation.
- **No COOP/COEP headers** — the SAH-pool VFS exists so Google sign-in survives.
- **`outbox` writes stay**, even where nothing reads them.
- **The `@primeuix/styles` 1.0.3 pin** in the root `pnpm.overrides`. Bumping it
  reintroduces unstyled, chevron-only PrimeVue controls.
- **`ENTITLEMENT_SOURCE` defaults to `license`.** A missing env line must
  degrade to READ_ONLY, never to unlimited trading on the SaaS stub.
- **The owner's working protocol (R-0)** — no new test files, questions one at a
  time, `START` before code, a UI manual at the end.
