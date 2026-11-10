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
