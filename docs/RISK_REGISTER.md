# Risk Register

Scoring: Likelihood (L) × Impact (I), 1–5. Priority = L×I.

| ID | Risk | L | I | P | Mitigation | Owner | Trigger to escalate |
|---|---|---|---|---|---|---|---|
| R-01 | **Retroactive re-costing**: editing/backdating purchases silently changes COGS of already-reported sales | 5 | 5 | 25 | Defined recompute policy + `COST_TRUE_UP` postings + period lock + "cost adjustments" report (C-02, D-19) | Arch | Any margin report mismatch |
| R-02 | **Sub-ledgers without a posting kernel** drift; profit unprovable | 4 | 5 | 20 | Journal backbone from Phase 3 + INV-01..06 on every write test | Arch | First unexplained balance difference |
| R-03 | **Business logic leaks into NestJS/Drizzle**, making offline a second implementation | 5 | 5 | 25 | Package boundaries + CI dependency check + AI rule R-D + PR checklist | CI | One boundary violation merged |
| R-04 | **Dual-writer conflicts** if D-01 is answered as "both write" | 3 | 5 | 15 | Adopt single-writer V1; quarantine, never auto-merge financial docs | Owner | Any request to relax D-01 |
| R-05 | Float/decimal money errors on SQLite | 4 | 5 | 20 | Integer minor units frozen in Phase 0 + lint ban on floats in money paths | Arch | Any `number` money field found |
| R-06 | Duplicate invoice numbers online vs offline | 4 | 4 | 16 | Device-prefixed numbering series, mandatory when offline enabled | Arch | Any duplicate observed |
| R-07 | AI agent scope creep (refactors unrelated modules, changes confirmed rules) | 5 | 4 | 20 | Scoped prompts, "do not modify" lists, small PRs, review AI, spec-diff check | Owner | Any PR touching >1 module |
| R-08 | Cross-tenant leak through a forgotten `where tenant_id` | 3 | 5 | 15 | Business-specific repository scoping + PostgreSQL RLS + per-module isolation tests | Sec | Any raw SQL in a module |
| R-09 | Offline device theft exposes full tenant data | 3 | 4 | 12 | Encrypted local DB, OS keychain, license expiry, revocation, remote-wipe flag | Sec | Reported loss |
| R-10 | Backup passphrase loss ⇒ permanent data loss | 4 | 4 | 16 | Explicit warning UX, optional escrow (D-15), export verification step | Owner | First support case |
| R-11 | Restore used to bypass plan limits | 3 | 3 | 9 | Entitlement re-evaluation on restore (D-08) | Product | — |
| R-12 | SMS top-up fraud via fake bKash trx ids | 4 | 3 | 12 | No credit before verification, unique trx id, audit, rate limit (D-16) | Product | >2 disputed top-ups |
| R-13 | OTP cost + SIM-swap takeover | 4 | 4 | 16 | Rate limits, PIN/password for elevated actions (D-07), device binding | Sec | Abnormal OTP volume |
| R-14 | POS performance degradation as catalogue/history grows | 3 | 4 | 12 | Keyset pagination, trigram index, derived balances, perf budgets in CI | Arch | p95 > budget |
| R-15 | Report numbers disagree with ledger | 3 | 5 | 15 | Reports read from journal/movements only; INV-10 reconciliation test | QA | Any disagreement |
| R-16 | Schema migration bricks an offline device | 3 | 4 | 12 | Auto-backup before migration, transactional migration, rollback path, version window | Arch | Any failed device migration |
| R-17 | Tauri sidecar packaging/lifecycle problems (D-20) | 3 | 3 | 9 | Spike in Phase 11, fallback to option B | Arch | Spike failure |
| R-18 | Scope explosion (tax, multi-location, payroll requested mid-build) | 4 | 3 | 12 | Reserved fields now, explicit V1 boundary, OPEN_DECISIONS gate | Owner | Any mid-phase scope request |
| R-19 | Owner is not a programmer ⇒ silent acceptance of wrong AI work | 4 | 5 | 20 | Manual scenario scripts with expected numbers, invariant dashboards, review AI | Owner | Any module accepted without manual scenarios |
| R-20 | Vendor/consignment accounting modelled wrong (stock owned vs held) | 3 | 4 | 12 | Vendor stock excluded from owned inventory valuation; separate payable account; S-07 tests | Arch | Valuation includes vendor stock |
| R-21 | Period never closed ⇒ unlimited retroactive edits | 4 | 4 | 16 | Soft period lock + unlock permission + audit (C-03) | Owner | First reopened month |
| R-22 | Bank reconciliation invalidated by later edits | 3 | 3 | 9 | Reconciled rows flagged; edits raise review, never silent (SRS §31) | Arch | — |
| R-23 | Test suite slowness ⇒ agents skip tests | 3 | 4 | 12 | Fast domain tests, parallel integration, CI required checks, ban on skipping | CI | Any `.skip` in main |
| R-24 | Sync quarantine backlog nobody resolves | 3 | 4 | 12 | Visible counter, blocking banner, weekly review, alerting | Owner | Backlog > 20 |
| R-25 | **On-premise build forked from SaaS build** ⇒ two codebases, 31 modules maintained twice | 4 | 5 | 20 | Mode is configuration only (D-21/22/23); both modes smoke-tested in CI; boundary check bans SMS/entitlement imports outside M02 | Arch | Any `if (onPrem)` branch outside the three provider implementations |
| R-26 | On-premise support load stalls module development | 4 | 4 | 16 | Cap at 2–3 customers until V1 stable; diagnostic bundle export; published version support window | Owner | 4th on-prem contract signed before Phase 12 |
| R-27 | On-prem upgrade bricks a customer's live database | 3 | 5 | 15 | Mandatory pre-migration `pg_dump` with abort-on-failure, forward-only migrations, schema-version boot gate, auto-rollback on failed health check | Arch | Any upgrade requiring manual DB repair |
| R-28 | Frontend API URL baked in at build time ⇒ per-customer builds | 3 | 4 | 12 | Runtime `/config.json`; CI asserts no `VITE_API_URL` in bundle | Arch | Any customer-specific frontend build |
| R-29 | SaaS deployed with `IDENTITY_VERIFIER=none` (misconfiguration) | 2 | 5 | 10 | Boot-time config validation refuses invalid combinations; CI `invalid-config` gate | Sec | Any environment starting without verification |
