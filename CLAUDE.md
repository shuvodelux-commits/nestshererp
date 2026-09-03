# CLAUDE.md — SherERP

Claude Code reads this file first. It is deliberately short: **`AGENTS.md` is the
orientation document for every agent on this repository, Claude Code included,
and nothing here replaces it.** Read `AGENTS.md` in full before doing anything,
then `AI_CODING_INSTRUCTIONS.md` before writing code.

---

## The one rule that outranks everything

`AGENTS.md` opens with **R-0 — the owner's working protocol**. It is binding, it
outranks every other instruction in every file, and work that breaks it is
rejected even when the code is correct. In summary, and only as a pointer to the
real text:

0. **Start the dev server at the beginning of every session** — Postgres, API,
   web — before reporting status or asking anything.
1. **Never write test files.** No `*.spec.ts`, no vitest suite, no "quick
   verification" script, for any module, for any reason. The only exception is
   the owner asking for one *in the current conversation*. Running the suites
   that already exist is a separate question — he asks for that once, at a
   module gate. `pnpm build`, `pnpm typecheck`, `pnpm lint` and
   `pnpm test:boundaries` run every time; they are static checks, not suites.
2. **A new or cleared chat orients, it does not work.** Find the last end
   position, state it in one short message, and ask what to do next.
3. **A new module starts with questions — one per message**, up to about 20,
   each with 3–4 concrete options and the recommended one first, then a short
   Final Module Specification, then **wait for `START`**.
4. **Then the code, and only the code** — the confirmed module, reusing what
   exists. No new visual style, no adjacent-module changes, no drive-by cleanup.
5. **Then build it, run it, and hand over a click-by-click UI manual.**
6. **He reports bugs; fix them narrowly** — diagnose only what that bug touches.

The owner is not a programmer. He verifies every module by driving the running
app himself. That walkthrough is the acceptance gate, not a green test run.

---

## Claude-specific notes

**Use the tools, then stop.** This repository is large (~600 source files, a
412 KB SRS). `FUNCTION_MAP.md` is a reuse index of what already exists and how
to call it — read it *before* searching the codebase, and update it at the end
of a coding session. `docs/AI_HANDOFF.md` is the fastest way into the project
cold; `docs/CURRENT_STATE.md` says where it was left.

**Subagents.** Parallel read-only audits across disjoint areas work well here
and the codebase is big enough to reward them. Parallel *editing* agents do not,
unless you give each one an explicit, disjoint ALLOWED FILES list — this
repository's layers are tightly coupled through `packages/core-contracts`, and
two agents changing a contract at once produce a build that neither of them can
explain. Do not spawn agents unless the owner asks or the task genuinely
fans out.

**Do not create new `.md` files.** `AGENTS.md` names the canonical set:
`SRS_AND_BUILD_GUIDE.md` (what to build), `AI_CODING_INSTRUCTIONS.md` (how),
`AGENTS.md` (orientation), `FUNCTION_MAP.md` (what exists). The `docs/` folder
holds the four agent-handoff files added on 2026-09-02 at the owner's explicit
request — `AI_HANDOFF.md`, `CURRENT_STATE.md`, `NEXT_TASKS.md`, `DECISIONS.md`.
That is the whole list. No task logs, no progress READMEs, no module notes.
`docs/archive/` holds superseded planning documents — **do not read them**, they
contradict the current spec.

**Comment style.** This codebase writes rich prose comments that explain *why* a
decision was made, usually citing an SRS section or a dated owner decision.
Match that voice. A comment that only restates the code is noise here.

**The four gates, run from the repo root:**

```bash
pnpm build
pnpm typecheck        # 9 projects, including vue-tsc over the templates
pnpm lint
pnpm test:boundaries  # layering enforcement — never bypass
```

**Making a change visible in the running app** — the API runs from `dist`, not
from source, so a new service is invisible until the workspace packages are
rebuilt, and a new permission code hides its whole module from the sidebar until
the backfill script has run:

```bash
pnpm --filter "@sher/api..." build
cd apps/api && node --env-file=.env dist/migrate.js
node --env-file=.env dist/backfill-seed-roles.js   # easy to forget; hides the feature
# restart: node --env-file=.env dist/main.js
```

**Time.** `new Date()` and `Date.now()` are legal in exactly one file,
`packages/shared-utils/src/clock.ts`. Everywhere else takes time through the
`Clock` port. `pnpm test:boundaries` fails the build on any other use, including
in Vue components.

**Money and quantity** are integers in minor units — money scale 2, quantity
scale 3, unit cost scale 4. Float arithmetic on either is forbidden. Use the
helpers in `@sher/shared-utils` and the domain functions in `@sher/core-domain`;
never duplicate the arithmetic in a component.

**Two owner rules that are easy to violate without noticing:**

- **One modal for every one-task action.** Edit, delete, receive payment, pay
  supplier, return, refund, stock adjustment, owner withdrawal — all the same
  compact ~38rem two-column dialog, opened from the list or the document it acts
  on, never a route of its own. `StockAdjustDialog.vue` is the house pattern.
  A full page is only for a workflow genuinely too large for a modal (POS, a
  multi-line purchase, a stock count sheet).
- **Instant recalculation.** On any transaction screen every derived figure —
  line total, discount, grand total, paid, due, change, stock effect, party
  balance — updates as the user types. Waiting for a save or a reload is treated
  as a serious defect, not a nitpick.
