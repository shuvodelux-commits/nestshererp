# Workflow-Hub Software Design & Engineering Skill

## Purpose

Use this skill when designing, reviewing, refactoring, or extending business software where users perform many related tasks around the same person, document, account, product, asset, case, or operational context.

The goal is:

> **Simple outside, powerful inside.**
>
> Keep related work in one place, reduce navigation and repeated searching, and let many UI entry points reuse one authoritative business implementation.

This skill applies to ERP, CRM, clinic software, school systems, distribution software, garage/fleet systems, e-commerce operations, accounting tools, service-management software, and similar workflow-heavy applications.

---

# 1. Core Product Principle

A software module should not be only a list or CRUD page.

A major business module should be a **working hub**.

Examples:

- Customer hub
- Supplier hub
- Vendor hub
- Patient hub
- Student hub
- Vehicle hub
- Product hub
- Order hub
- Invoice hub
- Account hub
- Case/Ticket hub

When the user opens one business context, the software should expose the normal related work there.

Do not force this:

```text
Customer
→ back to menu
→ Payments
→ search same customer
→ save
→ back to menu
→ Sales
→ search same customer again
```

Prefer:

```text
Customer: Rahim Store
├─ Summary
├─ Ledger
├─ Sales
├─ Payments
├─ Returns
└─ Actions
   ├─ Receive Payment
   ├─ New Sale
   ├─ Return
   ├─ Correct
   └─ Print Statement
```

The user changes context only when they actually want to work on another business object.

---

# 2. Navigation Changes Context; Actions Do Work

Use navigation for major business areas.

Use contextual actions for work related to the thing already open.

Good:

```text
Customer → Receive Payment
Supplier → Pay Supplier
Invoice → Return
Order → Refund
Vehicle → Assign Driver
Patient → Add Prescription
Student → Record Payment
```

Bad:

```text
Customer
→ Payments module
→ choose payment type
→ search same customer
```

A user should never have to leave a record merely to perform a normal action related to that record.

---

# 3. Never Ask Again for Context the System Already Knows

If the software already knows the context, prefill it.

Examples:

```text
Customer → New Sale
```

The customer is already selected.

```text
Supplier → Pay
```

The supplier is already selected.

```text
Invoice → Return
```

The source invoice and eligible lines are already known.

```text
Product → Stock Movement
```

The product filter is already applied.

```text
Patient → New Prescription
```

The patient is already selected.

Do not make the user re-search or reselect known context unless changing it is explicitly allowed.

---

# 4. Centralized Daily Workspace + Contextual Entry Points

For high-frequency work, create one centralized operational workspace.

Examples:

```text
Daily
├─ POS
├─ Counter / Quick Transactions
├─ Daybook / Activity
└─ Reconciliation
```

or:

```text
Operations
├─ Orders
├─ Dispatch
├─ Returns
└─ Daily Review
```

The centralized workspace is for speed.

Contextual entry points are for convenience.

Both must reach the same underlying business function.

Example:

```text
Customer Hub ───────────────┐
Counter / Quick Receive ────┤
Invoice Detail ─────────────┤
Daybook ────────────────────┤
Global Search ──────────────┘
             ↓
      ReceivePaymentUseCase
```

There must not be a separate payment engine for every screen.

---

# 5. One Business Action = One Authoritative Function

This is a binding engineering rule.

If the same business action appears in several places, every caller must reuse the same authoritative module/interface/use case.

Example:

```text
Customer Ledger
Sales Invoice History
Invoice Detail
Daybook
```

may all expose:

```text
Edit / Correct Invoice
```

They must all call:

```text
InvoiceEditOrCorrectionUseCase
```

Do not create:

```text
CustomerInvoiceEdit()
SalesHistoryInvoiceEdit()
DaybookInvoiceEdit()
InvoicePageEdit()
```

The UI location is an entry point, not a new business implementation.

Apply this rule to:

- edit/correct
- receive payment
- make payment
- return/refund
- void/reverse/delete
- change transaction date
- approve/reject
- assign/unassign
- print/share when business state matters
- stock adjustment
- document update
- status transition

---

# 6. Reuse Existing Code Before Creating New Code

When working in an existing or partially built codebase, **read the function map first, then search**.

A project maintained this way keeps a `FUNCTION_MAP.md` at its root: an index of the reusable
functions, services, use cases, endpoints, database methods, shared components and important
business rules that already exist, with file paths and when to call each one (section 31). Consult
it before grepping, listing directories or opening files. Search the source only for what the map
does not answer.

Before creating a new:

- use case
- service
- function
- repository method
- endpoint
- composable
- store action
- dialog
- route
- page

build a reuse map.

Use this format:

```text
Required action
→ Existing owning module/interface
→ Existing implementation
→ Existing callers
→ Decision
```

Decision must be one of:

```text
REUSE
EXTEND
REPLACE
MISSING
```

Meaning:

- **REUSE**: already correct; call it.
- **EXTEND**: correct owner, but needs one reusable capability added.
- **REPLACE**: current implementation conflicts with the final design or architecture.
- **MISSING**: no implementation exists.

A new business implementation is allowed only for `MISSING`, or when a `REPLACE` is genuinely required.

---

# 7. Refactor the Current Module Before Building the Next One

If a partially built module has:

- duplicate business functions
- business logic in UI components
- wrong architecture
- broken workflow
- obsolete routes
- UI that conflicts with the final product direction
- two writers for the same business action
- known correctness defects

do not leave it unfinished and start the next module.

First:

```text
1. identify the authoritative business behavior
2. consolidate duplicate functions
3. repair the owning module/interface
4. migrate existing callers
5. fix the real UI
6. run focused tests
7. verify the full workflow in the running application
8. only then move to the next module
```

Refactor only the affected seam/module.

Do not use this rule as permission for unrelated cleanup.

---

# 8. Deep Modules, Thin Entry Points

Prefer a deep module with a small interface and substantial behavior behind it.

Example:

```text
Invoice module
├─ create
├─ edit/correct
├─ void
├─ return
├─ receive payment
├─ print/share
└─ audit/version rules
```

Many screens can call these functions.

The screens should remain thin.

Good architecture:

```text
Customer Hub ───┐
Daybook ────────┤
Invoice History ├──► Invoice module
Search ─────────┤
Invoice Detail ─┘
```

Bad architecture:

```text
Customer module has invoice logic
Daybook has invoice logic
Sales history has invoice logic
Invoice detail has invoice logic
```

The first design has high leverage and locality.

The second design creates divergence.

---

# 9. Hub Design Pattern

A business hub normally contains:

```text
Header
├─ identity
├─ current status
├─ important balance/state
└─ 1–2 primary actions

Optional summary
├─ due/payable
├─ open items
├─ recent activity
└─ important operational indicators

Related views
├─ overview
├─ ledger/history
├─ source documents
├─ payments
├─ returns/corrections
└─ notes/audit where relevant

Actions
├─ primary action
├─ frequent contextual actions
└─ More actions
```

Do not show everything with equal visual weight.

---

# 10. Progressive Disclosure

Simple UI does not mean few features.

It means few visible decisions at one time.

Use three levels.

## Primary

Most likely next action.

Examples:

```text
Receive Payment
New Sale
Pay Supplier
New Prescription
Assign Driver
Create Order
```

## Contextual

Frequent related work.

Examples:

```text
Invoices
Payments
Returns
Ledger
History
Appointments
Attendance
Stock Movement
```

## More

Infrequent, sensitive, or destructive work.

Examples:

```text
Correct
Void
Delete/Deactivate
Unlock
Merge
Change Date
Audit
Advanced Settings
```

Do not place 12 equally strong buttons on one screen.

---

# 11. Small Daily-Use Lists

List screens should show only the columns needed for daily decisions.

Do not show every database field.

Example party overview:

```text
Name
Phone
Address
Current Balance
⋯
```

The `⋯` menu may contain:

```text
View
Open Ledger
Edit
Delete / Deactivate
Other permitted contextual actions
```

Open the record for detailed history.

Do not permanently show:

- internal IDs
- metadata
- configuration fields
- audit fields
- optional profile fields
- rarely used attributes

unless the user needs them to make a normal list-level decision.

---

# 12. Ledgers and History Are Working Surfaces

A ledger/history screen should not be only read-only output when normal related work belongs there.

Example:

```text
Customer Ledger
```

may expose:

```text
Receive Payment
New Sale
Open Invoice
Return
Correct
Change Date
Print / Share
Void / Reverse
```

But every action must delegate to the owning business module.

The ledger itself must not become a second transaction engine.

---

# 13. Universal Review / Daybook Pattern

For systems with many daily transactions, provide one review surface.

Possible names:

- Daybook
- Daily Activity
- Transaction Review
- Operations Log
- Daily Journal

It should support:

```text
date/range
type filter
party/person filter
user filter
account/source filter
search
important totals
source-linked rows
```

Row actions should open the real source workflow.

Example:

```text
Sale row
→ Open Invoice
→ Receive Payment
→ Return
→ Correct
→ Void

Expense row
→ Open Expense
→ Correct
→ Change Date
→ Reverse
```

The review module must not implement these business rules itself.

---

# 14. Reconciliation Pattern

If the software must match system records against physical or external records, provide a dedicated reconciliation workflow.

Examples:

- cash vs physical count
- bank ledger vs bank statement
- stock vs physical count
- courier settlement vs delivered orders
- school fee records vs bank deposits

The reconciliation screen may launch:

```text
Open Source
Correct
Change Transaction Date
Add Missing Entry
Reverse Duplicate
Mark Reconciled
```

All mutations must still use the owning business functions.

Do not create a second editing engine inside reconciliation.

---

# 15. Preserve Business Date and Audit Date Separately

Where relevant, distinguish:

```text
Transaction / Business Date
```

from:

```text
Created / Entry Date
```

The business date answers:

> When did this business event belong?

The entry date answers:

> When did the system learn about it?

Changing the business date must not silently rewrite creation history.

This pattern is especially important for:

- accounting
- reconciliation
- backdated entry
- bank matching
- customer/supplier statements
- inventory adjustments
- audit investigations

---

# 16. Context Preservation

After an action launched from a hub or review screen, return the user to where they were.

Preserve when practical:

```text
record
tab
date basis
filters
search text
page/cursor
scroll position
```

Example:

```text
Customer Ledger
→ Receive Payment
→ Save
→ back to same Customer Ledger
```

not:

```text
Customer Ledger
→ Receive Payment
→ Save
→ Payments homepage
```

Context restoration is part of the workflow, not cosmetic polish.

---

# 17. UI Migration Rules for Existing Software

When migrating an existing screen, classify each element:

```text
KEEP
MOVE
REWIRE
REPLACE
REMOVE
```

Definitions:

- **KEEP**: behavior and placement already fit.
- **MOVE**: behavior is good; placement is wrong.
- **REWIRE**: UI is useful but calls the wrong/duplicate business path.
- **REPLACE**: behavior or architecture conflicts with final requirements.
- **REMOVE**: obsolete duplicate or dead UI after replacement is proven.

Do not rebuild a working page from scratch without explaining why reuse is insufficient.

---

# 17b. Choosing the UI Surface

| Surface | Use it for |
|---|---|
| Full page | major or complex workflows |
| Drawer / side panel | contextual work while preserving the current page |
| Small modal | short actions and confirmations only |

- Avoid nested modals and unnecessary temporary layers.
- On mobile, drawers may become near-full-screen and must remain keyboard-friendly.
- Preserve the current form, filter, tab, search and other useful page state across the surface.
- Whatever the surface, reuse the existing authoritative business logic, API, service or function. Never duplicate logic for a different UI entry point.

---

# 18. Visual Simplicity Rules

Prefer:

- compact operational density
- clear hierarchy
- one dominant action
- subtle secondary actions
- small number of visible columns
- consistent spacing
- consistent status badges
- responsive dialogs/drawers
- touch-friendly controls
- keyboard efficiency where useful
- loading, empty, error, permission states

Avoid:

- decorative cards with no business value
- repeated explanatory blocks
- excessive whitespace
- unnecessary page navigation
- permanent display of rare actions
- too many columns
- giant bilingual labels
- multiple UI libraries for the same job

---

# 19. Localized Helper Text Without Ruining Layout

When the application needs helper/local-language guidance:

Prefer a subtle inline form:

```text
Supplier — সাপ্লায়ার
```

where:

- primary language uses normal label styling
- helper language is smaller
- helper language is muted
- both remain visually one label

Avoid:

```text
Supplier
সাপ্লায়ার
```

under every field when it increases form/table height unnecessarily.

For compact surfaces such as:

- table headers
- icon actions
- narrow toolbars
- mobile rows
- compact filters

use an accessible tooltip/help affordance where visible helper text would make the design worse.

Tooltip rules:

- hover support
- keyboard focus support
- touch/tap path when information is important
- no bare browser `title`
- never hide critical financial/destructive meaning only in a tooltip

---

# 20. Tooltips as Secondary Guidance

Use tooltips where possible for:

- icon-only row actions
- abbreviated labels
- unfamiliar icons
- secondary local-language helper text
- compact table meanings
- less-common options

Do not use tooltips as a substitute for:

- primary action names
- critical status
- amount/due/payable
- destructive consequence
- required form meaning

---

# 21. Permission-Aware Actions

Do not render an action the user cannot execute.

Context menus, buttons, tabs, and shortcuts should be built from:

```text
entitlement
→ feature enabled
→ setting
→ permission
→ record state
```

The UI should not present actions that will predictably fail after click.

---

# 22. Corrections Instead of Unsafe Editing

For systems with auditable transactions:

- draft/unposted records may support ordinary edit/delete
- posted/committed records use correction/versioning
- delete may mean void/reverse
- historical effects remain traceable

The UI may use familiar language such as `Edit` or `Delete` if that is easier for users, but the internal behavior must preserve business integrity.

---

# 23. Testing Policy

Finish the complete module first. **Do not create new test code by default.**

- The only mandatory automated check is the existing **full `pnpm test` suite**, run once after the module is complete.
- If it fails because of unrelated pre-existing failures, report them briefly. Do not investigate or modify unrelated modules without the owner's explicit approval.
- Then give the owner a concise **manual checklist** covering the real UI, the calculations, the data flow and the business workflow.
- Additional permanent tests for critical logic — financial calculations, balances, FIFO/stock, payments, refunds, accounting, unit conversion, settlements and other data-critical rules — are optional and **require the owner's permission first**, and only after they have manually tested the module.
- No UI/E2E tests, mocks, fixtures or diagnostic tests unless the owner explicitly requests them.
- Never skip, weaken or delete an existing test.
- When the owner reports a problem, fix only the affected area and say what they should manually retest.
- Do not start the next module until the owner confirms the current one.

Binding version: `AI_CODING_INSTRUCTIONS.md` R-E.

---

# 24. Acceptance Checklist Before Moving to the Next Module

A module is not complete until:

- [ ] all required user paths work in the real UI
- [ ] existing code was searched before new code was created
- [ ] repeated business actions use one authoritative module/interface
- [ ] no duplicate writer remains
- [ ] known context is preselected instead of asked again
- [ ] save/cancel returns to the correct origin
- [ ] list views show only daily-use columns
- [ ] secondary actions are progressively disclosed
- [ ] permission-restricted actions are absent
- [ ] loading state works
- [ ] empty state works
- [ ] error state works
- [ ] permission-denied state works
- [ ] desktop workflow works where required
- [ ] tablet workflow works where required
- [ ] phone workflow works where required
- [ ] helper/local-language text does not damage layout
- [ ] tooltips are accessible where used
- [ ] the existing full `pnpm test` suite passes, run once on the completed module
- [ ] the owner received a manual checklist and confirmed the module
- [ ] FUNCTION_MAP.md records the reusable code this module added or changed
- [ ] current module has no known architecture/UI defect being deferred to “later”

Only then start the next module.

---

# 25. Stop Conditions

Stop and report instead of improvising when:

1. the same business action already exists but you are about to create another implementation;
2. two existing screens implement the same business rule differently;
3. the current module needs consolidation outside the allowed file scope;
4. the current code contradicts finalized business behavior;
5. a UI redesign would require changing business meaning;
6. the user experience requires a business rule that has not been decided;
7. a new abstraction would exist only to make code look “cleaner”;
8. the current module still has known defects and you are about to start the next module.

---

# 26. Questions to Ask During Design

For every major screen or workflow ask:

### Context
- What business object is the user working on?
- Does the system already know the object?
- Are we asking the user to select it again unnecessarily?

### Related work
- What are the next 3–5 actions users normally perform from here?
- Can those actions happen without leaving this context?

### Reuse
- Which existing function/use case already performs this action?
- Are multiple screens calling one implementation?
- Is any UI secretly calculating or posting business data itself?

### Simplicity
- What is the most common next action?
- Which controls can be hidden under More?
- Which columns can be removed from the list?
- Is the screen simple because the workflow is clear, or only because features were removed?

### Navigation
- Is this actually a new context, or merely an action?
- Does it deserve a sidebar item?
- Can a dialog/drawer/context action avoid a round trip?

### Existing code
- What already works?
- What can be kept?
- What should be moved?
- What must be rewired?
- What genuinely must be replaced?

---

# 27. Reference Architecture

```text
                        ┌─────────────────┐
                        │ Authoritative   │
                        │ Business Module │
                        │ / Use Cases     │
                        └────────┬────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
      Customer Hub          Daily Workspace       Daybook
            │                    │                    │
      Invoice Detail          Search              Reconcile
            │                    │                    │
            └────────────────────┴────────────────────┘

All entry points call the same business module.
No entry point owns a second implementation.
```

---

# 28. Reference Product Direction

Use this sentence when starting a new product:

> **Design the software as context-preserving workflow hubs. A user enters a Customer, Supplier, Patient, Student, Vehicle, Product, Order, Account, Case, or other business context and can perform the normal related work there without repeatedly returning to menus or re-searching known information. High-frequency work may also have a centralized daily workspace, but every entry point must reuse the same authoritative business functions. Keep the visible UI simple through progressive disclosure, compact daily-use lists, contextual actions, and preserved working state. If an existing codebase already implements part of the workflow, reuse and consolidate it before creating new functions or starting the next module.**

---

# 29. Ask Before Generating

**Before building any module, run the pre-build flow and wait for `START`:**

```text
Questions → owner's answers → final module specification → what will be added/changed/reused →
exact UI/workflow the owner will receive → files/modules expected to be affected → WAIT for START
```

- Ask **10–20 concise questions, only about unresolved decisions**. Fewer for a simple module.
- Never ask what the SRS, the project instructions, `FUNCTION_MAP.md`, existing code or a previously confirmed requirement already answers.
- Cover only real gaps: workflow, fields, business rules, permissions, edge cases, UI, mobile behaviour, integrations.
- Do not write code until the owner explicitly replies **`START`**.

Binding version: `AI_CODING_INSTRUCTIONS.md` R-Q.

---

# 30. Short Agent Instruction

Use this compact instruction when giving a coding agent a task:

```text
Build this as a workflow hub, not isolated CRUD pages.

Read FUNCTION_MAP.md before searching the codebase, and update it when you finish. Inspect the
current code the map points at and map every required action to an existing authoritative
function/use case. Reuse or extend that owner instead of creating screen-specific business logic.

Keep related work in the current context. Never ask again for a customer, supplier, invoice,
product, patient, student, vehicle, account, etc. when the origin already identifies it.

Use one business implementation from every entry point. Example: if invoice correction appears in
Customer Ledger, Sales History, Invoice Detail and Daybook, all four call the same invoice
correction module.

If the existing module is duplicated, structurally wrong or its UI conflicts with the final
workflow, consolidate/refactor that module and finish its real UI acceptance before starting the
next module.

Keep lists compact, put secondary actions in a row menu/More menu, preserve origin tab/filter/search/
scroll state after contextual actions, and use subtle inline helper text or accessible tooltips
instead of allowing guidance text to make the UI noisy.

Ask the unresolved questions and wait for START before writing code. Write no new tests: finish the
module, run the existing full `pnpm test` suite once, report any unrelated pre-existing failures
without touching those modules, and hand over a manual checklist for the real UI, calculations,
data flow and business workflow.
```

---

# 31. Context Economy and the Function Map

An agent — or a new engineer — starts each session knowing nothing about what the codebase already
contains. Two habits follow from that, and both are expensive without making the software better:
re-reading the repository to rediscover existing work, and re-running everything after every edit.

Bound both. **Cheaper work must never mean weaker work**: the point is to stop paying twice for
knowledge you already have, not to skip verification.

## The function map

Keep one file at the repository root, `FUNCTION_MAP.md`. It answers *what already exists, where it
lives, and when to call it* — nothing else.

Record, for each entry:

```text
Name            → what it is called in code
Location        → file path
What it does    → one line of business meaning
When to reuse   → the situation that should call it instead of writing new code
Notes           → constraints a caller must respect (transaction, permission, idempotency)
```

Cover:

- reusable functions and pure business/domain helpers
- application services and use cases
- API endpoints
- repository and database methods
- shared UI components, composables and formatters
- important business rules and where they are enforced

## Rules

1. **Read the map before searching the codebase.** It is the first lookup for any task. Search the
   source only for what the map does not answer, and then only in the area it points at.
2. **The map seeds the reuse map** (section 6). An action listed there is `REUSE` or `EXTEND` by
   default; calling it `MISSING` requires opening the file and saying why it does not fit.
3. **Update the map at the end of every coding session**, in the same commit as the work: new
   entries, changed signatures and behaviour, deleted entries for code that is gone. A session that
   produced nothing reusable says so and changes nothing.
4. **The map is an index, not a second architecture document.** Do not restate requirements, design
   rationale or architecture that is already written elsewhere; point at it. Duplicated
   documentation drifts exactly like duplicated code.
5. **If the map and the code disagree, the code is right.** Fix the map in that session rather than
   trusting a stale entry.

## Test cadence

- While building: no new tests, and no full-suite runs after every edit.
- Once the module is complete: the four gates (lint, types, architecture/boundary checks, the
  existing full test suite), with real output.
- Then the owner's manual checklist — real UI, calculations, data flow, business workflow.

See §23 for the full testing policy.

## What token economy never buys

- not reading a file you are about to change
- not reading the specification section the work depends on
- an unverified number, or an assumption left unstated
- a second implementation of a business action because searching felt expensive
- weaker security, auditability, correctness or maintainability, in any amount
