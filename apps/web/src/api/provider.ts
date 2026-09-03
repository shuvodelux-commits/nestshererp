import { request } from './client';

/**
 * What this installation is told about its software provider (Phase 17, §15, §19).
 *
 * Two facts, and neither of them is a permission: whether a vendor support
 * session is live right now, and which optional features the vendor has
 * switched off. Both are read by the shell on every page load and gated on no
 * role at all — a cashier standing at the till needs to see both.
 */
export interface ProviderStatus {
  readonly supportSession: {
    readonly operatorName: string;
    readonly reason: string;
    readonly startedAt: string;
  } | null;
  readonly featureFlags: readonly { readonly key: string; readonly enabled: boolean }[];
}

export function fetchProviderStatus(token: string): Promise<ProviderStatus> {
  return request('/api/v1/provider/status', { token, envelope: true });
}
