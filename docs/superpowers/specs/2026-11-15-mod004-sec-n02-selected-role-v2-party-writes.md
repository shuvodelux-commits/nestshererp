# MOD-004 SEC-N02 — selected-role V2 Party write contract and replay/privacy boundary

**Date:** 2026-11-15. **State:** DESIGN ONLY — owner review required, not code-build approval.  
**Backend source:** `nestshererp/chore/hisabiq-adoption-runtime-a01@24dcd98c4d8cea75bb5a72ee63a6e4aacf9353ec`.  
**React source:** `hisabiq_ui/main@7544cc0b93bc66933524e67ffc0ca159273de5a1`.  
**Issues:** [SEC-N02 #298](https://github.com/shuvodelux-commits/nestshererp/issues/298), [SEC-N01 #245](https://github.com/shuvodelux-commits/nestshererp/issues/245), [MOD-004 React tracker #568](https://github.com/shuvodelux-commits/hisabiq_ui/issues/568).  
**Authorities:** adoption `AGENTS.md`, [merged SEC-N01 compatibility plan](../plans/2026-11-15-mod004-v1-partyresponse-privacy-compatibility.md), existing P3A low-friction shared-name/phone writer guards, D08 source roles and the explicitly excluded Vue implementation.

## Verified current boundaries

| Existing symbol / file | Observed behavior | Why it matters |
| --- | --- | --- |
| `PartiesController`, `apps/api/src/parties/parties.controller.ts` | V1 create, update and status return `{data: PartyResponse}`, including private profile fields and `hasLedgerEntries`; V1 list/detail return the same raw family | Cannot solve sensitive response disclosure by React masking |
| `PartiesV2Controller`, `apps/api/src/parties/parties-v2.controller.ts` | Only GET selected-role list/detail/ledger/opening; list/detail parse strict `PartyReadV2` | A V2 write API is not yet implemented or authorized |
| `partyReadV2Schema`, `packages/core-contracts/src/parties.ts` | Exact selected-role `readRole`; independently `profile.state` and `globalHistory.state`; hidden private and other-role fields are not substituted with null or false | Safe response contract can be reused rather than inventing a second profile model |
| `ManagePartiesService.create` | Requires CREATE for every requested role, checks idempotency by operationId, persists a raw `PartyResponse` in the idempotency store, returns the raw response on replay | A controller-level projection **after** this method returns is too late for permission/replay consistency if it needs a new UoW; never disclose a stored raw replay to limited role callers |
| `ManagePartiesService.update` | Any existing-role EDIT permits ordinary name/phone edits; effective changes to private fields require `PARTY_PROFILE_VIEW`; it preserves withheld blank/null placeholders, checks customer-specific permissions, removed-role authority and optimistic version | Do not make privacy grants mandatory for ordinary shared-directory corrections |
| `ManagePartiesService.setStatus` | Status acts on the whole identity; requires DEACTIVATE for **each** current trading role; audit/outbox in the existing UoW | A selected-role status request cannot silently deactivate an unseen Supplier/Vendor membership |
| `toReadV2` and V2 service read helpers | Filter visible role memberships under effective grants; check requested role before identity lookup on reads; selected role determines balance | Do not project an unfiltered post-write `PartyResponse` to role-only clients |

The original 7-role React Party screen is intentionally unmounted in connected mode. The three trading-role GET transports, POS Customer V2 (#589) and Purchase Supplier V2 (#593) are already merged; signed Supplier transport QA (#291) was merged into the Nest adoption branch. This preparation does **not** establish full seven-role capability, permission rollout or a safe V1 cutover.

## Decision to review: response semantics before any endpoint

The favored **direction** is to reuse existing application Party write invariants and audit/outbox inside one tenant-scoped UoW, then derive the public response from a **selected, authorized trading relationship**, not from `PartyResponse`. Do not create a parallel SQL writer or any hidden all-role balance. Two response options need explicit signoff:

**Option A — strict selected-role `{data: PartyReadV2}` after create/edit/status.** Advantages: consistent with existing V2 list/detail, familiar UI name/phone and balance, standardized `WITHHELD`. Risk: current read projection assumes `VIEW` on selected role. Someone may possess CREATE or EDIT without VIEW; requiring a new VIEW grant would violate the shop's low-friction policy, while implicitly upgrading a write grant into broad historical read may leak data. A separately reviewed **write-result-scoped** projection is required if this option is selected.

**Option B — minimal mutation receipt `{data:{id,version,selectedRole,status}}` plus a distinct authorized V2 GET.** Advantages: no accidental financial/history read capability, small response and no derived balance leak for write-only staff. Risk: a write-only editor may not be able to refill the form immediately; UI needs an explicit write-success/GET-withheld transition and create response must be sufficient to keep the selected record. This receipt must have its own strict Zod schema and remain consistent on idempotent replay.

**Recommendation for review, not authorization:** Prefer B for truly write-only actors, and A only if the owner explicitly requires selected-role read fields after a mutation **and** the same-transaction grant/projection rule is proven. Avoid a response that silently switches wire schema by grant at runtime; select one versioned response contract or a clearly versioned union before any build. Endpoint route names, exact DTO and response policy are **not approved** by this document.

## Required implementation rules (for a later separately approved TDD slice)

1. **Explicit role:** Every proposed V2 write specifies one `CUSTOMER|SUPPLIER|VENDOR` selected role. Finance Lender/Borrower/Owner/Payee are blocked; `All` is not a write role. Existing Party identity remains tenant-scoped and shared.
2. **Authorize before existence and side effects:** Check selected-role action permission, feature flag, input role-change permissions and effective private-field change permission inside the same UoW. For role mismatch or foreign ID, ensure the error envelope does not reveal whether a hidden Party exists. Source data, journal and audit visibility remain independent.
3. **No extra privacy demand for normal work:** A permitted existing-role EDIT may change shared name/phone without automatic NID/profile/history grants, subject to existing validation; a permitted CREATE may add only authorized roles. Hidden/unchanged private inputs preserve prior values, but real private changes require the existing stricter effective-change guard.
4. **Role visibility after write:** Never echo ungranted `roles`, customer-only group/credit under Supplier/Vendor, `nid`, `guardianName`, `address`, `email`, `notes`, party-global history or another-role balances. If response A is selected, project with effective role visibility and independent `WITHHELD` tags, and validate the exact schema.
5. **Idempotent replay is a security boundary:** Existing create stores `PartyResponse` before returning. A future V2 command must authorize the **current** actor and selected relationship before reading/replaying stored results. Never return an old, privileged raw response; do not write a new idempotency key or row on a denied retry. Decide and test fingerprint scope (including selected role) and identical replay type; a changed request on the same operationId fails closed.
6. **Commit/response boundary:** Do not perform a second unauthorized read or throw a 403 after successful DB commit to fix output projection. Ensure data mutation, access-dependent output projection, idempotency record, audit and outbox consistency in the same transaction, or formally separate an already-committed acknowledgment protocol with reliable retry semantics.
7. **Status and destructive actions:** Global identity status requires each affected role's DEACTIVATE authority even if the public receipt is for one selected role. Keep system-reserved protections, role removals and posted-history hard-delete safeguards unchanged.
8. **Money:** Create-time historical opening remains source-specific and balanced against Opening Equity as before, has **no current cash movement/session requirement**, and is not an ordinary status/edit. SEC-N02 must not modify its writer or introduce new finance posting, loan, income, expense or cross-role settlement code.
9. **Legacy V1:** Do not gate or retire the five raw V1 routes merely because a safe V2 design exists. SEC-N01 needs the owner's SEC-1/2/4/5 decisions plus evidence about deployed legacy clients; never implement Vue migration, role auto-grants or a silent compatibility bypass.

## Test-first matrix to authorize before writing code

| Scenario | Required actual result | Proposed test owner |
| --- | --- | --- |
| Trading-role CREATE by limited actor (no private/global-history grants) | Name/phone accepted; no raw profile/global history in response; only requested/authorized roles created | Nest `apps/api/test/*party*v2*write*.spec.ts`; signed nonowner PG16 |
| EDIT shared name/phone for Customer+Supplier while caller only has Customer EDIT | Success without Supplier EDIT if no role/private change; Supplier-only metadata, balance, history withheld | Same signed PG16; React typed adapter later |
| EDIT with denied effective NID/address/notes changes, including full-form blank placeholder | Actual private change denied with zero row/version/audit/outbox effects; withheld placeholder does not clear stored value | Same signed PG16 |
| Missing/hidden role and foreign/unknown Party | Consistent non-oracle denial, no cross-tenant mutation or response | Signed two-tenant PG16, explicit grant fixtures |
| Vendor feature OFF and reserved Party | No response or mutation, no idempotency reservation | Signed PG16 |
| Status for multi-role identity | Without all affected role DEACTIVATE grants: deny before mutation/audit/outbox; with grants: one identity-wide change | Signed PG16 |
| Create retry, lost ACK, changed fingerprint, permission revocation | One Party/audit/outbox set; deterministic replay response under current grants; changed/denied retry cannot leak prior raw response | Signed PG16 and application unit |
| Update stale version/concurrent transaction | 409 or correct existing conflict code; no partial rows/outbox/version overwrite | Signed PG16 concurrent requests |
| Response contract | Strict fixed key schema; no unexpected private/global-history/role fields, correct `WITHHELD` or receipt, never downgrade to V1 | Core-contract and HTTP transport tests |
| Historical opening existence and zero/no-session | Unchanged source-linked posting/correction semantics; **not** introduced by ordinary non-opening edits | Existing opening signed tests as regression |
| React error / keyboard / touch | Existing preview untouched; after separate mount approval, preserve drafts/focus and 401/403/409 feedback | Later Playwright; **not tested by this design** |
| V1 privacy cutoff | Five raw-response routes denied only under separately approved policy; retained client compatibility and rollback evidence | Separate SEC-N01 build, NOT SEC-N02 |

**Required future execution:** use actual installed `/super-build` (as `AGENTS.md` demands), test-first RED/expected reason → smallest GREEN, full Node20/strict contracts and boundary tests, signed disposable two-tenant PG16 non-owner RLS, independent security/accounting QA, exact-head CI and human merge/rollout permission. A passing static build is not signed DB acceptance. Do not fabricate executed tests or pretend that the design is an implemented feature.

## Owner decisions and release gate

- **SEC-1:** explicit V1 disclosure policy; not inferred from this design.
- **SEC-2:** choose strict V2 projected write response vs minimal receipt, whether write-only actors receive selected-role read fields, and which normal create/edit/status actions remain available without privacy grants.
- **SEC-4:** identify deployed/retained V1 consumers and select hard or staged retirement with rollback; Vue code remains out of HisabIQ scope.
- **SEC-5:** independent QA and separate security release authorization.
- **Finance/D08:** Owner equity classification, interest, Vendor semantics and all seven-role financial writer responsibilities remain unresolved; no schema or journal work here.

**Rollback (design only):** revert this single Markdown artifact. **Production state:** no endpoints, tests, migrations, permissions or live data were changed; backend V1 profile/history exposure remains open and the connected React seven-role Party workspace remains gated.
