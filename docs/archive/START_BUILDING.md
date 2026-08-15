# Start Building — Setup and Working Rhythm

For a product owner who is not a programmer, working through AI coding agents.

---

## Part 1 — Install on Your PC (one afternoon)

| # | Tool | Why | Check it worked |
|---|---|---|---|
| 1 | **Node.js 20 LTS** | Runs everything | `node -v` → `v20.x` |
| 2 | **pnpm 9** (`npm i -g pnpm`) | Package manager the monorepo needs | `pnpm -v` → `9.x` |
| 3 | **Git** | Version history = your undo button | `git --version` |
| 4 | **Docker Desktop** | Runs PostgreSQL without installing it | `docker --version` |
| 5 | **VS Code** | Where you'll read diffs and run commands | Opens |
| 6 | **Claude Code** (VS Code extension or CLI) | Your main coding agent | Responds in a chat |

Do not install PostgreSQL directly — Docker gives you a clean, resettable database.

**Verify the whole chain before writing any code:**

```bash
docker run --name sher-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16
docker ps        # should list sher-pg as running
```

If that works, your machine is ready.

---

## Part 2 — Accounts and Backups (30 minutes)

| Item | Why it matters |
|---|---|
| **GitHub account + private repo** | Every version of your code, recoverable. Non-negotiable |
| **GitHub Actions enabled** | Runs your CI gates automatically — this is what enforces the rules for you |
| **Claude subscription** | Your main agent |
| A second agent (Codex / GPT) | Useful as a *reviewer* — a different model catches what the first missed |

**Set up the repo before the first prompt:**

```bash
mkdir shererp && cd shererp
git init
mkdir docs
# copy every .md from this folder into docs/
git add . && git commit -m "Planning package"
# create private repo on GitHub, then push
```

The agent reads its rules from `docs/`. If the docs aren't in the repo, the agent has no rules.

---

## Part 3 — Understand These Three Things First

You don't need to code, but you must understand these or you cannot judge the work.

**1. What a diff is.** A diff shows what changed — red removed, green added. You'll read these daily. VS Code shows them visually. You don't need to understand every line; you need to spot *files that shouldn't be there*.

**2. What a test run looks like.**

```
Test Suites: 12 passed, 12 total
Tests:       87 passed, 87 total
```

That is evidence. "All tests should pass" is not evidence. Learn to tell them apart — it is your single most valuable skill on this project.

**3. What a migration is.** A file that changes the database structure. Once one runs on real data, undoing it is hard. Treat any diff containing a migration with extra care.

---

## Part 4 — Your Weekly Rhythm

```
Monday      Read the phase goal. Pick ONE slice.
Tue–Thu     Prompt → review plan → let it code → review diff → run tests
Friday      Manual acceptance with pre-written numbers. Commit. Update STATUS_LEDGER.
```

**Per slice, the loop is always:**

```
1. Paste KERNEL + task block
2. Agent replies with a PLAN        ← read this, it is your cheapest checkpoint
3. Plan looks wrong? Stop here. Fixing a plan costs minutes; fixing code costs days.
4. Approve → agent writes code
5. Agent pastes real test output    ← if it didn't, ask again. Do not proceed.
6. You read the diff against the Owner Checklist in AI_CODING_RULES.md
7. You run the manual scenario yourself
8. Commit
```

**Never skip step 7.** Automated tests written by the agent that wrote the bug will happily agree with the bug. Your manual scenario with numbers written *beforehand* is the only independent check in the whole system.

---

## Part 5 — Order of Play

| Phase | What you'll see working | Feels like |
|---|---|---|
| **0** | Nothing. Just `/health` returning OK | Slow and pointless — it is neither |
| **1** | Login, users, roles, settings, audit | First real screen |
| **2** | Products and parties | Starting to look like software |
| **3** | Stock, lots, costing | The heart of the system |
| **4** | Cash and bank accounts | — |
| **5** | **Purchase → stock → supplier due → payment** | First complete business cycle |
| **6** | **POS / Sales** | The moment it becomes an ERP |
| **7+** | Returns, expenses, reports, Daybook | Filling out |

**Phase 0 produces nothing you can show anyone.** That is expected and correct. It builds the boundary checker, the money types, and the tenant context — the three things that cannot be added later. Every hour spent there saves ten later.

**Phase 5 is your first real milestone.** When you can buy stock, see it in inventory, pay the supplier, and watch the ledger and cash agree — the architecture is proven. Everything after that is repetition of a pattern that already works.

---

## Part 6 — Before Each Phase

- [ ] Read the phase row in `IMPLEMENTATION_ROADMAP.md`
- [ ] Expand the module spec to full detail (use `32_DAYBOOK.md` as the format template)
- [ ] **Write the manual test scenarios with expected numbers — before any code exists**
- [ ] Confirm the previous phase's exit checklist is fully ticked

That third box is the one people skip. Numbers written after seeing the output aren't a test — they're agreement.

---

## Part 7 — Rules for Talking to the Agent

**Always say:**

> Run `pnpm lint && pnpm typecheck && pnpm test:boundaries && pnpm test` and paste the real output with pass/fail counts. If any command fails, the task is not complete.

**Never say:** "make sure tests pass" — that's what an agent says back when it hasn't run them.

| Agent says | You say |
|---|---|
| "I need to install library X" | "No. How do you do it without a new dependency?" |
| "I improved the business rule to…" | "Stop. Decisions are final in OPEN_DECISIONS.md. Revert it." |
| "Tests should pass now" | "Paste the actual output." |
| "I also refactored some other files" | "Revert everything outside the ALLOWED FILES list." |
| "This is a bit unusual, normally you'd…" | "Follow the spec. If the spec is wrong, report it — don't change it." |

**One slice per conversation.** When a chat gets long, the agent starts forgetting the rules at the top. Start fresh, re-paste the kernel.

---

## Part 8 — When Things Go Wrong

| Symptom | Do this |
|---|---|
| Tests fail and the agent wants to change an expected number | **Stop.** The number in the spec is right until you decide otherwise. Investigate the code |
| Two reports show different totals | Blocking defect (INV-10). Do not build further until it's resolved |
| Agent has touched 40 files for a small task | Reject entirely. Re-prompt with a tighter ALLOWED FILES list |
| You don't understand the diff | Ask a second agent: "Explain what this change does and what could break" |
| Something worked yesterday, broken today | `git log` — find what changed. This is why you commit every working slice |
| You feel lost | Go back to the last green commit. Never build on top of something you don't trust |

**Commit every time something works.** A commit is a save point. Cheap to make, priceless when you need one.

---

## Part 9 — Honest Expectations

- **Phase 0–2 will feel disproportionately slow.** You're building foundations and machinery. This is normal.
- **Phase 5–6 is where it becomes real software.** Purchase and sales working end to end.
- **Something will be wrong in the money math at least once.** That's why the invariants and manual scenarios exist. They will catch it — if you actually run them.
- **You will be tempted to skip Phase 0's boundary checker** to get to visible features. Don't. It's the one thing that cannot be retrofitted, and it's what keeps your offline plan alive.
- **Your biggest risk is not bad AI code.** It's accepting good-looking AI code without verifying the numbers (R-19, your top-rated risk). The defence is one habit: write the expected numbers first, then check them yourself.

---

## Today's Checklist

- [ ] Install Node 20, pnpm, Git, Docker, VS Code, Claude Code
- [ ] Verify Docker runs PostgreSQL
- [ ] Create the private GitHub repo
- [ ] Copy all planning `.md` files into `docs/` and commit
- [ ] Read `AI_CODING_RULES.md` — especially the Owner Checklist at the end
- [ ] Open `PHASE0_START_HERE.md`
- [ ] Paste the KERNEL + Prompt 0.1

Then you've started.
