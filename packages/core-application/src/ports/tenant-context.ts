/**
 * Who is acting, and inside which tenant.
 *
 * Built by apps/api from the verified JWT and by MCP from its own auth — NEVER
 * from a request body, query string or URL parameter (R-C4). Every repository
 * query and every write takes its tenant_id from here.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  /** Tenant timezone, e.g. `Asia/Dhaka` — business dates are computed in it. */
  readonly timezone: string;
}
