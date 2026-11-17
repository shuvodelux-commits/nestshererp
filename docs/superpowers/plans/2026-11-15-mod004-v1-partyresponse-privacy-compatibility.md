# MOD-004 SEC-N01 — V1 PartyResponse security cutover: compatibility and approval packet

**Status:** DOCUMENTATION-ONLY PROPOSAL, **NOT BUILD-APPROVED**. Based on backend adoption `91dd0ccf744622e0c64adf32a63b9599d126f979` and React `main@412083eec9f175f4af9d7ef31e7e23dfacc3fe4e` (2026-11-15). [Security issue #245](https://github.com/shuvodelux-commits/nestshererp/issues/245); [parent MOD-004 #568](https://github.com/shuvodelux-commits/hisabiq_ui/issues/568). No runtime source changes, tests, migrations, role grants, UI activation, or deployment in this document PR.

## 0. November 17, 2026 — CURRENT checkpoint (supersedes historical status below)

**STATUS: SOURCE-AUDITED, NOT BUILD-APPROVED OR DEPLOY-APPROVED.** Keep the original November 15 audit and matrix below as historical evidence, but the old statements that React POS/Purchase readers still use V1 and that V2 status is missing are superseded. This checkpoint is pinned to React main **b0def73a13ce507b2b9951947e0552f4c729ab61** and backend adoption **031b5053df3fbc1def463def7d8803b774f8f131**. Related: security [issue #245](https://github.com/shuvodelux-commits/nestshererp/issues/245), operator [issue #339](https://github.com/shuvodelux-commits/nestshererp/issues/339), React [issue #568](https://github.com/shuvodelux-commits/hisabiq_ui/issues/568).

### Merged prerequisites — no V1 hardening yet

| Component | Current verified state | Remaining boundary |
| --- | --- | --- |
| Nest V2 Party create, shared name/phone edit | Backend PRs #309, #317, #329 merged, signed QA/Node20 CI | Limited-role writes receive minimal receipts, not full private profiles |
| Nest V2 identity-wide status | [Backend PR #335](https://github.com/shuvodelux-commits/nestshererp/pull/335) merged, CI passed | Role-selected destructive authority plus all current roles; row-locked CAS, same-status no-op, minimal receipt |
| React V2 trading create/edit/status | Frontend PRs #609, #642, [#660](https://github.com/shuvodelux-commits/hisabiq_ui/pull/660) merged | Strict unmounted adapters; #660 full 1,782/1,782 frontend tests and 5/5 Super Build passed |
| React POS Customer and Purchase Supplier | Frontend PRs #589 and #593 merged | Both use selected-role privacy-safe V2 reads, no raw V1 fallback |
| Source-backed V2 Supplier QA | Backend PR #291 merged | Not evidence that V1 disclosure is fixed |
| Older SEC-N01 design PRs | Backend #275 and React #575 merged | Documentation only; no new server-side V1 gate |

**Live source still vulnerable:** backend apps/api/src/parties/parties.controller.ts still returns raw PartyResponse via **five** V1 operations: GET list, GET detail, POST create, PATCH edit and POST status. The service list/get/create/update/setStatus still returns the legacy raw projection without both privacy grants. Current signed V2 security tests reproduce the existing V1 exposure as a **release blocker**, not as a success. V1 raw response includes address, guardian, NID, email, notes and party-global history presence. Do not treat privacy-safe V2 behavior or client-side masking as a fix to this direct V1 HTTP exposure.

### Source-scanned caller compatibility — exact pins only

| Surface | Direct literal /api/v1/parties files | Decision |
| --- | --- | --- |
| React runtime src/ | **0** | No direct literal in this directory; does not establish live deployments, indirect dynamic paths or every client version |
| React scripts/ | **11** | Real-browser, source-QA, test seeding and demo tools still depend on V1 create or read |
| React tests/ | **1** | Includes a direct HTTP compatibility expectation |
| Backend apps/api/test/ | **27** | V1 Party fixture/call-site test files require authorization-impact review |
| Backend apps/web/src/api/parties.ts | **1** source file with all five sensitive routes | Legacy Vue client still consumes raw V1 and uses offlineWrite with queued PARTY_CREATE; **actual deployment and queued operations remain UNKNOWN** |

These are counts of **files containing the exact static literal**, obtained by git grep on the two specified HEADs, not counts of HTTP calls, deployed installations or active shops. React fixture files include connected-purchase-drafts-browser.cjs, connected-purchase-drafts-postgres-browser.cjs, mod003-sale-damage-nonowner-crossprocess.cjs, mod006-cash-connected-post-browser.cjs, mod006-connected-counter-read-browser.cjs, mod006-connected-counter-single-payment-browser.cjs, mod006-counter-connected-post-browser.cjs, mod006-supplier-mfs-connected-post-browser.cjs, mod007-pos-read-live-browser.cjs, mod008-p5d-source-seed.cjs, and seed-hisabiq-demo.mjs. A restrictive V1 change must not turn legitimate synthetic acceptance fixtures into silently authorized private-data readers.

### Freedom-first SEC-1 through SEC-5 decisions (current)

- **SEC-1 — raw V1 response:** **NOT APPROVED.** Recommended: require both existing **PARTY_PROFILE_VIEW** and **PARTY_HISTORY_GLOBAL_VIEW** in addition to selected-role/action permissions for the **five raw-response operations only**, inside the same tenant UoW **before lookup, operation-ID replay and mutation**. Preserve full original V1 response only for appropriately privileged callers. No default or automatic grant to cashiers, no production bypass, no route-prefix blanket denial affecting other V1 ledger/opening/delete/setup.
- **SEC-2 — shopkeeper freedom:** **V2 DAILY TRADING PATH IMPLEMENTED.** Role-only create/name/phone/status and selected-role reads should remain usable without raw private/global disclosure grants. The V2 status operation still affects an entire identity: **every affected trading role** must authorize DEACTIVATE. No generic netting or finance-role reuse.
- **SEC-3 — React consumer preparation:** **MERGED for known trading adapters.** POS Customer and Purchase Supplier read migrations are complete. Unmounted Party create/edit/status transports are complete. Connected seven-role React Party UX is **not** released; do not activate preview finance screens as live flows.
- **SEC-4 — retained V1 clients/offline queues:** **UNKNOWN; OPERATOR INPUT REQUIRED.** [Issue #339](https://github.com/shuvodelux-commits/nestshererp/issues/339) asks for deployed versions, privacy-safe aggregate route counts, queued offline PARTY_CREATE backlog, stage/canary/production cutover choice and safe rollback. Static Vue source is **not** proof of an active deployment or absence of users. No Vue migration or Vue browser testing is authorized for this module.
- **SEC-5 — release:** **NOT AUTHORIZED.** After owner SEC-1/4 decisions, one separate Nest-only RED→GREEN implementation branch with signed 2-tenant nonowner PostgreSQL16/RLS, replay/concurrency, no forbidden side effects, exact-head Super Build, Node20 full CI and independent security/accounting QA. Separate owner approval is required for PR merge **and** deployment.

### GitHub deployment-record audit (2026-11-17; no runtime-status inference)

GitHub REST deployment/environments inspection is a **bounded source-of-record check**, not a live traffic study. Backend repo GitHub API returned **zero deployment objects** and **zero configured environments**; the adoption-branch workflows are CI and test-specific checks. React repo GitHub API returned **two GitHub Pages deployment objects**, dated **2026-10-06**, commit SHAs `d3f7d87c916a2f5f345498e930bcc2fb01a7e86b` and `18bf8dbb34191ec118f289a471e5c8336b4201ea`; **both latest status = failure**, with no environment URL. Its only listed GitHub environment is `github-pages`. These results cannot establish the existence or nonexistence of external deployments.

React `wrangler.jsonc` configures a candidate Cloudflare Worker named `hisabiq-ui` with static assets `./dist` and SPA fallback; **configured intent does not prove deployment**. The React `PR Fast CI` workflow is a build/test/smoke gate rather than a production deployment. Backend `.github/workflows/ci.yml` runs PG16/Node checks and Vue build/acceptance; no backend deployment was recorded within GitHub. Hosting in Cloudflare, an external server, AWS or a separate release system remains **UNKNOWN**, including actual live API host/version, any retained Vue client and queued offline creates.

The operator must provide sanitized release identifiers, route-level V1 counts, supported client age and offline command backlog before a production cutover decision. Do not infer zero clients or zero exposure from empty GitHub deployment records. See [operator issue #339](https://github.com/shuvodelux-commits/nestshererp/issues/339#issuecomment-6938517978) for the read-only audit, required evidence and rollout gate.

### Required future acceptance — before any live cutover

| Scenario | Mandatory assertion |
| --- | --- |
| Trading-role only / only one privacy grant / both privacy grants | First two combinations denied at the five raw V1 boundaries; both plus appropriate role/action permitted; no raw data on error |
| V1 create replay | Forbidden preflight before replay result, Party insert, opening, audit, outbox or operation-ID reservation |
| V1 edit/status | Forbidden preflight before version, audit, outbox or hidden-identity disclosure; permitted roles preserve old wire format |
| Missing ID, foreign tenant, wrong selected role, Vendor OFF, shared role | Tenant/RLS and role privacy remain fail-closed; no hidden membership, global history or another role's balance |
| V2 read/create/edit/status regression | Existing role-only freedom preserved, V2 WITHHELD/VISIBLE projection intact, minimal mutation receipts and no unauthorized rollback |
| Opening/ledger/delete/setup/groups | No accidental V1 route-prefix shutdown, journal/cash/session effects or change to identity-wide posted-history delete guard |
| Client compatibility | Operator inventory of deployed V1 callers and offline queued writes reviewed before stage/canary/production policy decision |
| Review/rollout | Security/accounting QA signoff, owner separately authorizes merge, rollout and monitoring; no silent auto-privilege |

**Current action:** Update operator inventory [#339](https://github.com/shuvodelux-commits/nestshererp/issues/339); approve or revise SEC-1/4/5 in parent [#245](https://github.com/shuvodelux-commits/nestshererp/issues/245). Documentation review may proceed; **this update must not be read as approval to lock down live V1 endpoints**.

---

## 1. Source-verified security condition

- [`apps/api/src/parties/parties.controller.ts`](https://github.com/shuvodelux-commits/nestshererp/blob/91dd0ccf744622e0c64adf32a63b9599d126f979/apps/api/src/parties/parties.controller.ts) exposes `PartyResponse` through five V1 HTTP operations below.
- [`packages/core-contracts/src/parties.ts`](https://github.com/shuvodelux-commits/nestshererp/blob/91dd0ccf744622e0c64adf32a63b9599d126f979/packages/core-contracts/src/parties.ts) defines the raw response with `address`, `guardianName`, `nid`, `email`, `notes`, and party-global `hasLedgerEntries`. This is not the V2 `WITHHELD` projection.
- [`packages/core-application/src/parties/manage-parties-service.ts`](https://github.com/shuvodelux-commits/nestshererp/blob/91dd0ccf744622e0c64adf32a63b9599d126f979/packages/core-application/src/parties/manage-parties-service.ts) has selected-trading-role checks and independent field-edit checks but the five raw V1 response operations do not require **both** disclosure permissions. V2 list/detail uses `PARTY_PROFILE_VIEW` / `PARTY_HISTORY_GLOBAL_VIEW` to produce `profile.state` and `globalHistory.state` independently.
- [`apps/api/test/parties-v2-security.spec.ts`](https://github.com/shuvodelux-commits/nestshererp/blob/91dd0ccf744622e0c64adf32a63b9599d126f979/apps/api/test/parties-v2-security.spec.ts) explicitly tests a **still-unfixed V1 raw disclosure** as a RED release blocker. Its passing reproduction is not a certificate of safety.
- Recent trading-role safeguards are real: exact-role V2 directory/detail/ledger/opening, Vendor feature gate and role-delta destructive authorization/history guard are present in the pinned current source. The older D08.0 report of **missing** role-removal authorization has been superseded by `removedRoles` and `before.hasLedgerEntries` checks; do not create a redundant role-delta writer or weaken them.

## 2. Endpoint impact matrix — do not blanket-block all V1

| HTTP route | Existing response | Existing admission (in addition to tenant RLS) | Proposed **additional** V1 disclosure gate | Migration implication |
| --- | --- | --- | --- | --- |
| `GET /api/v1/parties?role=R` | raw `PartyListResponse.data[]` | selected R `VIEW`, role filters | `party.profile.view` **AND** `party.history.global.view` before data/identity lookup | Role-only lists must use safe V2 projection |
| `GET /api/v1/parties/:id` | `{data: PartyResponse}` | selected/derived trading-role view | both disclosure grants before record lookup | Role-only detail must use V2; no V1 fallback |
| `POST /api/v1/parties` | `{data: PartyResponse}` including idempotent replay | relevant role `CREATE` | both grants **before idempotency lookup and before writes** | A role-only creator needs a separately approved safe response writer if this legacy path becomes privileged |
| `PATCH /api/v1/parties/:id` | `{data: PartyResponse}` | role `EDIT`, role delta and field guards, version | both grants **before mutation/audit/outbox** | Role-only shared-name edits need safe versioned write response policy |
| `POST /api/v1/parties/:id/status` | `{data: PartyResponse}` | all affected role `DEACTIVATE` | both grants **before status change/audit/outbox** | A limited deactivator needs a policy-approved path |
| `GET /api/v1/parties/:id/ledger` | distinct role-ledger DTO | role-specific `VIEW` | **Not included by route prefix alone** | Keep until its separate data-contract audit |
| `GET /api/v1/parties/:id/opening` | source `PartyOpeningResponse | null` | opening-role `VIEW` | **Not included by route prefix alone** | Canonical V2 opening exists for React |
| `POST/PATCH /api/v1/parties/:id/opening` | distinct opening source DTO | historical opening, idempotency, period and role guards | **Separate financial write review** | Never change opening journals as a side effect |
| `DELETE /api/v1/parties/:id` | `204` / no PartyResponse | each affected role `DEACTIVATE`; global posted-history guard | **No new raw-response gate implied** | Preserve global journal-history safety |
| `/api/v1/party-setup` and groups | separate setup/groups DTO | own grants | **Out of scope** | No hidden blanket lockdown |

**Proposed policy, not approved:** Require the two disclosure grants **in addition to** existing action/selected-role grants for the first five routes only. Check inside the same tenant application transaction, before existence tests, idempotent replay and mutation. Never allow a post-commit 403. Do **not** automatically grant disclosure permissions to all staff. Preserve V1 wire format for callers who hold all required grants; do not silently replace it with V2 or mask only client-side.

## 3. Current consumer compatibility inventory

| Consumer code (static source) | Actual dependency | Compatibility risk | Handoff / isolation |
| --- | --- | --- | --- |
| HisabIQ MOD-004 [`party-reads.ts`](https://github.com/shuvodelux-commits/hisabiq_ui/blob/412083eec9f175f4af9d7ef31e7e23dfacc3fe4e/src/integration/party-reads.ts) | Party directory/detail/ledger/opening now V2 | No raw PartyResponse read dependency for these four; workspace still unmounted | Preserve exact selected-role, WITHHELD and no V1 retry |
| HisabIQ MOD-007 [`sales.ts`](https://github.com/shuvodelux-commits/hisabiq_ui/blob/412083eec9f175f4af9d7ef31e7e23dfacc3fe4e/src/integration/sales.ts), [`saleMapping.ts`](https://github.com/shuvodelux-commits/hisabiq_ui/blob/412083eec9f175f4af9d7ef31e7e23dfacc3fe4e/src/integration/saleMapping.ts) | POS Customer list still GETs V1 `parties?role=CUSTOMER`; strict decoder assumes raw private keys + `hasLedgerEntries`, numeric summary | V1 gate would return 403 for role-only users; naive URL swap fails strict decoder | Separate MOD-007 transport + DTO projection, real auth and tenant acceptance; no POS visual/cart change |
| HisabIQ MOD-008 [`purchase-suppliers.ts`](https://github.com/shuvodelux-commits/hisabiq_ui/blob/412083eec9f175f4af9d7ef31e7e23dfacc3fe4e/src/integration/purchase-suppliers.ts) | Supplier list/detail still V1; strict 18-field raw PartyResponse plus `hasLedgerEntries`; expects `summary.ungrouped: number` | V2 Supplier summary deliberately uses `ungrouped: null` and withheld private fields. A path substitution is not schema-compatible | Separate MOD-008 supplier projection / strict decoder / query / permission tests; preserve purchase UI |
| Backend legacy [`apps/web/src/api/parties.ts`](https://github.com/shuvodelux-commits/nestshererp/blob/91dd0ccf744622e0c64adf32a63b9599d126f979/apps/web/src/api/parties.ts) | Static source calls V1 list/detail/create/update/status and maintains offline queue/fallback | Immediate V1 privilege gate could disrupt retained clients; **deployment status unverified** | **Policy/rollout decision required.** No Vue implementation, migration or Vue test work within HisabIQ |
| Backend signed API tests (e.g. `apps/api/test/parties.spec.ts`, `parties-v2-security.spec.ts` and purchase/sale/return tests) | Create test fixtures via V1 HTTP and assert legacy DTOs | New authorization causes fixture 403 unless grants are explicitly provisioned | Amend only legitimate authorized fixture capabilities, preserve denial tests; do not weaken assertions |

**Important scope distinction:** Static code references establish compatibility risk, not proof that those adapters are currently mounted, deployed, or accessible to production users. The live deployment/client population still needs an explicit owner/operator inventory.

## 4. Safe sequence proposed for owner approval

1. **Policy approval:** Owner selects the V1 dual-disclosure-grant policy, confirms who can see private profiles and global history, and authorizes a staging rollout plan. Alternative V1 response projection/retirement strategies require a separate threat and compatibility review; do not choose them implicitly.
2. **Consumer preparation:** MOD-007 and MOD-008 owners migrate only their respective currently unmounted read adapters to safe V2 DTOs with exact-role fields, nullable summary and withholding. Preserve their existing React screens and all preview behavior; test fail-closed 401/403/404, multi-role identities and no V1 fallback. This is separate implementation approval per issue.
3. **Role-limited mutation policy:** Decide whether ordinary staff retain create/name/phone/status abilities without both private disclosure grants. If yes, first design safe V2 write response contracts that do not echo raw NID/global history while retaining role/action permission, transaction/idempotency, version and audit. Do not intentionally make needed workflows unusable without a replacement.
4. **Legacy runtime compatibility:** Obtain actual client/deployment status of any retained V1 consumer (including the legacy web adapter). Choose explicit hard cutover, time-bounded isolated compatibility tier, or other reviewed server policy; no silent auto-grants, cross-tenant bypass or Vue deliverables.
5. **Backend lockdown (only after steps 1–4 approved):** One bounded Nest-only TDD issue/branch for five raw V1 routes. Require both privacy grants before lookup/replay/post in tenant UoW; keep other endpoints and existing Party role-delta/history guards untouched.
6. **Independent signed QA and rollout gate:** 2 tenants, non-owner PostgreSQL16, role-only vs profile-only vs history-only vs both, dual Customer+Supplier history on only one role, feature-disabled Vendor, missing and unauthorized IDs, idempotent replay and negative write-side effects, safe V2 unchanged. Exact-head Super Build + Node20 full CI + independent security/accounting review + explicit owner deploy/merge. A successful PR merge alone does not authorize deployment.

## 5. Required executable scenario matrix for the later code PR (NOT run by this document PR)

| Scenario | Required assertion |
| --- | --- |
| R-only V1 GET list/detail | 403 before Party lookup; no NID/profile/history payload; existing and missing ID cannot become an oracle |
| R + exactly one privacy grant | Still 403, whether profile or history alone; no partial V1 raw DTO |
| R + both privacy grants | Existing V1 DTO valid for authorized roles; source/source-history still role-protected; 2-tenant isolation preserved |
| R-only V2 list/detail/ledger/opening | Unchanged selected-role reads with `WITHHELD` profile and history; other-role amounts unavailable; Vendor disabled stays 403 |
| V1 create missing privacy | 403 before idempotency replay, Party row, opening journal, audit, outbox or operation-id reservation |
| V1 PATCH/status missing privacy | 403 before mutation, optimistic-version change, audit and outbox; replay cannot leak a prior privileged raw DTO |
| Historical opening/ledger/delete | Unchanged role-specific source / journal semantics and identity-wide posted-history deletion protection |
| Security rollout | Real client/role compatibility documented; no dropped UI capability, forbidden grant inheritance, production edits or unfunded migration |

**Verification in this PR:** Documentation-only source audit and GitHub diff review. No `super-build` is required for documentation-only work per AGENTS.md; do not claim any new application tests or live vulnerability remediation.

## 6. Explicit decisions needed before implementation

- **SEC-1 (privacy):** Approve or reject dual `PARTY_PROFILE_VIEW` + `PARTY_HISTORY_GLOBAL_VIEW` in addition to role/action on all five raw V1 response routes, including write echoes and idempotent replay.
- **SEC-2 (daily work):** Should a role-only staff member be able to create a Party, edit shared name/phone or change status without viewing private fields? If yes, approve a separate safe V2 writer/response contract before V1 lockdown.
- **SEC-3 (dependencies):** Authorize separate MOD-007 POS Customer and MOD-008 Supplier read transport/schema migrations to V2 (not merely URL edits).
- **SEC-4 (deployment):** Determine whether any old V1 client is retained/deployed and select its server-compatibility retirement/cutover policy. No Vue implementation/testing is authorized.
- **SEC-5 (release):** Require independent security/accounting QA and separate rollout approval after tests, even if code is merged.

Until these decisions are resolved, keep raw V1 PartyResponse security issue #245 OPEN and the full seven-role connected Party workspace gated. No finance-role journaling or new migration is proposed here.