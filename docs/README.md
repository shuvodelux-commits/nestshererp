# SherERP — Development Planning Package
**Based on:** `SherERP_Master_SRS_v3.md` (v3.0, 2026-08-14) · **Package date:** 2026-08-14 · **Phase:** planning only, no code

> ## ▶ Ready to build
> All decisions D-01 → D-32 are final.
> 1. **`START_BUILDING.md`** — what to install, how to set up the repo, the weekly rhythm
> 2. **`PHASE0_START_HERE.md`** — three ready-to-paste Phase 0 prompts + exit checklist
>
> Do not start Phase 1 until every Phase 0 box is ticked.

## Read in this order

| # | Document | Read it for |
|---|---|---|
| 1 | `00_REQUIREMENTS_VALIDATION.md` | What is contradictory, missing or risky in the SRS |
| 2 | `OPEN_DECISIONS.md` | The 32 final decisions (D-01..20 product · D-21..24 deployment · D-25..32 implementation) |
| 2b | `AI_CODING_RULES.md` | **Binding** rules for every coding agent — read before any prompt |
| 2c | `11_DEPLOYMENT_STRATEGY.md` | SaaS vs on-premise: one build, config-selected mode; license, install, upgrade |
| 3 | `STATUS_LEDGER.md` | CONFIRMED / RECOMMENDED / HIGH-RISK status tracking |
| 4 | `02` / `04` / `06` / `07` / `11` architecture docs | The validated architecture |
| 5 | `IMPLEMENTATION_ROADMAP.md` + `MODULE_DEPENDENCY_MAP.md` | What gets built, in what order, and why |
| 6 | `13_`, `23_`, `32_` module specs | Full 22-section specs for the highest-risk modules |
| 7 | `PHASE0_START_HERE.md` + `00_PROMPT_KERNEL.md` | Ready-to-paste prompts for Claude Code / Codex / GPT agents |
| 8 | `RISK_REGISTER.md`, `DEFINITION_OF_DONE.md` | How quality is enforced |

## Package contents

Everything listed below **exists in this folder**. Nothing here references a document that has not been written.

```text
START HERE
  PHASE0_START_HERE.md          ← three ready-to-paste Phase 0 prompts + exit checklist
  00_PROMPT_KERNEL.md           ← paste at the top of every agent prompt

BINDING RULES (agent must read before coding)
  AI_CODING_RULES.md            R-A..R-H, forbidden patterns, owner checklist
  DEFINITION_OF_DONE.md         four acceptance gates

DECISIONS & STATUS
  OPEN_DECISIONS.md             D-01..D-32, all final
  OPEN_DECISIONS_User_note.md   owner's original answers
  STATUS_LEDGER.md              CONFIRMED / RECOMMENDED / HIGH-RISK
  RISK_REGISTER.md              R-01..R-29
  Note.md                       owner's raw notes

ARCHITECTURE
  02_ARCHITECTURE_PLAN.md       packages, layering, write path
  04_DATABASE_ARCHITECTURE.md   ULID, tenancy, money/qty, invariants INV-01..10
  06_API_ARCHITECTURE.md        endpoints, errors, idempotency, pagination
  07_PERMISSION_ARCHITECTURE.md entitlement chain, roles, where checks live
  08_OFFLINE_SYNC_ARCHITECTURE.md   future offline (deferred)
  11_DEPLOYMENT_STRATEGY.md     SaaS vs on-premise, license, install, upgrade
  SYNC_PROTOCOL.md              future sync wire protocol (deferred)

PLAN
  IMPLEMENTATION_ROADMAP.md     15 phases
  MODULE_DEPENDENCY_MAP.md      build order and why
  00_REQUIREMENTS_VALIDATION.md SRS contradictions and gaps

MODULE SPECS (full detail)
  13_inventory_lots_costing.md
  23_WARRANTY_MODULE.md
  32_DAYBOOK.md

SOURCE
  SherERP_Master_SRS_v3.md
  SherERP_Full_SRS_Review_Validation_v2.md
  Requirment_validation_Finished_note.md
```

**Remaining module specs are written at the start of their phase**, not now. A spec written months ahead of its phase encodes decisions that have not been made and goes stale before an agent reads it. The three above are full because Phases 3, 8 and 9 depend on them and they carry the highest correctness risk.

## Spec expansion policy

A module spec is expanded to FULL at the start of its phase, using `32_DAYBOOK.md` as the format template
(22 sections). Specs written months ahead encode decisions that have not been made and go stale before an
agent reads them. Three are FULL now because they carry the highest correctness risk.

## Before any code is written

Decisions **D-01 → D-32 are final** and are implementation constraints, not discussion points.

- V1 = Vue 3 + NestJS + Drizzle + **PostgreSQL**; business-specific repository interfaces from day one
- Mobile = **PWA**; React Native deferred and likely dropped (D-28)
- Full SQLite / Tauri offline is a **future phase**; V1 browser offline is temporary IndexedDB support
- SaaS and on-premise are **one build**, mode selected by configuration (D-21..D-24) — never a fork
- An agent hitting a case not covered by a decision must **STOP and report** (R-A5), never improvise

Start at `PHASE0_START_HERE.md`.
