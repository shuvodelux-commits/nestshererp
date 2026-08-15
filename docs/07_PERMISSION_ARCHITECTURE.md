# 07 — Permission Architecture

**Confirmed chain (SRS):**

```
Plan → Feature → Setting → Permission → Access
```

All five links must allow an action. Any one may deny it. The chain is evaluated **server-side, every request** — never cached in a token, never trusted from a client.

---

## 1. The Five Links

| Link | Question | Source | Failure code |
|---|---|---|---|
| **Plan** | Is this feature in the tenant's plan/license? | Subscription (SaaS) or license key (on-prem), via `EntitlementProvider` (D-23) | `FEATURE_NOT_IN_PLAN` |
| **Feature** | Is the module enabled for this tenant? | Settings — module on/off | `FEATURE_DISABLED` |
| **Setting** | Does business configuration allow it? | Settings — e.g. negative stock, backdating | `SETTING_FORBIDS` |
| **Permission** | Does this user's role grant it? | Role → permission codes | `PERMISSION_DENIED` |
| **Access** | Does this user reach this specific record? | Tenant scope + location/session scope | `NOT_FOUND` (never 403) |

Evaluation order matters: cheapest and broadest first. A user without the plan should never reach a per-record check.

---

## 2. Permission Codes

Format: `{module}.{resource}.{action}`

```
sales.invoice.create
sales.invoice.void
sales.invoice.backdate
purchase.order.approve
inventory.reconciliation.post
finance.expense.create
finance.period.unlock
report.profit.view
settings.module.toggle
daybook.transaction.edit
```

Rules:

1. Codes are **static string constants** in `core-contracts`. Never built by string concatenation at runtime — that defeats every static check.
2. A new code requires a new constant plus an entry in the seed role matrix. No dynamic permissions.
3. **Cost visibility is its own permission** (`inventory.cost.view`, `report.profit.view`). In a family-run shop, a cashier must be able to sell without seeing purchase cost or margin. This is the most commonly requested restriction in this market and it must not be an afterthought.
4. Destructive and financially meaningful actions get their **own** codes — `void`, `backdate`, `unlock`, `delete` are never bundled into `edit`.

---

## 3. Seed Roles

Shipped with every tenant; fully editable afterwards.

| Role | Intent |
|---|---|
| **Owner** | Everything, including period unlock, settings, user management. Cannot be deleted or de-privileged |
| **Manager** | All operations, cost and profit visible, no settings/user management, no period unlock |
| **Cashier** | POS sell, receive payment, view own session. **No cost, no profit, no purchase, no backdating** |
| **Storekeeper** | Stock in/out, reconciliation, lots. No pricing, no financial ledgers |
| **Accountant** | Ledgers, payments, expenses, bank, reports, period lock. No stock movement, no selling |
| **Viewer** | Read-only, no cost, no profit |

Every tenant has exactly one Owner at minimum. The system must refuse to remove the last Owner.

---

## 4. Where Checks Live

**Permission checks live in `core-application`, in the use case — not only in a controller guard.**

```ts
// core-application/sales/VoidSaleService.ts
async execute(cmd: VoidSaleCommand) {
  await this.access.require(cmd.ctx, 'sales.invoice.void');
  await this.period.assertOpen(cmd.ctx, sale.businessDate);   // D-25
  ...
}
```

Why not just a guard:

1. MCP, future offline, and background jobs bypass HTTP guards entirely.
2. A guard cannot see the record's business date, so it cannot enforce period lock or backdating rules.
3. One use case = one enforcement point = one place to audit.

The controller guard stays as a cheap early rejection, but it is **not** the authority.

---

## 5. Record-Level Access

| Scope | Rule |
|---|---|
| Tenant | Always. `tenant_id` from `TenantContext`, never from the request (D-22) |
| Location | If multi-location is enabled, a user is restricted to assigned locations (D-17) |
| Cash session | A cashier may only act on their **own** open session |
| Own records | Some roles may edit only what they created, within the same business day |

Denials at this level return **`404`**, never `403` — confirming a record exists in another tenant is itself a leak.

---

## 6. Step-Up Authentication

These require a fresh credential confirmation within the last 5 minutes (D-07), regardless of role:

- Void or delete a posted document
- Unlock a closed period
- Change inventory costing method
- Change financial terminology or accounting settings
- Export or restore a backup
- Create, disable, or re-privilege a user
- Transfer offline write authority (future)

Step-up is asserted **in the use case**, not in a UI dialog. A UI-only prompt is decoration.

---

## 7. Permission-Denied Behaviour

| Situation | Behaviour |
|---|---|
| Action not permitted | Hide the control in the UI **and** enforce server-side. Never render an enabled button that will 403 |
| Cost not visible | Column is absent from the API response, not rendered blank or zero. Never send data the user may not see |
| Profit not visible | Report endpoint omits the section entirely |
| Feature off in plan | Show an upgrade path (SaaS) or a licensing note (on-prem), not a raw error |

**Do not send data the client is expected to hide.** Hiding a cost column in Vue while the API returns the cost means anyone can read it in the browser network tab — and in a family business, that is a real and consequential leak.

---

## 8. Audit Interaction

Every permission **denial** on a mutating action is audit-logged with user, code, record, timestamp, and trace ID. Repeated denials by one user are a meaningful signal — either a misconfigured role or someone probing.

Denials on read actions are logged in aggregate only, to avoid flooding the audit table.

---

## 9. Testing (mandatory per module)

Per R-E5, every module ships with:

1. **Positive** — permitted role succeeds.
2. **Negative** — each unpermitted seed role receives the correct code.
3. **Cross-tenant** — tenant B receives `404` for tenant A's record, on every endpoint.
4. **Cost visibility** — a Cashier response contains no cost or profit field anywhere in the payload.
5. **Step-up** — a sensitive action without recent confirmation is rejected even for the Owner.

Test 4 is checked against the **serialized response body**, not the UI. That is the check that catches the leak described in §7.
