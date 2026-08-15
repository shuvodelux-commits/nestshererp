# Status Ledger — FINAL / RECOMMENDED / HIGH-RISK

## 1. CONFIRMED / FINAL (SRS + verified owner decisions — implement as written, do not redesign)

| Area | Item |
|---|---|
| Strategy | V1 Online PostgreSQL → temporary browser IndexedDB support → future full SQLite/Tauri offline → Mobile → MCP |
| Architecture | Modular monolith; UI → Application → Domain → Persistence adapter |
| Stack | Vue 3 + Vite + TS · NestJS · Drizzle · PostgreSQL · future SQLite · Tauri · Expo · REST+OpenAPI · MCP |
| Tenancy | Tenant isolation, server-side authz, RBAC, audit logging on every protected operation |
| Auth | Mobile number → OTP → account → trial |
| Entitlement chain | Plan → Feature → Setting → Permission → Access |
| Product | Brand and name separate; display = Brand + Name; different purchase prices create lots, not duplicate products |
| Inventory | Lot tracking; FIFO/Average/LIFO configurable; movements carry product, lot, qty, source, dates, user, cost; no silent mutation |
| Landed cost | V1 allocation by purchase value / quantity / manual; original cost traceable |
| POS | Fast search, barcode, filters, walk-in customer, multi-payment, configurable negative stock, vendor/consignment sourcing with vendor payable |
| Ledgers | Statement with running balance; default reporting by transaction date; created date kept for audit; configurable terminology without changing semantics |
| Cash | Opening cash mandatory; expected = opening + in − out; session-state based |
| Returns | Sales + purchase returns with original reference, lot, disposition, ledger and cash effects |
| Audit | Edit/update/delete/backdate/correct/reverse/cancel are allowed **and** always auditable; ON TIME / LATE ENTRY / BACKDATED / CORRECTED indicators |
| Offline | V1 temporary browser IndexedDB support; future full SQLite offline with one designated read/write device and auditable transfer |
| Sync | Idempotent, retryable, resumable, observable, conflict-aware, secure; never silently overwrite |
| SaaS | Encrypted `tenantname.sherdb` export/import; close account and return later |
| SMS | Prepaid credits, bKash top-up flow with verification |
| MCP | Only via application services, respecting permissions, tenant isolation, validation, audit |
| Quality | Automated tests + AI review + **manual real-transaction acceptance** before any module is complete |

## 2. RECOMMENDED (my additions — additive, no confirmed requirement removed)

| # | Recommendation | Rationale |
|---|---|---|
| A1 | Internal double-entry posting kernel behind the existing simple ledgers | Makes stock/cash/party/expense numbers provable; user-facing behaviour unchanged |
| A2 | ULID PKs generated at the write site | Offline records need valid IDs before reaching the server |
| A3 | Integer minor-unit money + scaled integer quantity | SQLite has no decimal type; prevents ledger drift |
| A4 | Append-only movements/journal + recomputable derived balances | Enables verification and repair |
| A5 | `operation_id` idempotency on every mutation | One mechanism serves retries, sync and MCP |
| A6 | Unified `parties` table with role flags | Removes customer/supplier/vendor/employee duplication; enables "salary to Belal" ledger |
| A7 | Framework-free `core-domain` package + CI boundary enforcement | The only way "one rule set, two databases" survives contact with AI agents |
| A8 | Future Tauri = local Node/NestJS process running the shared application logic (D-20) | Turns full offline into a deployment mode instead of a second product |
| A9 | Soft period lock with unlock permission | Bounds retroactive edits without removing the freedom |
| A10 | Reserve `location_id`, tax fields, `pack_size`, `credit_limit` now | Cheap now, schema-wide rewrite later |
| A11 | Device-prefixed numbering series | Prevents duplicate invoice numbers online vs offline |
| A12 | Server re-executes synced operations through application services and posts cost true-ups on divergence | Client-computed money is never trusted |
| A13 | Opening-balance workflows (stock, party, cash, bank) | Required to onboard a real running business |
| A14 | Golden invariant assertions in every money/stock test | Turns integrity from a hope into a build gate |
| A15 | Settings + Audit built in Phase 1; Cash/Bank before payments; Purchase before Sales | Dependency-correct order; avoids rework |

## 3. FINAL DECISION REGISTER

D-01 through D-24 are finalized in `OPEN_DECISIONS.md` and `OPEN_DECISIONS_User_note.md`. They are implementation constraints, not pending questions.

D-25 → D-32 close the implementation mechanics found open during the pre-build sweep: period lock ownership (`PeriodGuard`, not a module), invoice templates, Daybook as M32, mobile = PWA for V1, UTC storage with tenant-local `business_date`, document numbering, rounding (unit cost at scale 4), and concurrency (pessimistic locks on lot consumption).

D-21 (identity verification), D-22 (tenant provisioning), D-23 (entitlement source) and D-24 (license term/expiry) govern the SaaS vs on-premise deployment modes. **One build, two modes selected by configuration — never a code fork.** All four affect Phase 1 and must be implemented before M02 Auth is built. Detail in `11_DEPLOYMENT_STRATEGY.md`.

Most important for architecture: V1 uses Drizzle + PostgreSQL; business-specific repository interfaces are mandatory; the shared Domain/Application layer contains business logic; a future Drizzle + SQLite repository implementation must be possible without changing that business logic; V1 temporary browser offline support uses IndexedDB.

## 4. HIGH-RISK (top items from `RISK_REGISTER.md`)

| Risk | Why it is top-tier |
|---|---|
| R-01 Retroactive re-costing under backdating/edit freedom | Silently changes reported profit; hardest bug class to detect after the fact |
| R-03 Business logic leaking into NestJS/Drizzle | Would quietly make the offline requirement unachievable |
| R-02 Sub-ledgers without a posting kernel | Unprovable financial numbers |
| R-05 Float money on SQLite | Guaranteed cent-level drift |
| R-07 AI agent scope creep | The main day-to-day threat to a non-programmer-owned codebase |
| R-19 Silent acceptance of wrong AI work | Manual scenarios with pre-written expected numbers are the only real defence |
| R-04 Dual-writer conflicts if D-01 is answered permissively | Structural, not fixable later |
| R-21 No period close | Unlimited retroactive change surface |
