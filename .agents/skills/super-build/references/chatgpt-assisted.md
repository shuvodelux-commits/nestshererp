# ChatGPT-assisted Super Build — GitHub → Remote Desktop Commander → GitHub

**Status:** tested 2026-11-13. This is an additional ChatGPT-operated adapter for the installed [Super Build skill](../SKILL.md), not native `/super-build` ChatGPT host support.

## Owner-selected workflow

ChatGPT is the **only coding agent**. It authors tests and source directly on a task-specific GitHub feature branch, then calls **@Remote Desktop Commander** on the authorized CachyOS machine to execute `.agents/bin/super-build-chatgpt.py`. The adapter performs only GitHub source checkout, prescribed verification and receipt generation; ChatGPT then opens a draft PR in GitHub. It **does not** launch Codex, Claude, OpenCode, another model, a background worker or the Super Board Ready queue.

Multiple independently approved module chats may build concurrently **without a fixed number such as five**. The actual limit is the number of safely isolated execution sessions supported by current CPU/memory, separate worktrees/test databases and accepted dependencies. Shared contracts, schemas/migrations, permissions, cash-session and financial posting owners and PR merges remain serialized.

## Three commands

**Prepare:** Require canonical GitHub issue URL, correct remote and existing feature branch, approved exact 40-hex base and head SHAs, new absolute worktree, new external receipt path and explicit repeated `--allow` filenames. Verify clean source checkout, fetch GitHub, validate ancestry/HEAD and changed paths, then create a **detached** worktree. Never overwrite an existing worktree or receipt.

**Verify:** Before every step, revalidate worktree HEAD/origin/cleanliness and changed-file allowlist. Accept only fixed `--check` presets: `python-version`, `install` (offline, frozen, ignore scripts), `build`, `typecheck`, `lint`, `boundaries`. Preserve each exit/elapsed/clean result in a local receipt. Fail closed on errors and never accept an arbitrary shell command or model name. If a failed check is retried successfully, retain the failed attempt in the history.

**Finalize:** Confirm the exact source state and require each attempted check's **latest** result to pass. Return structured JSON, `state: verified`, the source SHA, changed files, successful checks, total attempts and recovered failures. This does not create/merge a PR, authorize a deployment, prove UI parity or approve financial correctness.

## Example, executed BY ChatGPT through Remote Desktop Commander

Replace placeholders with the live approved task, SHA pair, exact file allowlist and unused paths:

```bash
LAUNCHER=/path/to/approved/nestshererp/.agents/bin/super-build-chatgpt.py
python3 "$LAUNCHER" prepare \
  --repo /path/to/clean/backend-checkout \
  --remote https://github.com/shuvodelux-commits/nestshererp.git \
  --branch task-specific-github-branch \
  --base FULL_APPROVED_BASE_SHA --head FULL_APPROVED_HEAD_SHA \
  --issue https://github.com/shuvodelux-commits/nestshererp/issues/ISSUE_NUMBER \
  --worktree /path/to/new/isolated-worktree \
  --receipt /path/outside/repositories/unique-receipt.json \
  --allow exact/approved/path-one.ts \
  --allow exact/approved/path-two.ts
python3 "$LAUNCHER" verify --receipt /path/outside/repositories/unique-receipt.json --check install
python3 "$LAUNCHER" verify --receipt /path/outside/repositories/unique-receipt.json --check build
python3 "$LAUNCHER" verify --receipt /path/outside/repositories/unique-receipt.json --check typecheck
python3 "$LAUNCHER" verify --receipt /path/outside/repositories/unique-receipt.json --check lint
python3 "$LAUNCHER" verify --receipt /path/outside/repositories/unique-receipt.json --check boundaries
python3 "$LAUNCHER" finalize --receipt /path/outside/repositories/unique-receipt.json
```

## Scope and limitations

- Before `prepare`, **ChatGPT** checks owner approval, exact issue scope/allowlist, active GitHub Project task claims, paired repository SHAs, dependencies, remote computer authorization and exclusive shared-file ownership. The adapter checks the actual git source and execution environment; it is **not** a distributed lock or owner-approval oracle.
- The adapter **never writes application code locally**. A failed or stale source must be fixed on GitHub; for a new HEAD, use a new isolated worktree/receipt. Never mutate a detached checkout to fabricate success.
- V1 does **not** run database suites. The owner must separately authorize any DB test; ChatGPT uses Remote Desktop Commander with a brand-new disposable PostgreSQL container/database/port and explicitly verified test URLs. Never reuse a development/production DB.
- No automatic GitHub PR publication, issue status change, merge, deployment, DB migration, worker launch or cleanup. ChatGPT finishes the GitHub draft PR and hands it to independent QA and human merge review.
- The legacy host detector still rejects ChatGPT (exit 65); this script is an **assisted command launcher**, not a ChatGPT headless API or native `/super-build` host. Do not invoke `codex exec`, `claude -p`, OpenCode, a fake host flag or any queue-draining dispatcher.
- Receipt files must be kept outside Git worktrees and not committed, and must not expose credentials. Do not release another chat's worktree or build reservation.

## Test evidence (2026-11-13)

- The launcher was authored on GitHub test-first. Its disposable local-git test suite first failed RED because the launcher was missing, then passed **13/13** after implementation, including origin/SHA/path, dirty checkout, existing destination, blocked arbitrary model names and retry-history guards.
- Real ChatGPT/RDC pilot fetched existing [D08 PR #33](https://github.com/shuvodelux-commits/nestshererp/pull/33) at `e403d4ad37d82eccea76294b830ff5cadae1194e` into a **second isolated worktree**. `prepare`, `install`, `build`, `typecheck`, `lint`, `boundaries` and `finalize` completed. First typecheck failed because workspace package build output was absent; after `build`, typecheck passed. Final receipt: **verified, seven attempts, one recovered failure**.
- The separate earlier PR #33 Parties API 32/32 disposable-PG16 tests were **not rerun by this new launcher**. The launcher pilot was static/build verification, not database validation.
- Desktop Node 24 warned that this backend targets Node 20. Node20 CI, independent accounting/security QA and human merge remain separate checks.

**Rule:** write code on GitHub → use ChatGPT plus authorized Remote Desktop Commander to run this isolated Super Build verification → finalize a draft PR and independent QA on GitHub. Run any number of *safe nonoverlapping* module chats justified by actual capacity, not exactly five.
