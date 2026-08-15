# Implementation Roadmap

Sequence rationale is in `MODULE_DEPENDENCY_MAP.md` §4. Durations are indicative for one owner + AI agents working full-time; treat as relative sizing, not commitments.

## Phase Table

| Phase | Name | Contents | Exit criteria | Size |
|---|---|---|---|---|
| **0** | Foundation kernel | Monorepo, packages, CI + boundary checks, ULID/Money/Qty, TenantContext, error codes, business-specific repository interfaces, migrations, seed, test harness, **interfaces**: Permission, Entitlement(stub), Settings, Audit, Numbering, Outbox, Posting, Idempotency, Clock | Empty vertical slice (`/health`, one dummy entity) passes all CI gates incl. cross-tenant + idempotency tests | L |
| **1** | Tenant, Auth, Users, Roles, Settings, Audit | M01, M02, M26(core), M27, **deployment-mode providers (D-21/22/23/24)**: `IdentityVerifier`, `TenantProvisioner`, `EntitlementProvider`, license state machine, boot-time config validation | Owner can register via OTP, create users/roles, change settings; every change audited. **Both** `saas-smoke` and `onprem-smoke` CI gates green; registration returns 404 in single-tenant mode | L |
| **2** | Master data | M04 Product/brand/category/unit, M05/M06/M07 Parties (unified) | Products and parties CRUD + search + permissions + offline-safe schema | M |
| **3** | Inventory core | M12 movements/balances, M13 lots + costing (FIFO/AVG/LIFO-valuation), opening stock, negative-stock policy, **posting kernel live** | Opening stock posts movements + journal; invariants INV-01..05 green | L |
| **4** | Money accounts | M19 cash + POS session, M20 bank accounts | Cash/bank accounts with opening balances and statements | M |
| **5** | Purchase vertical | M10 purchase + payment + supplier ledger view (M18), returns-ready | S-01 partial: purchase → stock → lot → payable → payment → ledger → cash, all manual-tested | L |
| **6** | Sales vertical | M08 POS/sales, M09 invoice + payments + **sale templates (D-26)**, M17 customer ledger view | Full S-01 core cycle passes manually; POS performance budget met | XL |
| **7** | Corrections & adjustments | M16 returns, M15 reconciliation, M22 expenses, void/reverse/backdate + **PeriodGuard enforcement (D-25)** | S-05, S-06, S-09, S-11, S-13, S-14 pass; locked-period write returns `PERIOD_LOCKED` | L |
| **8** | Purchasing extras | M11 purchase orders, M14 landed cost, M07 consignment sales flow, M23 warranty/serial | S-07, S-08 pass | M |
| **9** | Reporting | M24 reports, M25 dashboard, **M32 Daybook (D-27)**, explainability, exports/printing (M29 print part) | Report numbers reconcile to journal + movements (INV-10); **Daybook totals equal Reports totals**; day-end print verified | L |
| **10** | SaaS layer | M03 subscription/entitlements real, M30 tenant lifecycle + `.sherdb` backup/restore, M29 SMS wallet + bKash top-up | S-20 passes; entitlement gating verified per feature | L |
| **11** | Bank reconciliation | M21 import/match/reconcile + review on later edits | S-12 passes | M |
| **12** | Offline | M28 future offline sync engine + Tauri desktop + device authority + local SQLite backup | S-17, S-18, S-19 pass; offline day equals online result exactly | XL |
| **13** | Mobile | Expo app over REST (online-only) | Core POS + reports on mobile | L |
| **14** | AI/MCP | MCP server, read tools then gated write tools | AI actions audited, permission-bound, explainable | M |
| **15** | Reusable core extraction | Package hardening for future SaaS products | Core packages published internally, one sample reuse | M |

## Critical Path

`Phase 0 → 1 → 2 → 3 → 5 → 6 → 7 → 9 → 12`. Phases 4, 8, 10, 11 can absorb slippage; 13/14 are strictly after 12.

## Gate Reviews (Product Owner sign-off required)

| Gate | After | Question answered |
|---|---|---|
| G1 | Phase 0 | Is the skeleton safe for AI agents to build on? |
| G2 | Phase 3 | Is inventory + costing correct on real data? |
| G3 | Phase 6 | Is the core business cycle correct end-to-end? |
| G4 | Phase 9 | Do reports match reality? |
| G5 | Phase 12 | Does offline produce identical results to online? |

**Final decisions are already recorded in `OPEN_DECISIONS.md`. Phase 0 must establish business-specific repository interfaces and the Drizzle + PostgreSQL implementation boundary. Phase 3 must implement the already-decided costing, tax and Product + Location rules. Full SQLite implementation remains a future offline phase; V1 temporary browser offline support uses IndexedDB.
