# Module 13 — Inventory Lots & Costing
**Phase:** 3 · **Depends on:** 04, 12, 26 · **Offline class:** Full · **Status:** FULL / READY
**Final decisions:** D-05 (stock vs valuation separation), D-17 (Product + Location costing), D-19 (negative-stock costing). C-02 re-costing policy is treated as an implementation rule for this module.
**This is the highest-risk module in the product. Read `RISK_REGISTER.md` R-01 before implementing.**

## 1. Purpose
Own the cost of goods: lot creation, lot consumption order, valuation method (FIFO / Average / LIFO), actual cost after landed cost, and the re-costing behaviour when history is edited or backdated.

## 2. Requirements
| ID | Requirement | SRS | Status |
|---|---|---|---|
| R13.1 | Lot: creation, quantity, remaining quantity, purchase cost, actual cost, supplier/vendor, source transaction, transaction date, created date, expiry, serial linkage | §23 | CONFIRMED |
| R13.2 | Costing options FIFO / Average / LIFO | §23 | CONFIRMED |
| R13.3 | Default inventory calculation method configured in Product-related Settings | §23, §36 | CONFIRMED |
| R13.4 | Physical stock issue rules and valuation method remain conceptually separate | §23 | CONFIRMED → D-05 |
| R13.5 | Different purchase prices create separate lots | §14, §20 | CONFIRMED |
| R13.6 | Actual cost = purchase cost + allocated landed cost; original purchase cost stays traceable | §24 | CONFIRMED |
| R13.7 | Re-costing policy for backdated/edited/voided stock documents | — | **MISSING in SRS (C-02)** — must be decided |

## 3. Dependencies
Products (04), stock movements (12), settings (26), posting kernel. Consumed by 08, 09, 10, 14, 15, 16, 24, 25.

## 4. Database Entities
| Table | Key columns |
|---|---|
| `inventory_lots` | `id`, `tenant_id`, `product_id`, `location_id`, `owner_type`(OWNED/VENDOR), `vendor_party_id?`, `supplier_party_id?`, `source_document_type`, `source_document_id`, `qty_received`, `qty_remaining`, `purchase_unit_cost`, `landed_cost_total`, `actual_unit_cost`, `posting_date`, `created_at`, `expiry_date?`, `status`, `version` |
| `lot_consumptions` | `id`, `movement_id`, `lot_id`, `qty`, `unit_cost_used`, `document_type`, `document_id`, `posting_date` |
| `cost_adjustments` | `id`, `product_id`, `lot_id?`, `reason`(BACKDATE, EDIT, LANDED_COST, SYNC_TRUE_UP, NEGATIVE_STOCK_TRUE_UP), `document_ref`, `amount`, `posting_date`, `created_at`, `created_by` |
| `product_cost_state` | `(tenant_id, product_id, location_id)`, `avg_unit_cost`, `qty_on_hand`, `last_recomputed_at` (derived cache for Average method) |

## 5. Relationships
`inventory_lots 1—N lot_consumptions` · `lot_consumptions N—1 stock_movements` · `inventory_lots N—1 products` · lots created by purchases, opening stock, positive adjustments and sales returns.

## 6. Domain Rules
| ID | Rule | Notes |
|---|---|---|
| DR13.1 | `qty_remaining` = `qty_received` − Σ consumptions + Σ restorations. The cached column must always equal the computed value (INV-02) | |
| DR13.2 | Lot selection (physical issue) order = **expiry ASC (if tracked), then posting_date ASC, created_at ASC, id ASC** — i.e. FIFO/FEFO regardless of valuation method (D-05 option A) | |
| DR13.3 | Valuation method (FIFO / AVG / LIFO) determines the **unit cost recorded on the consumption**, not which physical lot is issued | |
| DR13.4 | FIFO: unit cost = the consumed lot's `actual_unit_cost`. AVG: unit cost = `product_cost_state.avg_unit_cost` at the moment of the movement. LIFO: unit cost = the newest available lot's `actual_unit_cost` at that moment | |
| DR13.5 | AVG recalculation on receipt: `new_avg = (qty_on_hand*avg + qty_in*unit_cost) / (qty_on_hand + qty_in)`, computed in integer minor units with documented rounding (round-half-up at scale 4; remainder to `ROUNDING` account) | |
| DR13.6 | Changing the costing method is only allowed with `settings.manage` **and** only from the start of an open period; existing history is never retroactively revalued | |
| DR13.7 | Negative stock (if enabled): consumption uses a provisional cost (last known cost, else product default, else 0) and creates a `NEGATIVE_STOCK_TRUE_UP` obligation; when a real lot arrives, the difference is posted as a cost adjustment (D-19) | |
| DR13.8 | Landed cost changes `actual_unit_cost`; already-consumed quantities get a `LANDED_COST` cost adjustment posted to COGS on the landed-cost document's date, never a silent rewrite of past COGS lines | |
| DR13.9 | **Re-costing policy (C-02):** a backdated or edited stock-in document triggers *recompute-forward* for the affected `(product, location)` from the changed date to today, **within open periods only**. Differences are posted as `cost_adjustments`; original consumption rows are preserved with `superseded_by` links | |
| DR13.10 | Vendor-owned lots (`owner_type=VENDOR`) are excluded from owned inventory valuation and from COGS; selling them creates vendor payable instead | |
| DR13.11 | A lot can never go negative; a lot with `qty_remaining=0` is `CLOSED` but retained forever | |
| DR13.12 | Cost values are never trusted from a client (offline device or API); the server recomputes at replay (see `SYNC_PROTOCOL.md` §4) | |

## 7. Application Services
| Service | Responsibility |
|---|---|
| `CreateLotService` | Called by purchase/opening-stock/positive adjustment/sales return |
| `ConsumeStockService` | Selects lots (DR13.2), computes cost (DR13.3/4), writes movements + consumptions + COGS journal lines |
| `RestoreStockService` | Sales return / void — restores into the original lot when identifiable, else a new lot at the original cost |
| `RecomputeCostService` | Recompute-forward for a `(product, location, from_date)`; idempotent; emits cost adjustments |
| `ApplyLandedCostService` | Called by Module 14 |
| `GetValuationService` | Stock valuation report input |
| `VerifyLotIntegrityService` | INV-02/03 checker, used by tests, jobs and `/admin/verify` |

## 8. API Endpoints
`GET /lots?product_id=&status=` · `GET /lots/{id}` (with consumptions) · `GET /products/{id}/cost-state` · `GET /valuation?as_of=&method=` · `POST /admin/recompute-cost` (`inventory.cost.recompute`) · `GET /cost-adjustments`.

## 9. Permissions
`inventory.cost.view` (all cost fields), `inventory.cost.recompute`, `inventory.lot.view`, `settings.manage` (method change), `finance.period.unlock` (recompute across a closed period).

## 10. UI Screens
Lot list per product (received, remaining, cost, actual cost, expiry, source) · Lot detail with consumption history · Valuation report · Cost adjustments list ("why did my cost change?") · Costing method setting with a warning dialog.

## 11. UI Components
`LotTable`, `LotBadge` (expiry/near-expiry), `CostBreakdownPopover` (purchase cost + landed cost = actual cost), `CostAdjustmentTimeline`, `CostingMethodSelector`.

## 12. Validation
Quantities > 0 · costs ≥ 0 · expiry ≥ posting date (warn if past) · method change blocked mid-period · recompute range must be within open periods unless unlocked.

## 13. Audit
Lot created (with source) · lot cost changed (landed cost, true-up) · costing method changed (old → new, effective date, reason) · recompute executed (range, affected products, total adjustment amount) · negative-stock provisional cost used · sync cost divergence.

## 14. Reports
Stock valuation (by method, as-of date) · Lot ageing / near expiry · Cost adjustment report · COGS by period · Provisional-cost exposure (blocks profit display per D-06) · Margin per product/sale (requires `inventory.cost.view`).

## 15. Offline Requirements
Full offline lot creation and consumption using the same services against SQLite. The device stores lots and cost state locally; it computes costs identically but **the server's recomputation is authoritative on sync** (DR13.12).

## 16. Synchronization
- Lots created offline arrive with their operation; the server re-derives `actual_unit_cost`.
- Consumptions are recomputed server-side in `posting_date, created_at, id` order.
- Divergence between device cost and server cost ⇒ `SYNC_TRUE_UP` cost adjustment + a row in the "Cost adjustments after sync" report. Never silently dropped, never blindly accepted.
- Device pulls resulting adjustments and recomputes local cost state.

## 17. Testing
**Fixture-driven, with hard-coded expected numbers** (`costing_fixture`):
| Test | Expectation |
|---|---|
| FIFO across 3 lots | Exact COGS per line, exact remaining quantities |
| Average after 3 receipts + 2 issues | Exact avg to scale 4, rounding remainder posted |
| LIFO valuation with FIFO physical issue | Physical lots consumed oldest-first; cost taken newest-first; INV-02 still holds |
| Backdated purchase inserted before existing sales | Recompute-forward produces the documented adjustments; closed periods untouched |
| Landed cost after partial sale | Remaining lot revalued + adjustment for sold portion |
| Negative stock sale then receipt | Provisional cost, then true-up equals the difference |
| Void of a sale | Stock restored to the original lot, COGS reversed exactly |
| Concurrency: two sales consuming the last lot | One succeeds or both split correctly; no negative lot |
| Sync divergence | True-up posted, report row created |
| INV-01..INV-05 | Green after every one of the above |

## 18. Manual Scenarios
1. Buy 10 @ 100, then 10 @ 120. Sell 15. Check COGS under FIFO (10×100 + 5×120 = 1,600) and remaining lot (5 @ 120).
2. Switch to Average on a new period, repeat, verify the documented figure.
3. Add 500 transport cost to the first purchase → actual cost per unit rises → verify margin report changes and the cost-adjustment entry explains it.
4. Backdate a purchase to before an existing sale → open the Cost Adjustments screen and confirm every change is explained.
5. Sell into negative stock, then receive stock → verify true-up and that profit is marked provisional until then.

## 19. Edge Cases
Zero-cost lots (free samples) · returns of goods whose lot was closed · lot with expiry in the past · rounding remainders accumulating over thousands of movements · a product switched to serial tracking mid-life · vendor lot mixed with owned lot for the same product · recompute interrupted halfway (must be resumable and idempotent) · very large recompute (100k movements) run during business hours (must be chunked/background).

## 20. Security
Cost fields masked without `inventory.cost.view` (including in exports, API responses and error messages) · recompute is an elevated, audited operation · cost data is a competitive secret — no cost values in logs.

## 21. AI / MCP
Read-only: `stock_valuation`, `explain_cost(product, date)` returning the lot/consumption chain. **No AI write access to costs, ever.**

## 22. DoD additions
- [ ] C-02 re-costing policy implemented exactly as documented and covered by the backdating test
- [ ] Every cost change in the system is explainable through `cost_adjustments`
- [ ] Rounding remainder handling proven not to leak value (INV-01 after 10k randomised operations)
