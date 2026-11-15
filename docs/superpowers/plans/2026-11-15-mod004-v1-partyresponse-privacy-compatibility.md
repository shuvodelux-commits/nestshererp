# MOD-004 SEC-N01 — V1 PartyResponse security cutover: compatibility and approval packet

**Status:** DOCUMENTATION-ONLY PROPOSAL, **NOT BUILD-APPROVED**. Based on backend adoption `91dd0ccf744622e0c64adf32a63b9599d126f979` and React `main@412083eec9f175f4af9d7ef31e7e23dfacc3fe4e` (2026-11-15). [Security issue #245](https://github.com/shuvodelux-commits/nestshererp/issues/245); [parent MOD-004 #568](https://github.com/shuvodelux-commits/hisabiq_ui/issues/568). No runtime source changes, tests, migrations, role grants, UI activation, or deployment in this document PR.

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