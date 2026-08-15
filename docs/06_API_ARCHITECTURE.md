# 06 — API Architecture

**Style:** REST + OpenAPI 3.1 · **Validation:** zod schemas in `core-contracts` · **Auth:** Bearer JWT

One API serves web, future desktop, future mobile, and MCP. There is no second "internal" API.

---

## 1. URL Conventions

```
/api/v1/{resource}                 GET (list) · POST (create)
/api/v1/{resource}/{id}            GET · PATCH
/api/v1/{resource}/{id}/{action}   POST   ← state transitions
```

**Tenant is never in the URL.** It comes from the token via `TenantContext`. A URL like `/api/v1/tenants/{tid}/sales` invites the exact ID-tampering attack the SRS forbids.

State changes are explicit actions, not PATCHes on a status field:

```
POST /api/v1/sales/{id}/post
POST /api/v1/sales/{id}/void
POST /api/v1/sales/{id}/return
POST /api/v1/periods/{id}/lock
```

`PATCH /sales/{id}` with `{status: "VOIDED"}` is rejected. Voiding has business consequences — reversal entries, stock return, ledger effects — and must run its own use case.

---

## 2. Request Envelope

Every **mutating** request requires an idempotency key:

```http
POST /api/v1/sales
Authorization: Bearer <jwt>
Idempotency-Key: 01JBXK7Q2N8YZ3M4P5R6S7T8V9    ← ULID, client-generated
Content-Type: application/json
```

Rules:

1. The client generates the key **before** the first attempt and reuses it on every retry.
2. Same key + same tenant ⇒ returns the **original** result with `200`, does not create a second record.
3. Same key + different payload ⇒ `409 IDEMPOTENCY_KEY_REUSED`.
4. Keys are retained 30 days.

This single mechanism serves network retries, POS double-click, offline replay, and MCP retries (A5). Do not build a second one.

---

## 3. Response Envelope

**Success — single:**
```json
{ "data": { "id": "01JBXK...", "documentNo": "INV-2026-000123", "totalMinor": 125075 } }
```

**Success — list:**
```json
{
  "data": [ ... ],
  "page": { "nextCursor": "01JBXK...", "hasMore": true }
}
```

**Error:**
```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Not enough stock for PVC Pipe 20ft",
    "details": { "productId": "01J...", "requestedQty": 10000, "availableQty": 4000 },
    "traceId": "01JBXK..."
  }
}
```

Rules:

1. **Money and quantity cross the wire as integer minor units**, with a `Minor` suffix on the field name. Never as a float, never as a formatted string. Formatting is the client's job.
2. `code` is a stable machine-readable enum from `core-contracts`. Clients switch on `code`, never on `message`.
3. `message` is human-readable English; translation happens client-side (D-12).
4. `traceId` appears in logs and in the diagnostic bundle — it is how an on-premise support ticket becomes debuggable.

---

## 4. Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | zod schema rejected the payload |
| 401 | `UNAUTHENTICATED` | Missing/expired token |
| 403 | `PERMISSION_DENIED` | Authenticated, lacks permission |
| 403 | `FEATURE_NOT_IN_PLAN` | Entitlement chain blocked it (D-23) |
| 404 | `NOT_FOUND` | Absent, **or** belongs to another tenant |
| 409 | `CONFLICT_STALE_VERSION` | Optimistic lock failure |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different payload |
| 409 | `PERIOD_LOCKED` | Business date falls in a locked period (D-25) |
| 422 | `INSUFFICIENT_STOCK` | Negative stock disabled and stock is short |
| 422 | `CREDIT_LIMIT_EXCEEDED` | Warning-only (D-11) — returned as a **warning**, not a block |
| 423 | `LICENSE_READ_ONLY` | On-premise license expired (D-24) |
| 500 | `INTERNAL_ERROR` | Never leaks a stack trace or SQL |

**Cross-tenant access returns `404`, not `403`.** Confirming a record exists in another tenant is itself a leak.

### Warnings vs errors

Some rules warn without blocking (credit limit, D-11). These return `200` with:

```json
{ "data": { ... }, "warnings": [ { "code": "CREDIT_LIMIT_EXCEEDED", "message": "..." } ] }
```

The client must display warnings. Silently swallowing them defeats the point of a warning-only policy.

---

## 5. Pagination

**Keyset only.** `OFFSET` is banned — it degrades exactly as a shop's history grows (R-14).

```
GET /api/v1/sales?cursor=01JBXK...&limit=50&from=2026-08-01&to=2026-08-15
```

- Default `limit` 50, maximum 200.
- Sort is fixed per endpoint (usually `business_date DESC, id DESC`) so the cursor stays stable.
- Filters use `business_date`, never `created_at`.

---

## 6. Validation

1. zod schemas live in `core-contracts` and are shared by the API and the Vue client. One definition, both sides.
2. Controller validates **shape only** — types, required fields, ranges.
3. **Business validation lives in the domain**, never in the DTO. "Quantity must be a positive integer" is a DTO rule. "Quantity must not exceed available stock unless negative stock is enabled" is a domain rule.
4. OpenAPI is generated from the zod schemas. It is never hand-written and never edited.

---

## 7. Authentication

| Token | Lifetime | Contents |
|---|---|---|
| Access | 15 min | `sub`, `tenant_id`, `roles[]`, `session_id` |
| Refresh | 30 days | rotating, revocable, stored server-side |

- Permissions are **not** in the token. They are resolved server-side per request, so a permission change takes effect immediately rather than after token expiry.
- Sensitive actions (D-07) require step-up: a recent password/OTP confirmation within 5 minutes, asserted by the use case, not the guard.
- On-premise mode uses the same tokens; only the identity verifier differs (D-21).

---

## 8. Controller Shape (binding)

```ts
@Post()
async create(@Body() dto: CreateSaleDto, @Ctx() ctx: RequestContext) {
  const result = await this.createSale.execute(toCreateSaleCommand(dto, ctx));
  return { data: toSaleResponse(result) };
}
```

Four lines. A controller that contains an `if` about business meaning, a calculation, or a repository call is a rejected change (R-B5).

---

## 9. MCP Alignment

MCP tools call the **same application services** as HTTP controllers — never the database, never a parallel code path.

```
MCP tool → auth → TenantContext → permission → application service → domain → DB
```

Every MCP mutation supplies an `operation_id` exactly as HTTP does. If an MCP tool needs something the API cannot express, the API is missing a use case — fix that, do not add a shortcut.

---

## 10. Versioning

- Path-versioned `/api/v1`. `v2` only for a genuinely breaking change.
- Additive changes (new optional field, new endpoint) do not bump the version.
- Removing or renaming a response field **is** breaking — on-premise customers may run an older client against a newer server for months.
