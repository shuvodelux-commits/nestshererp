/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:register
 */
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../src/api/client';
import RegisterPage from '../src/pages/RegisterPage.vue';

/**
 * UI-44: one component test per slice screen — renders, shows loading, shows
 * error. Business assertions stay in the domain and integration suites.
 */
const sendOtp = vi.fn();
const verifyOtp = vi.fn();
const register = vi.fn();
const push = vi.fn();

vi.mock('../src/api/auth', () => ({
  requestSignupOtp: (identifier: string) => sendOtp(identifier),
  verifySignupOtp: (identifier: string, code: string) => verifyOtp(identifier, code),
  completeRegistration: (payload: unknown) => register(payload),
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../src/api/client');
  return { ...actual, loadConfig: () => Promise.resolve({ apiBaseUrl: '' }) };
});

beforeEach(() => {
  localStorage.clear();
  sendOtp.mockReset();
  verifyOtp.mockReset();
  register.mockReset();
  push.mockReset();
});

/** Walks the card to the code step, which most of these tests start from. */
async function reachCodeStep(devCode = '123456') {
  sendOtp.mockResolvedValue({ channel: 'PHONE', devCode });
  const wrapper = mount(RegisterPage);
  await wrapper.find('#identifier').setValue('01712345678');
  await wrapper.find('form').trigger('submit');
  await flushPromises();
  return wrapper;
}

describe('RegisterPage', () => {
  it('opens on the identifier step, with a Google option below it', () => {
    const wrapper = mount(RegisterPage);

    expect(wrapper.text()).toContain('Mobile number or email');
    expect(wrapper.find('button[type="submit"]').text()).toContain('Send code');
    expect(wrapper.text()).toContain('Continue with Google');
  });

  it('disables the submit button while the request is in flight (UI-35)', async () => {
    sendOtp.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(RegisterPage);
    await wrapper.find('#identifier').setValue('01712345678');
    await wrapper.find('form').trigger('submit');

    const button = wrapper.find('button[type="submit"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('Sending code');
  });

  it("shows the server's error code rather than a generic message (UI-28)", async () => {
    const { ApiError } = await import('../src/api/client');
    sendOtp.mockRejectedValue(new ApiError('VALIDATION_FAILED', 'Enter a valid mobile number', 400));

    const wrapper = mount(RegisterPage);
    await wrapper.find('#identifier').setValue('nonsense');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('VALIDATION_FAILED');
    expect(alert.text()).toContain('Enter a valid mobile number');
  });

  it('advances to six code boxes and surfaces the development code', async () => {
    const wrapper = await reachCodeStep();

    expect(wrapper.text()).toContain('Enter the 6-digit code');
    expect(wrapper.findAll('.otp input')).toHaveLength(6);
    expect(wrapper.text()).toContain('123456');
  });

  it('verifies the code before asking for business details', async () => {
    const wrapper = await reachCodeStep();
    verifyOtp.mockResolvedValue({ verified: true });

    const boxes = wrapper.findAll('.otp input');
    for (const [index, box] of boxes.entries()) {
      await box.setValue(String(index + 1));
    }
    await flushPromises();

    expect(verifyOtp).toHaveBeenCalledWith('01712345678', '123456');
    expect(wrapper.text()).toContain('Business name');
  });

  it('sends a dead code back to the first step rather than stranding the user', async () => {
    const { ApiError } = await import('../src/api/client');
    const wrapper = await reachCodeStep();
    verifyOtp.mockRejectedValue(new ApiError('OTP_EXPIRED', 'Request a new verification code', 400));

    const boxes = wrapper.findAll('.otp input');
    for (const [index, box] of boxes.entries()) {
      await box.setValue(String(index + 1));
    }
    await flushPromises();

    expect(wrapper.text()).toContain('Mobile number or email');
    expect(wrapper.find('[role="alert"]').text()).toContain('OTP_EXPIRED');
  });
});
