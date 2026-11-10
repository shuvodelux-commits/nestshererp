# HisabIQ adoption issue tracker

Board: https://github.com/users/shuvodelux-commits/projects/2
Repository: shuvodelux-commits/nestshererp
Base: chore/hisabiq-adoption-runtime-a01

One selected card, one worktree and one draft PR. Every merge needs the owner.
Use the installed writing standard at
`.agents/skills/super-board/references/writing-standard.md` for complete examples.

## Ticket format

Each issue contains Problem, Context (actual path, baseline and evidence), Fix,
Acceptance Criteria (2–5 observable checkboxes), Risk and Blocked by sections.
Use `- #N — reason` for issue dependencies, or exactly `- None.`.
A permission hold uses the human-gated label and a structured blocker comment;
its final line is `blocked-by: -`.

Existing R-0 restrictions remain binding: do not author or execute test suites
without explicit current-session permission. Configured checks are frozen
installation, build, typecheck, lint and test:boundaries. A01b must receive a
specific exception for its existing test file before entering Ready. No worker
may infer test authorization from a generic continue instruction.

Keep adoption requirements and decisions in the canonical SRS and DECISIONS;
use issue bodies and comments for task scope and proof. Never use the old
hisabiq-backend board as the adopted repository's queue.


## Approved module execution contract

Before a coordinator dispatches any module, record the following in its GitHub
issue. Reference canonical SRS sections; do not copy a permanent module spec.

| Field | Required evidence |
|---|---|
| Overview and approval | 10–15 plain-English sentences; plan revision; dated owner approval/link for this revision and chosen environment; no second START confirmation |
| Environment | Owner's chosen method; actual executor/runner identity; repository, shell, browser, database and network capability results |
| Ownership | Unique chat/session identifier; coordinator confirmation; assignee for display; started/paused/released state |
| Source | Repository, base branch + full SHA, module branch, worktree path or cloud checkout identifier |
| Scope | Allowed paths, SRS references, explicit exclusions, dependencies and acceptance criteria |
| Shared ownership | Contract/schema/migration and canonical-doc owner; reserved migration numbers; overlapping paths and dispatch/merge sequence |
| Isolation | Disposable development DB identifier per chat, runtime ports/origin, secret reference names only; no production data or committed credentials |
| Verification | Exact frozen install/build/typecheck/lint/test:boundaries commands; interactive runtime/manual UI steps where applicable; no suites by default |
| Handoff | Draft PR, source/head SHA, reviewed paths, actual command exits and evidence, incomplete ACs/blockers, precise resume action |

**Coordinator protocol:** Re-read issue, all comments, linked PR and head, and
board before confirming ownership or resuming. A claimed module belongs only to
its recorded session. Shared-account assignees and comments are coordination
records, not atomic compare-and-set locks. If ownership conflicts, pause the
new dispatch and reconcile with the coordinator; do not reclaim another chat.
Workers operate only on the assigned issue, never drain the board or sweep other
sessions. Keep the existing one-worker runner configuration unchanged.

For five chats, coordinator records five issue plans using the contract above
and a dispatch table **on GitHub**, not a competing specification document:

| Slot | Issue / approved revision | Owner session | Branch / base SHA | Worktree / DB | Allowed paths / shared owner | Depends on / sequence |
|---|---|---|---|---|---|---|
| 1 | pending | unassigned | pending | pending | pending | hold |
| 2 | pending | unassigned | pending | pending | pending | hold |
| 3 | pending | unassigned | pending | pending | pending | hold |
| 4 | pending | unassigned | pending | pending | pending | hold |
| 5 | pending | unassigned | pending | pending | pending | hold |

This is a blank dispatch format, not five approved product plans. Dispatch only
filled, owner-approved rows. Disjoint paths may proceed independently; common
contracts, canonical docs or migrations are explicitly serialized before work.
Owner-directed merges are always serial. A material plan or environment change
needs a revised overview and fresh approval. Each finished module gets a PR.

**Environment reporting:** Remote computer access must prove a shell and runtime
on that computer; Codex Cloud must prove its own checkout, setup and isolated DB;
a GitHub connector proves repository access only, not command execution. A
connector-only chat hands off to a verified authorized runner and records that
runner's command results, or marks execution blocked. Never equate a manual
source edit with an executed headless Super Build run. Follow helper readiness,
quota/read guards and PR author notes from the installed bundle in each executor.


Approval must name or unambiguously refer to the reviewed plan revision and
chosen environment. The owner's "Approved" is sufficient; never demand a second
START message. Coordinator-confirmed distinct session ownership is required
before dispatch. A resumed approved plan can continue after GitHub reconciliation.
