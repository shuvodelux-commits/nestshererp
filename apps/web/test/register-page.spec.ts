import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RegisterPage from '../src/pages/RegisterPage.vue';

const sendOtp = vi.fn();
const register = vi.fn();
const push = vi.fn();

vi.mock('../src/api/auth', () => ({
  requestSignupOtp: (identifier: string) => sendOtp(identifier),
  completeRegistration: (payload: unknown) => register(payload),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}));

beforeEach(() => {
  localStorage.clear();
  sendOtp.mockReset();
  register.mockReset();
  push.mockReset();
});

describe('RegisterPage', () => {
  it('renders the identifier step first', () => {
    const wrapper = mount(RegisterPage);

    expect(wrapper.text()).toContain('Mobile number or email');
    expect(wrapper.find('button[type="submit"]').text()).toContain('Send verification code');
  });

  it('disables the submit button while the request is in flight (UI-35)', async () => {
    sendOtp.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(RegisterPage);
    await wrapper.find('input').setValue('01712345678');
    await wrapper.find('form').trigger('submit');

    const button = wrapper.find('button[type="submit"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Sending code');
  });

  it("shows the server's error code rather than a generic message (UI-28)", async () => {
    const { ApiError } = await import('../src/api/client');
    sendOtp.mockRejectedValue(new ApiError('VALIDATION_FAILED', 'Enter a valid mobile number', 400));

    const wrapper = mount(RegisterPage);
    await wrapper.find('input').setValue('nonsense');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('VALIDATION_FAILED');
    expect(alert.text()).toContain('Enter a valid mobile number');
  });

  it('advances to the code step and surfaces the development code', async () => {
    sendOtp.mockResolvedValue({ channel: 'PHONE', devCode: '123456' });

    const wrapper = mount(RegisterPage);
    await wrapper.find('input').setValue('01712345678');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Verification code');
    expect(wrapper.text()).toContain('123456');
  });
});
