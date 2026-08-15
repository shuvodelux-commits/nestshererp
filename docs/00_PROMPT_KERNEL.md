# Prompt Kernel

Every coding-agent prompt in this folder is built from this kernel. Paste the kernel first, then the task block.

---

## KERNEL (paste at the top of every task)

```
You are implementing ONE SLICE of the SherERP project. You are not designing the product.

MANDATORY READING (read these fully before writing any code):
- docs/AI_CODING_RULES.md            <- binding rules, violations reject the whole change
- docs/02_ARCHITECTURE_PLAN.md       <- package layout and layering
- docs/04_DATABASE_ARCHITECTURE.md   <- ULID, tenant_id, money/qty integers, audit columns
- docs/06_API_ARCHITECTURE.md        <- endpoint, error, pagination, idempotency conventions
- docs/07_PERMISSION_ARCHITECTURE.md <- permission codes and where checks live
- docs/DEFINITION_OF_DONE.md
- the module spec named in the task block, and the specs of its direct dependencies

NON-NEGOTIABLE RULES:
1. Business logic goes in packages/core-domain (pure TypeScript) and packages/core-application.
   NEVER in controllers, Vue components, SQL, or database triggers.
2. core-domain must not import @nestjs/*, Drizzle, PostgreSQL, SQLite, express, or DOM types.
3. All primary keys are ULIDs generated in application code. No autoincrement.
4. All money and quantity values are integers in minor units via the shared Money/Qty helpers.
   Floating point arithmetic on money or stock is forbidden.
5. Every table has tenant_id. Every query is tenant-scoped. tenant_id is never read from a request body.
6. Every mutating use case: permission check first, audit event written, idempotency by operation_id,
   and everything inside ONE database transaction.
7. Never hard-delete a posted financial or stock record.
8. Write tests in the same change. Never skip, disable or weaken an existing test.
9. Do not modify anything outside the ALLOWED FILES list in the task block. If you believe you must, STOP and report.
10. Do not change any requirement. If a requirement seems wrong or contradictory, STOP and report it.

BEFORE YOU CODE: write a short plan (files to add/change, migration, tests) and wait for approval if the
task block says PLAN FIRST.

WHEN DONE, report in this exact format:
## Slice / ## Assumptions / ## Files changed / ## Files intentionally NOT touched /
## Database (V1 PostgreSQL migration; future SQLite adapter only when the offline phase is implemented) / ## Tests (with pasted runner output) /
## Not implemented / ## Risks I noticed
```

---

## Agent-specific wrappers

**Claude Code** — prepend:
```
Work autonomously but incrementally. State your plan first, then implement, then run
`pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test` and paste the real output.
Do not mark the task complete if any command fails. If you disagree with the spec, say so instead of improvising.
```

**Codex / IDE agent** — prepend:
```
Implement only the files listed. Follow the existing file next to each new file as a style template.
Do not reorganise folders. Do not add libraries. After each file, show a diff summary.
```

**Generic GPT coding agent** — prepend:
```
You will receive the spec and the exact file skeletons. Produce complete file contents, one file per code block,
with the full path as the first line of each block. Do not abbreviate with "...". Do not invent APIs:
if a helper you need does not exist in the listed files, say so instead of assuming it.
```
