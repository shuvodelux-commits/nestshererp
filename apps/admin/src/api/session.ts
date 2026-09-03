import { reactive } from 'vue';

import { api, clearToken, storedToken, storeToken } from './client';

/**
 * Who is signed in, and what they may do.
 *
 * Permissions come from the server on every load rather than from the token, so
 * a role change or a disablement takes effect on the next page rather than at
 * the next login — the same rule the ERP applies to a shop's users, for the
 * same reason.
 *
 * The console renders navigation from `permissions`, but that is presentation
 * only. Nothing here is a security boundary: every route on the control plane
 * checks the operator's role itself, and a console that hid a button would
 * still be talking to a server that refuses the call.
 */
export interface OperatorSession {
  id: string;
  name: string;
  email: string;
  role: string;
  totpEnrolled: boolean;
  permissions: string[];
  reauthAt: string | null;
}

export const session = reactive<{
  operator: OperatorSession | null;
  loading: boolean;
  enrolmentUri: string;
}>({
  operator: null,
  loading: true,
  enrolmentUri: '',
});

export async function loadSession(): Promise<void> {
  session.loading = true;
  if (storedToken() === null) {
    session.operator = null;
    session.loading = false;
    return;
  }
  try {
    session.operator = await api<OperatorSession>('/operators/me');
  } catch {
    session.operator = null;
  } finally {
    session.loading = false;
  }
}

export async function signIn(email: string, password: string, code: string): Promise<void> {
  const result = await api<{
    token: string;
    operator: OperatorSession;
    enrolmentRequired: boolean;
    totpUri?: string;
  }>('/operators/login', { method: 'POST', body: { email, password, code } });
  storeToken(result.token);
  session.enrolmentUri = result.totpUri ?? '';
  await loadSession();
}

export async function completeEnrolment(code: string): Promise<void> {
  await api('/operators/enrol', { method: 'POST', body: { code } });
  session.enrolmentUri = '';
  await loadSession();
}

/** The fresh-code step in front of every action §24 calls sensitive. */
export async function reauthenticate(code: string): Promise<void> {
  await api('/operators/reauth', { method: 'POST', body: { code } });
  await loadSession();
}

export async function signOut(): Promise<void> {
  await api('/operators/logout', { method: 'POST', body: {} }).catch(() => undefined);
  clearToken();
  session.operator = null;
}

export function can(permission: string): boolean {
  return session.operator?.permissions.includes(permission) ?? false;
}
