# MOD-002 — full implemented-module QA gate

> **Scope:** HisabIQ catalog masters + product management, source at `chore/hisabiq-adoption-runtime-a01`.
> **Owner rule (2026-11-13):** test → run → fix → rerun → review → merge → continue.
> No production DB; disposable PostgreSQL16 `sher_test` with unprivileged `sher_app` and FORCE RLS.
> An infinite set of all conceivable inputs is impossible; the finite, source-derived decision and boundary matrix below is the enforceable quality gate.
> **Not a completion certificate for the whole React Products module.** Unimplemented features are blockers, not fake test passes.

## Evidence hierarchy

1. Accepted implementation: `apps/api/src/catalog/{catalog.controller,catalog-metadata-v1.controller,products.controller}.ts`; core-application catalog services, contracts and PostgreSQL adapters.
2. Existing production-style contract tests: `apps/api/test/{catalog,catalog-metadata-v1,catalog-metadata-v1-create,products,inventory}.spec.ts`.
3. Added separate tests:
   - `mod002-catalog-contract-gate.spec.ts` — HTTP validation, Bangla/Unicode, legacy parity, nested categories, deleted IDs, nonfinancial side effects.
   - `mod002-catalog-transaction-gate.spec.ts` — signed JWT/live permissions, two-tenant RLS, audit/outbox event contents, concurrent CAS, all-kind rollback, concurrent duplicate CREATE.
   - `mod002-product-link-gate.spec.ts` — actual Product creation with metadata master IDs, safe rename/archive/foreign/deleted references, unchanged quantity/cost, cost blind, idempotency.
4. Source-generated coverage index: `pnpm test:inventory`; claims are **upper bounds**, not proof of assertion quality.
5. Release gate: exact-head GitHub CI `pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test:boundaries`, `pnpm test:inventory -- --check`, `pnpm test` with PG16, and `pnpm test:e2e` including Playwright Chromium.
6. Review actual failures and mutation side effects; never delete a failing assertion to produce green CI.

## Implemented-path scenario matrix

| Area | Required scenarios | Evidence |
|---|---|---|
| Master read | Anonymous 401; PRODUCT_VIEW gate; live role revocation; exact legacy GET shape vs strict metadata-v1 with nullable metadata and version; empty second tenant | existing catalog/metadata tests + new contract/transaction |
| Unit/brand/category create | Valid canonical name, NFC Bangla, symbol unit-only, trimming/whitespace, explicit null/omitted metadata, version 1, stable server ULID | existing metadata-create + new contract/transaction |
| Invalid create | Blank/missing/oversize/type-invalid names; too-long/blank/whitespace symbol; oversize/blank Bangla; unrecognized tenant/user/version/active/conversion/price/parent fields | new contract |
| Names and hierarchy | Tenant-scoped case-insensitive duplicates; sibling-scoped category duplicates; two distinct roots with same child label; missing/foreign parent 404; max depth two; SQL uniqueness under concurrent requests | existing catalog/metadata-create + new contract/transaction |
| Security | No JWT, tenant A/B isolation for reads/creates/PATCH, foreign IDs masked as 404, post-issuance revocation for each manage permission and PRODUCT_VIEW | existing suites + new contract/transaction |
| Atomic CREATE | One existing master-row INSERT with English+Bengali data; matching CREATE audit/outbox exactly once; synthetic outbox failure rolls back row + audit + event for all kinds | existing create + new transaction |
| Atomic metadata PATCH | CAS expectedVersion positive, stale 409, concurrent same-version race one winner, omitted field preserves, explicit null clears, no English rename, no category move, no unauthorized fields | existing metadata + new contract/transaction |
| Legacy compatibility | Legacy name-only rename leaves Bangla/symbol untouched, increments version, metadata-only changes do not leak into name-only clients; deleted/archived masters not offered for fresh selection | existing catalog + new contract/product-link |
| Product relations | Real unit/brand/category IDs from bilingual creates accepted, canonical Product name and display name, category parent lookup, cost minor integer, stock starts at 0 | existing products + new product-link |
| Product lifecycle | Real Product must reject foreign or removed masters; previously referenced master can be archived while historical Product source stays readable; brand rename retains immutable Product ID/version | existing products + new product-link |
| Product security | COST_VIEW revoked after token issue hides purchase cost and stock valuation, tenant product isolation, product-view/create/edit/deactivate/delete permissions distinct | existing products + new product-link |
| Product writes | Idempotency replay and key mismatch, barcode/SKU uniqueness, conversion pair valid/invalid and positive factors, sale price and discount bounds, features OFF refusals, stale Product version, delete once stock exists | existing products and inventory suites + new product-link |
| Stock integrity | Catalog metadata writes create no journal/stock/cash entries; opening stock, damaged/found adjustment, idempotency, account posting, cost omission, stock-history deletion guard | existing inventory + new contract/product-link |
| Search and listing | Product name+brand, category parent, keyset paging, linked filters, numeric/string/null sorting, cost-view protected sorting | existing products |
| Client and UI | Legacy/metadata protocol decoders, immutable/strict client responses, Product Settings projection parity gate and no activation without every UI action | merged frontend tests; frontend #519 separate draft |
| Regression | All repo unit, PG16 API and browser Playwright acceptance must be green on exact head and generated matrix current | GitHub CI, not a test author's claim |

## Explicit BLOCKED / not falsely counted as implemented

- HisabIQ multilevel conversion graph with **independent per-unit prices**, mixed entered quantities, exact snapshots and pricing across POS/purchase; old backend supports one optional conversion only.
- Bundle component stock depletion and historical bundle-price/version behavior; no verified completed server contract.
- Connected Product Settings activation: usage counts, reversible Active/Inactive, unit Base/Compound-ready classification, real categories hierarchy/parent moves and missing editor UX parity.
- Atomic canonical-English + Bangla edit is separately being designed under backend PR #112; no two-request pseudo-atomic rename/PATCH.
- Product advanced photo, serial, warranty, expiry, lot offer and historical correction workflows require their own cross-module test partitions; passing catalog tests does not certify them all.
- Frontend MOD-002 native React→Nest authenticated route cutover and mobile/keyboard/touch QA is separate and **not** approved by a backend-only test gate.
- Product stock/purchase/returns and journal effects belong to integrated modules; this gate cannot certify sale/purchase posting, cash sessions or finance.

## Mandatory merge decision

1. Record exact baseline and PR head; do not overwrite concurrently owned PR #112 (contracts) or frontend PR #519 (projection).
2. Check the full matrix and execute real PG16 tests via disposable CI; use only generated inventories.
3. On RED: identify asserted requirement, inspect source, fix root cause in a distinct scoped patch or a documented isolated fix PR; rerun failing and full suites, including lint/typecheck.
4. Require exact-head GitHub CI verify + acceptance green, no unreviewed release bypass.
5. Merge approved, isolated, green scope; record merge SHA and any remaining BLOCKED entries.
6. Only move to the next approved module slice after a new test matrix is in place. **A green test suite does not authorize production migration or UI cutover.**
