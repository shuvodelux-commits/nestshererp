import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { fetchPartiesV2, fetchParty, fetchPartyOpening } from '../src/api/parties';
import { useSession } from '../src/auth/session';

const mocks = vi.hoisted(() => ({ request: vi.fn(), local: vi.fn(), snapshot: vi.fn(), users: vi.fn() }));
vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), request: mocks.request }));
vi.mock('@sher/adapter-sqlite-wasm', () => ({ localParties: mocks.local, readStoredSnapshot: mocks.snapshot, localUsers: mocks.users }));
vi.mock('../src/offline/snapshot', () => ({ storedTenantId: () => localStorage.getItem('sher.tenantId') }));

const id = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const row = {
  id, name: 'Directory name', phone: '01712345678', roles: ['CUSTOMER'],
  readRole: 'CUSTOMER', status: 'ACTIVE', version: 1, isSystemReserved: false,
  customerGroupId: null, customerGroupName: null, creditLimitMinor: 500,
  balance: { netMinor: 100, outstandingMinor: 100, advanceMinor: 0, direction: 'RECEIVABLE' },
  profile: { state: 'WITHHELD' }, globalHistory: { state: 'WITHHELD' },
};
const page = { data: [row], page: { hasMore: false, nextCursor: null }, summary: {
  total: 1, active: 1, inactive: 0, ungrouped: 1, totalOutstandingMinor: 100, totalAdvanceMinor: 0, overCreditLimit: 0,
} };
const offlineUser = { id, username: 'cashier', displayName: 'Cashier', permissions: ['party.customer.view'], features: [] };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useSession().clear();
  mocks.request.mockResolvedValue(page);
});

describe('Party V2 client boundary', () => {
  it('sends and verifies the selected role on list and detail', async () => {
    expect(await fetchPartiesV2('token', { role: 'CUSTOMER' })).toEqual(page);
    expect(mocks.request).toHaveBeenCalledWith('/api/v2/parties?role=CUSTOMER', { token: 'token', envelope: true });
    mocks.request.mockResolvedValue(row);
    expect(await fetchParty('token', id, 'CUSTOMER')).toEqual(row);
    expect(mocks.request).toHaveBeenLastCalledWith(`/api/v2/parties/${id}?role=CUSTOMER`, { token: 'token' });
    await expect(fetchParty('token', id, 'SUPPLIER')).rejects.toThrow();
    mocks.request.mockResolvedValue(page);
    await expect(fetchPartiesV2('token', { role: 'SUPPLIER' })).rejects.toThrow();
  });

  it('rejects raw V1 echoes, hidden private payloads, and customer credit in another role', async () => {
    for (const bad of [
      { ...row, address: 'secret' },
      { ...row, profile: { state: 'WITHHELD', data: { address: 'secret' } } },
      { ...row, readRole: 'SUPPLIER', roles: ['SUPPLIER'] },
    ]) {
      mocks.request.mockResolvedValue(bad);
      await expect(fetchParty('token', id, bad.readRole as 'CUSTOMER' | 'SUPPLIER')).rejects.toThrow();
    }
  });

  it('retains visible profile and role-specific opening reads', async () => {
    const visible = { ...row, profile: { state: 'VISIBLE', data: { address: 'Visible address', guardianName: null, nid: null, email: null, notes: null } } };
    mocks.request.mockResolvedValue(visible);
    expect((await fetchParty('token', id, 'CUSTOMER')).profile).toEqual(visible.profile);
    mocks.request.mockResolvedValue(null);
    await fetchPartyOpening('token', id, 'SUPPLIER');
    expect(mocks.request).toHaveBeenLastCalledWith(`/api/v1/parties/${id}/opening?role=SUPPLIER`, { token: 'token' });
  });

  it.each([401, 403])('never falls back after HTTP %i', async (status) => {
    mocks.request.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'No', status));
    await expect(fetchPartiesV2('token', { role: 'CUSTOMER' })).rejects.toMatchObject({ status });
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it('projects only a tenant-verified snapshot for a known offline user with current VIEW', async () => {
    useSession().signInOffline(offlineUser);
    localStorage.setItem('sher.tenantId', 'tenant-A');
    mocks.snapshot.mockResolvedValue({ tenantId: 'tenant-A', schemaVersion: 1, takenAt: '2026-11-14', includes: { customers: true } });
    mocks.users.mockResolvedValue([offlineUser]);
    mocks.local.mockResolvedValue({ ...page, data: [{ ...row, address: 'secret', nid: 'secret', notes: 'secret', hasLedgerEntries: false }] });
    mocks.request.mockRejectedValue(new ApiError('NETWORK_UNREACHABLE', 'Offline', 0));
    const result = await fetchPartiesV2('', { role: 'CUSTOMER' });
    expect(result.data[0]?.profile).toEqual({ state: 'WITHHELD' });
    expect(result.data[0]?.globalHistory).toEqual({ state: 'WITHHELD' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mocks.snapshot).toHaveBeenCalledWith('tenant-A', 1);

    useSession().setPermissions([]);
    mocks.local.mockClear();
    await expect(fetchPartiesV2('', { role: 'CUSTOMER' })).rejects.toThrow();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(['mismatch', 'absent', 'unknown', 'revoked'])('refuses unsafe offline identity: %s', async (failure) => {
    useSession().signInOffline(offlineUser);
    localStorage.setItem('sher.tenantId', 'tenant-A');
    mocks.snapshot.mockResolvedValue(failure === 'absent' ? null : { tenantId: failure === 'mismatch' ? 'tenant-B' : 'tenant-A', schemaVersion: 1, includes: { customers: true } });
    mocks.users.mockResolvedValue(failure === 'unknown' ? [] : [{ ...offlineUser, permissions: failure === 'revoked' ? [] : offlineUser.permissions }]);
    mocks.request.mockRejectedValue(new ApiError('NETWORK_UNREACHABLE', 'Offline', 0));
    await expect(fetchPartiesV2('', { role: 'CUSTOMER' })).rejects.toThrow();
    expect(mocks.local).not.toHaveBeenCalled();
  });
});
