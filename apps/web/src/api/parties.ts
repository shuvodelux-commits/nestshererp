import type {
  CorrectOpeningBalanceRequest,
  OpeningBalanceRequest,
  PartyLedgerQuery,
  PartyLedgerResponse,
  PartyListResponse,
  PartyOpeningResponse,
  PartyQuery,
  PartyResponse,
  PartyRoleValue,
  PartySetupResponse,
  RemoveCatalogEntryResponse,
  SavePartyRequest,
  UpdatePartyRequest,
} from '@sher/core-contracts';

import { localParties } from '@sher/adapter-sqlite-wasm';

import { request } from './client';
import { offlineWrite, queueCommand } from '../offline/local-writer';
import { queuedParty } from '../offline/queued-documents';
import { offlineFallback } from './offline-fallback';

/**
 * Parties — customers, suppliers and vendors (§5.6, D-04).
 *
 * `role` is always sent: §5.6 is explicit that no screen shows every party type
 * by default, so there is no call here that asks for "all parties".
 */
export const EMPTY_PARTY_SETUP: PartySetupResponse = {
  groups: [],
  features: { customerGroups: false, vendors: false },
  fields: { address: true, guardianName: false, nid: false, email: false, notes: false },
};

export function fetchPartySetup(token: string): Promise<PartySetupResponse> {
  return request('/api/v1/party-setup', { token });
}

export function fetchParties(token: string, query: PartyQuery): Promise<PartyListResponse> {
  const params = new URLSearchParams({ role: query.role });
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.groupId !== undefined) params.set('groupId', query.groupId);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  // UI-46: which header the shopkeeper tapped, and which way.
  if (query.sort !== undefined) params.set('sort', query.sort);
  if (query.direction !== undefined) params.set('direction', query.direction);

  return offlineFallback(
    () =>
      request<PartyListResponse>(`/api/v1/parties?${params.toString()}`, {
        token,
        envelope: true,
      }),
    () => localParties(query),
  );
}

/**
 * A party's statement (§2.4, INV-06).
 *
 * `envelope: true` — take the payload whole rather than unwrapping `data`. The
 * ledger response *is* the payload: it carries its own `rows`, `page` and
 * balances, exactly as the parties list does.
 */
export function fetchPartyLedger(
  token: string,
  id: string,
  query: PartyLedgerQuery = {},
): Promise<PartyLedgerResponse> {
  const params = new URLSearchParams();
  if (query.fromDate !== undefined) params.set('fromDate', query.fromDate);
  if (query.toDate !== undefined) params.set('toDate', query.toDate);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const search = params.toString();
  return request(`/api/v1/parties/${id}/ledger${search === '' ? '' : `?${search}`}`, {
    token,
    envelope: true,
  });
}

export function fetchParty(token: string, id: string): Promise<PartyResponse> {
  return request(`/api/v1/parties/${id}`, { token });
}

/* ------------------------------------------------------- opening balances */

/** The opening posted for a role, or `null` when the party has none (§5.6). */
export function fetchPartyOpening(
  token: string,
  id: string,
  role: PartyRoleValue,
): Promise<PartyOpeningResponse | null> {
  return request(`/api/v1/parties/${id}/opening?role=${role}`, { token });
}

/**
 * Sets an opening balance on a party created without one.
 *
 * Idempotent like a party create, and for a stronger reason: this posts a
 * journal entry, so a retry that slipped through would open the balance twice.
 */
export function setPartyOpening(
  token: string,
  id: string,
  payload: OpeningBalanceRequest,
  idempotencyKey: string,
): Promise<PartyOpeningResponse> {
  return request(`/api/v1/parties/${id}/opening`, {
    method: 'POST',
    token,
    body: payload,
    idempotencyKey,
  });
}

/** Corrects a posted opening: reversal and repost, never an edit (§2.5). */
export function correctPartyOpening(
  token: string,
  id: string,
  payload: CorrectOpeningBalanceRequest,
  idempotencyKey: string,
): Promise<PartyOpeningResponse> {
  return request(`/api/v1/parties/${id}/opening`, {
    method: 'PATCH',
    token,
    body: payload,
    idempotencyKey,
  });
}

/**
 * `idempotencyKey` is generated once per user intent and reused on retry
 * (UI-34) — it is the same value the server stores as `operation_id`.
 */
export function createParty(
  token: string,
  payload: SavePartyRequest,
  idempotencyKey: string,
): Promise<PartyResponse> {
  return offlineWrite(
    () =>
      request<PartyResponse>('/api/v1/parties', {
        method: 'POST',
        token,
        body: payload,
        idempotencyKey,
      }),
    async () => {
      /*
       * A new face buying on credit needs a party to owe the money, and the
       * counter cannot wait for the line to create one. Two cashiers adding the
       * same phone number is the one clash this produces, and §5.23 already
       * quarantines it rather than merging two people into one.
       */
      await queueCommand({ type: 'PARTY_CREATE', payload, operationId: idempotencyKey });
      return queuedParty<PartyResponse>(payload, idempotencyKey);
    },
  );
}

export function updateParty(
  token: string,
  id: string,
  payload: UpdatePartyRequest,
): Promise<PartyResponse> {
  return request(`/api/v1/parties/${id}`, { method: 'PATCH', token, body: payload });
}

export function setPartyStatus(
  token: string,
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<PartyResponse> {
  return request(`/api/v1/parties/${id}/status`, { method: 'POST', token, body: { status } });
}

export function deleteParty(token: string, id: string): Promise<void> {
  return request(`/api/v1/parties/${id}`, { method: 'DELETE', token });
}

export function createCustomerGroup(token: string, name: string): Promise<PartySetupResponse> {
  return request('/api/v1/party-setup/groups', { method: 'POST', token, body: { name } });
}

export function renameCustomerGroup(
  token: string,
  id: string,
  name: string,
): Promise<PartySetupResponse> {
  return request(`/api/v1/party-setup/groups/${id}`, { method: 'PATCH', token, body: { name } });
}

export function removeCustomerGroup(
  token: string,
  id: string,
): Promise<RemoveCatalogEntryResponse> {
  return request(`/api/v1/party-setup/groups/${id}`, { method: 'DELETE', token });
}
