import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardPage from '../src/pages/DashboardPage.vue';

/**
 * UI-44: one component test per slice screen — renders, shows loading, shows
 * error. Business assertions stay in the domain and integration tests; nothing
 * here asserts a number.
 */
const summary = vi.fn();

vi.mock('../src/api/auth', () => ({
  fetchDashboardSummary: (token: string) => summary(token),
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
    summary.mockResolvedValue({ businessName: 'Karim Traders' });

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
    expect(wrapper.find('.retry').exists()).toBe(true);
  });
});
