# P0 #259 — Backup/restore versus durable operation identity: review contract and remediation gates

**Status:** source-grounded *design proposal*, not approved behavior or a code/DB migration. **Issue:** [#259](https://github.com/shuvodelux-commits/nestshererp/issues/259). **Related draft PRs:** runtime-role security [#253](https://github.com/shuvodelux-commits/nestshererp/pull/253), Sales Draft permanent identity [#221](https://github.com/shuvodelux-commits/nestshererp/pull/221), Catalog lifecycle [#242](https://github.com/shuvodelux-commits/nestshererp/pull/242). Backend branch at initial review: `chore/hisabiq-adoption-runtime-a01@64aea31c3010c911dacb1f2930600a326be57a08`; #253 head `5e95b770f33c946791726de66eefda3969390990`; #221 head `7aa04ede86bb9e4b223b4e84b24cf1c5de78295d`.

## 1. Reproduced problem; do not paper over it

- Node20 / PostgreSQL16 hosted [#253 CI](https://github.com/shuvodelux-commits/nestshererp/actions/runs/43626766420) reports **677 passing / 1 failing / 140 skipped** API cases. `apps/api/test/backup.spec.ts:273` expects 200 for a signed owner restoring a destroyed business from its own backup; actual result is HTTP **500**.
- Its PostgreSQL log and Nest stack show `PostgresBackupRepository.clear()`, `packages/adapter-postgres/src/backup-repository.ts:351`, issues `DELETE FROM import_operations WHERE tenant_id=$1`; newly restricted test role `sher_app` correctly receives **permission denied** (SQLSTATE 42501).
- `packages/adapter-postgres/src/backup-repository.ts` enumerates tenant tables dynamically in `structure()`. Apart from the four `EPHEMERAL_TABLES`, two machine-local tables and `schema_migrations`, durable tenant tables—including `import_operations`—participate in archive export, ordered DELETE and import. `clearBusinessKeepingIdentity()` is used by Reset Business Data; `clearBusiness()` is used by Restore.
- Migration `0056_durable_import_operations.sql` makes `import_operations.tenant_id` reference `tenants(id)` without `ON DELETE CASCADE`, with tenant+operation unique identity, RLS and runtime **SELECT/INSERT/UPDATE** (completion only), not DELETE/TRUNCATE. Draft migration `0058_sale_draft_create_operations.sql` defines permanent, PII-free draft-create tombstones with tenant FK, RLS, no draft FK, and **SELECT/INSERT** but not UPDATE/DELETE/TRUNCATE.
- `RestoreService.restore()` first checks business permission and password step-up under the regular tenant connection, then performs clear/import under the ordinary `UnitOfWork.runWithoutTenant` transaction. **Application authorization never automatically grants SQL DML powers.** A generic `GRANT DELETE` to the runtime principal would undermine replay protection; simply skipping the delete has other retention/foreign-key and stale-result hazards.

This is a real cross-module contract contradiction, **not a flaky assertion**. #253's scoped role-hardening tests passed, but it cannot merge with the full regression red. No production-grant audit has been performed.

## 2. Invariants to approve before changing source

1. **Normal runtime principal:** never has `TRUNCATE` on tenant data and never has `DELETE` on permanent replay identities. `import_operations` must permit only the UPDATE needed to complete an in-flight record; `sale_draft_create_operations` stays immutable after INSERT. RLS and tenant-scoped uniqueness remain compulsory. Never solve #259 by broadening `sher_app` grants.
2. **Archive fidelity:** backups must preserve canonical posted financial/stock source records, references, users, journals and historical authorizations. A recovery cannot create duplicate financial obligations or silently re-post. A replay source record that is missing from a restored snapshot is **not** proof that an old operation may be executed again; decide and explicitly test permanent identity retention across disaster recovery.
3. **Restore target:** existing `RestoreService` is deliberately *empty-installation only*; it must not overwrite a trading shop. A different seeded tenant identity is replaced by the archive's tenant identity inside one atomic operation. A target with existing durable operations is **not** necessarily empty merely because visible business tables are empty.
4. **Reset business:** current `ResetBusinessService` promises to preserve identity, users, roles, permissions, and a recovery dump; it resets books, not the account. If old permanent operations survive, an old key cannot return a falsely successful response referencing deleted business rows; if they do not survive, reuse of the same key cannot generate duplicate source effects after a restore. This requires an explicit epoch/tombstone/replay policy, not only a table exclusion.
5. **Full tenant erasure:** controlled irreversible erasure is a separate privilege, retention and audit workflow, not an ordinary owner backup/reset API and not a side effect of running a low-privilege import.
6. **Bounded privilege:** a password-confirmed application-level owner does not obtain the superuser/fixture-admin database URL. Any data-changing privileged recovery executor must be isolated from public Nest request handlers, operate on a specified tenant and bounded operation, and produce signed/auditable evidence. Avoid a broadly callable `SECURITY DEFINER` function based only on caller-settable `app.tenant_id`; that is not a trusted authorization boundary.

## 3. Proposed solution direction (requires security/accounting sign-off)

**Preferred separation: ordinary runtime versus narrowly privileged recovery operator.** Keep #253's least-privilege runtime model. Introduce a separately authenticated, operationally controlled recovery executor for destructive, cross-identity restoration; no arbitrary SQL, generic admin pool or operator credential in the HTTP process. Owner UX may submit an *authorized recovery request*, but cannot execute privileged table deletes directly in the ordinary runtime transaction.

The recovery design must first choose how completed operation identities survive or become explicit invalidated tombstones:

| Lifecycle operation | Proposed replay/retention rule | Pending hard decision |
|---|---|---|
| Ordinary import/draft creation | Retain source identity after cache expiry / draft deletion; same key must not create again | Already in migrations 0056 / draft 0058 |
| Reset business while keeping tenant identity | Preserve an audited history/epoch and refuse old-key reactivation or stale successful payloads | Define business data epoch / invalidation semantics |
| Restore from complete, verified archive | Restore source-linked documents and corresponding durable operation identities coherently | Archive schema version, restore precedence, anti-replay on missing older tombstones |
| Empty fresh installation with temporary tenant | Require no business **and** no permanent source identity that would be orphaned | How to prove eligible target and guarantee atomic replacement |
| Legal/operator-initiated tenant erasure | Privileged separately authorized deletion with retention/audit controls | Out of scope of owner Reset Business Data |

A simpler design that merely adds `import_operations` and `sale_draft_create_operations` to `EPHEMERAL_TABLES` is **rejected pending proof**, because it would omit durable replay protection from the backup and could permit replay of previously restored source documents. A direct runtime `GRANT DELETE` or `TRUNCATE` is rejected. A cross-role sequence of independent, non-atomic transactions is rejected unless it supplies durable two-phase recovery/rollback evidence.

## 4. Implementation slices — do not combine with active PRs

**R1 — contract and exact RED acceptance (new exclusive test file; no production writer):** create a real Node20/PG16 non-owner two-tenant suite for signed owner backup export → destroy simulated installation → restore; separate normal user/foreign tenant denial; durable import key completed then cache pruning; repeated key after reset; immutable draft-create source when 0058 present; preservation of journal/stock/audit and outbox semantics; failure rollback. Include test-admin only to create/drop its own disposable schema. Record actual RED statuses and backend source SHAs.

**R2 — explicit lifecycle decision:** independent security/accounting reviewer accepts exact retention, backup format, reset epoch and privileged recovery executor protocol, including permission mapping, crash/retry idempotency, tenant replacement and database role provisioning. This approval determines whether a new migration is required; reserve its number after #221's 0058 and #242's 0059 ownership is released. If current online restore cannot meet it, keep route gated with an explicit recovery-only error rather than silently weakening grants.

**R3 — minimal implementation:** implement only the approved recovery boundary and source table classification in an exclusive code PR. Inventory and coordinate `packages/adapter-postgres/src/backup-repository.ts`, `packages/core-application/src/backup/{restore-service,reset-business-service}.ts`, Nest DI/transport and new migrations *only when necessary*; no parallel editing of #221/#242/#253 owned files. No UI redesign or finance repricing.

**R4 — GREEN and release:** run signed two-tenant role-restricted PostgreSQL16 concurrency, restore/rollback/crash/replay, journal/stock golden invariants, all `backup.spec.ts` tests, source-pinned Super Build and complete hosted Node20 CI (including browser). Verify production-equivalent grants from provisioning scripts separately. Update #253/221 evidence, obtain independent review and exact trusted human GitHub merge approval before enabling any operator or deploy.

### Specific must-pass acceptance matrix

| Case | Mandatory assertion |
|---|---|
| Runtime credential `TRUNCATE import_operations` | PG42501; other tenant/source unchanged |
| Runtime credential `DELETE import_operations` | PG42501, even under caller's tenant context |
| Runtime credential UPDATE completed import | Allowed only per approved completion contract; another tenant denied |
| Signed owner export/restore of complete backup | HTTP success *only* after verified, authorized recovery; original tenant and source IDs, credentials, balances and immutable operation IDs restored |
| Unauthorized or cross-tenant restore | 403/404, zero source, journal, audit or grant mutation |
| Restored old operation key | Never creates duplicate invoice/purchase/stock/accounting journal or stale success |
| Reset with valid recovery dump | Preserves identity and audited no-replay guarantees; source/journal effects conform to explicit reset policy |
| Malformed/partial backup, crash midway | Atomic rollback, previous state and permanent identities intact |
| Pending concurrent import/draft while reset begins | One serializable accepted outcome; no deadlock, loss, duplicate posting or HTTP 500 |
| After migration 0058 | Sale Draft tombstones SELECT/INSERT only; no app-role UPDATE/DELETE/TRUNCATE |

## 5. Release and environment gates

- **Do not merge #253** while hosted `backup.spec.ts` is red; **do not merge #221 or #242** merely to release schema ownership if source/recovery/grant policy is unresolved. Existing CI GREEN is not approval of this missing cross-module scenario.
- Preserve current frontend; do not enable connected Sales Draft, Catalog Active/Inactive, owner reset/restore production path or run migrations on retained data from this design PR.
- Use isolated Podman PostgreSQL16, source-pinned Super Build and exclusive worktrees. The author's CachyOS disk was previously near 99%; verify space before running anything. Never remove another agent's worktree or fixture.
- This document is a **design-only deliverable**. It records decisions and test gates for independent review, not passing tests, an approved privilege model, deployed behavior, or a trusted-human `done` approval.
