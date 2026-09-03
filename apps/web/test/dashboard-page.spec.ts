/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:dashboard
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardPage from '../src/pages/DashboardPage.vue';

/**
 * UI-44: one component test per slice screen — renders, shows loading, shows
 * error. Business assertions stay in the domain and integration tests; nothing
 * here asserts a number.
 */
/*
 * Phase 9 filled the dashboard: it reads `/dashboard/cards`, which returns the
 * business name **and** the day's figures, instead of the name-only summary
 * slice 1.1 had. The screen changed, so the double it is mounted with changed
 * with it — the assertions below are the same three UI-44 asks for.
 */
const summary = vi.fn();

vi.mock('../src/api/reports', () => ({
  fetchDashboardCards: (token: string) => summary(token),
  saveTarget: vi.fn(),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<div><slot /></div>' },
}));

beforeEach(() => {
  localStorage.setItem('sher.accessToken', 'test-token');
  summary.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

describe('DashboardPage', () => {
  it('shows a loading skeleton before the summary arrives', () => {
    summary.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(DashboardPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('renders the business name once loaded', async () => {
    summary.mockResolvedValue({ businessName: 'Karim Traders', businessDate: '2026-08-30' });

    const wrapper = mount(DashboardPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Karim Traders');
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false);
  });

  it("shows the server's error code and a retry, never a generic message", async () => {
    const { ApiError } = await import('../src/api/client');
    summary.mockRejectedValue(new ApiError('NOT_FOUND', 'Business not found', 404));

    const wrapper = mount(DashboardPage);
    await flushPromises();

    expect(wrapper.text()).toContain('NOT_FOUND');
    expect(wrapper.text()).toContain('Business not found');
    expect(wrapper.text()).not.toContain('Something went wrong');
    expect(wrapper.text()).toContain('Try again');
  });
});
