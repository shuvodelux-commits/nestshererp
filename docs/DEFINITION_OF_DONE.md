# Definition of Done

A module is **not** done because the code runs. It is done when it passes every gate below.

Three gates: **Automated** (CI decides), **Owner** (you decide, no programming needed), **Acceptance** (real transactions with pre-written numbers).

---

## Gate 1 — Automated (CI blocks the merge)

- [ ] `pnpm lint` passes — zero warnings
- [ ] `pnpm typecheck` passes — zero `any` introduced
- [ ] `pnpm test:boundaries` passes — no layering violation (R-B)
- [ ] `pnpm test` passes — **no skipped tests**
- [ ] Golden invariants `INV-01..INV-10` pass
- [ ] Cross-tenant isolation test exists and passes for **every** endpoint in the module
- [ ] Idempotency test exists for **every** mutation
- [ ] Permission tests: positive, negative per seed role, cost-visibility on the serialized body
- [ ] Migration runs clean on an empty DB **and** on a seeded DB
- [ ] OpenAPI regenerates with no manual edits
- [ ] Both `saas-smoke` and `onprem-smoke` boot gates green

---

## Gate 2 — Owner Review (60 seconds, no code reading)

- [ ] The agent pasted **real** test output with counts — not a description
- [ ] "Files changed" matches what the task asked for, nothing extra
- [ ] "Files intentionally NOT touched" is filled in
- [ ] No new dependency in `package.json` that you did not approve
- [ ] At least one assumption is stated (if "none", be suspicious)
- [ ] No `if (isOnPrem)` outside the three provider implementations
- [ ] Nothing in the diff writes business logic into a controller or a Vue file

---

## Gate 3 — Manual Acceptance (the one that matters)

**Rule: write the expected numbers before you run the scenario.** If you compute the expected number after seeing the result, you are not testing — you are agreeing.

For each scenario in the module spec:

- [ ] Expected numbers written down **first**
- [ ] Scenario executed in the real UI, not via API calls
- [ ] Every figure matches exactly — stock, cost, profit, ledger, cash, report
- [ ] Reversal path tested: void it, confirm everything returns to the prior state
- [ ] Backdated path tested where applicable
- [ ] Numbers still correct after a page refresh and a re-login

### Baseline scenario (run for every transactional module)

```
Create product → Purchase 10 @ ৳100 → Check stock = 10, valuation = ৳1,000
  → Sell 3 @ ৳150 → Check stock = 7, revenue = ৳450, COGS = ৳300, profit = ৳150
  → Receive ৳200 → Check customer due = ৳250, cash = +৳200
  → Check customer ledger, cash report, stock report, profit report all agree
  → Void the sale → Check stock = 10, profit = 0, ledger clean
```

Any disagreement between two reports is a **blocking** defect, never a rounding excuse (INV-10).

---

## Gate 4 — Module-Specific

- [ ] Every one of the 22 spec sections is addressed or explicitly marked N/A with a reason
- [ ] Audit events written for every mutation, with before/after money and stock values
- [ ] Permissions registered in the seed role matrix
- [ ] Reports reconcile to journal and movements — never computed from documents
- [ ] Offline/sync fields present where the module is offline-relevant (even though V1 does not sync)
- [ ] Reserved columns included (A10) — `location_id`, tax fields, `pack_size`, `device_prefix`
- [ ] Period lock respected for any document carrying a business date (D-25)

---

## Phase Exit

A phase ends when:

- [ ] Every module in the phase passes Gates 1–4
- [ ] The roadmap exit criteria for that phase are met
- [ ] Full regression suite green — including previous phases
- [ ] The baseline scenario still passes end to end
- [ ] Open risks discovered during the phase are added to `RISK_REGISTER.md`
- [ ] Owner signs off in `STATUS_LEDGER.md` with the date

---

## Never Done If

Any one of these means the work is not complete, regardless of what else passed:

| Condition | Why it is fatal |
|---|---|
| A test was skipped, weakened, or deleted to make CI pass | The suite is now lying |
| An expected number in a test was changed to match the output | The bug is now the specification |
| Money or stock computed with floating point | Guaranteed drift (R-05) |
| A posted document can be hard-deleted | Breaks auditability (D-03) |
| Two reports disagree | One of them is wrong and you cannot tell which (INV-10) |
| Business logic added to a controller or Vue component | Kills the future offline path silently (R-03) |
| `tenant_id` read from a request payload | Cross-tenant vulnerability (R-08) |
| The agent said "should work" without pasted output | Unverified (R-19) |
