/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:audit
 */
import { flushPromises, mount } from '@vue/test-utils';
import Select from 'primevue/select';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import AuditPage from '../src/pages/AuditPage.vue';
import DateOnlyPicker from '../src/components/DateOnlyPicker.vue';

/**
 * Slice 1.6 — the audit workflow smoke test (R-E11).
 *
 * The assertions worth making are the ones that would let the trail lie: that
 * an instant is rendered on the day the *tenant's* timezone puts it on (§3.5),
 * that before/after values are shown rather than summarised away, and that the
 * screen offers no way to change anything.
 */
const load = vi.fn();

vi.mock('../src/api/audit', () => ({
  fetchAuditEvents: (token: string, query: unknown) => load(token, query),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const SETTING_CHANGE = {
  id: '01AUDITAAAAAAAAAAAAAAAAAAA',
  // 18:30 UTC on the 17th is already 00:30 on the 18th in Dhaka (§3.5).
  occurredAt: '2026-08-17T18:30:00.000Z',
  actorName: 'Karim',
  actorId: '01USERAAAAAAAAAAAAAAAAAAAA',
  entityType: 'setting',
  entityId: 'serial_tracking_enabled',
  action: 'UPDATE',
  before: { value: 'off' },
  after: { value: 'on' },
  reason: null,
  source: 'API',
};

const DENIAL = {
  id: '01AUDITBBBBBBBBBBBBBBBBBBB',
  occurredAt: '2026-08-17T19:00:00.000Z',
  actorName: 'Rina Akter',
  actorId: '01USERBBBBBBBBBBBBBBBBBBBB',
  entityType: 'permission_denial',
  entityId: 'settings.module.toggle',
  action: 'DENIED',
  before: null,
  after: { resource: 'POST /api/v1/settings/value', traceId: '01TRACEAAAAAAAAAAAAAAAAAAA' },
  reason: null,
  source: 'API',
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    events: [SETTING_CHANGE, DENIAL],
    timezone: 'Asia/Dhaka',
    page: { nextCursor: null, hasMore: false },
    actions: ['UPDATE', 'DENIED'],
    entityTypes: ['setting', 'permission_denial'],
    actors: [
      { id: SETTING_CHANGE.actorId, name: 'Karim' },
      { id: DENIAL.actorId, name: 'Rina Akter' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions(['audit.event.view']);
  load.mockReset();
  load.mockResolvedValue(body());
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(AuditPage);
  await flushPromises();
  return wrapper;
}

describe('AuditPage', () => {
  it('shows a loading state until the trail arrives (UI-27)', () => {
    load.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(AuditPage);

    expect(wrapper.find('[role="status"]').exists()).toBe(true);
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('shows what changed, from what, to what, and who did it', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('serial_tracking_enabled');
    expect(wrapper.text()).toContain('value: off');
    expect(wrapper.text()).toContain('value: on');
    expect(wrapper.text()).toContain('Karim');
  });

  it("renders an instant on the day the tenant's timezone puts it (§3.5)", async () => {
    const wrapper = await mountLoaded();

    // 18:30 UTC on 17 Aug is 00:30 on 18 Aug in Dhaka. Showing "17 Aug" here
    // would put a day's activity in the wrong day, and look plausible.
    expect(wrapper.text()).toContain('18 Aug 2026');
    expect(wrapper.text()).not.toContain('17 Aug 2026');
  });

  it('shows a refused mutation as its own kind of event (§5.22)', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('DENIED');
    expect(wrapper.text()).toContain('settings.module.toggle');
    expect(wrapper.text()).toContain('POST /api/v1/settings/value');
  });

  it('offers no way to change or remove a recorded event', async () => {
    const wrapper = await mountLoaded();

    const labels = wrapper.findAll('button').map((button) => button.text().toLowerCase());
    expect(labels.some((label) => label.includes('delete'))).toBe(false);
    expect(labels.some((label) => label.includes('edit'))).toBe(false);
    expect(labels.some((label) => label.includes('clear the trail'))).toBe(false);
  });

  it('sends the filters the owner chose', async () => {
    const wrapper = await mountLoaded();

    wrapper.findAllComponents(DateOnlyPicker).find((item) => item.props('inputId') === 'filter-from')?.vm.$emit('update:modelValue', '2026-08-01');
    wrapper.findAllComponents(Select).find((item) => item.props('inputId') === 'filter-entity')?.vm.$emit('update:modelValue', 'setting');
    await flushPromises();
    await wrapper.get('.filters').trigger('submit');
    await flushPromises();

    expect(load).toHaveBeenLastCalledWith(
      'test-access',
      expect.objectContaining({ from: '2026-08-01', entityType: 'setting' }),
    );
  });

  it('says so plainly when a filter matches nothing (UI-29)', async () => {
    load.mockResolvedValue(body({ events: [] }));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Nothing recorded for this filter');
  });

  it('appends the next page instead of replacing what is shown (§3.9)', async () => {
    load.mockResolvedValueOnce(
      body({ events: [SETTING_CHANGE], page: { nextCursor: SETTING_CHANGE.id, hasMore: true } }),
    );

    const wrapper = await mountLoaded();
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);

    load.mockResolvedValueOnce(body({ events: [DENIAL] }));
    await wrapper.get('.more button').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('tbody tr')).toHaveLength(2);
    expect(load).toHaveBeenLastCalledWith(
      'test-access',
      expect.objectContaining({ cursor: SETTING_CHANGE.id }),
    );
  });
});
