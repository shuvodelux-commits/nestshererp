# HisabIQ adoption preflight — 2026-11-10

Setup is configured; the application baseline is not accepted. No coding worker
was dispatched and no suite, merge, migration or deployment was run in setup.

## Scope and identity

- Repository: shuvodelux-commits/nestshererp.
- Integration branch: chore/hisabiq-adoption-runtime-a01.
- Adoption baseline: 76421b07028c4496f8b743df050a5ebbf3249ef2.
- Upstream Super Board 3.3.0 bundle: d0b7d5a6850614ca809477c1af43d5d7da408726.
- Config: .claude/super-board/configs/hisabiq-nest-adoption.json.
- Board: https://github.com/users/shuvodelux-commits/projects/2
- Selected issue: https://github.com/shuvodelux-commits/nestshererp/issues/1
- One Codex worker; every merge requires the owner; no permitted migration environments.
- GitHub and Codex sign-in were verified; full worker execution remains unverified.

## Retained evidence

| Check | Result |
|---|---|
| Installer/setup check for Codex | exit 0; installed lane skills, hooks and required helpers resolve |
| Verification configuration gate | exit 0; real owning-repository commands configured |
| Codex launcher shell syntax | exit 0 |
| Wrapped workflow JavaScript syntax | exit 0 |
| Relative host links | all resolve; no absolute host links |
| Full workspace build | exit 0, observed 2026-11-09; large Vite chunk warning |
| Full workspace typecheck | exit 0, rerun 2026-11-10 |
| Lint | exit 1; corrections.spec.ts:53 unused drawerCode |
| Boundary enforcement | exit 1; corrections.spec.ts:180 direct new Date() |
| API health | HTTP 200 on 127.0.0.1:3000/health after 2026-11-10 restart |
| Reference Vue web | HTTP 200 on 127.0.0.1:5173 after restart |

The command wrapper completed successfully while recording failing child checks.
Its outer exit is not a passing application gate. Actual per-command exits are
retained in the restricted local state directory as super-resume-checks.json.
Logs use super-setup-* and super-resume-* names in that same directory.

Use isolated pnpm 9.15.9 via `npm exec --yes --package=pnpm@9.15.9 -- pnpm`.
The configured dependency install is frozen and uses engine-strict=false for the
previously recorded Node 24 local probe. The Node 20 manifest pin is unresolved;
this is not a declaration of complete Node 24 support or production readiness.

## Scope adjustment for installed tools

The initial lint run saw 51 additional errors inside third-party agent tools
and their host links. ESLint now excludes only .agents/, .claude/ and .codex/.
All application sources and the existing corrections fixture remain linted;
no lint rule or boundary rule was disabled. The final lint result is again the
single pre-existing application error.

The helper installer targeted Claude only. Its required downloaded helpers were
placed in the shared .agents tree and linked to Codex and Claude. Unrequested
helper installs from this attempt were removed. The existing verification and
testing-strategy helpers were reused; optional security-audit is installed but
was not run. Claude hooks do not prove native Codex hook enforcement.

## Dispatch gate

Issue #1 is Blocked and human-gated because AGENTS.md R-0 requires an explicit
current-session owner request before editing existing test files. Permission
must cover only the unused fixture bookkeeping and direct Date construction,
preserving fixture side effects, tenant-local date semantics and assertions.
Suites stay disabled. Record permission, remove human-gated and move only that
card to Ready. Its build should produce a draft PR for human review.

Current allowed checks: install, build, typecheck, lint and test:boundaries.
Later business-module QA/TDD policy must be resolved separately; these static
checks do not establish accounting, isolation or production acceptance.
