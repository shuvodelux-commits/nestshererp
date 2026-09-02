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
  /**
   * The short permanent code of the machine this work is being done on, when
   * it is a registered one (Phase 12.4, §8 of the owner's specification).
   *
   * It reaches document numbering and nothing else: a sale is numbered
   * `S-2026-A-000123`, where `A` is this machine and the sequence is its own.
   * Absent — an unregistered browser, a background job, a replay whose device
   * row has gone — means the shop's central counter, whose reserved code is
   * `0`. Codes assigned to devices are always letters, so the two can never
   * collide and no number ever has to be reissued.
   *
   * Set from the verified device key by the API, never from a request body
   * (R-C4), and set by sync replay from the device that actually typed the
   * document — because the number on the customer's paper says which machine
   * made it, and that must stay true a year later.
   */
  readonly deviceCode?: string | null;
}
