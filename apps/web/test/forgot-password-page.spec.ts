/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:forgot-password
 */
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiClient from '../src/api/client';
import { ApiError } from '../src/api/client';
import ForgotPasswordPage from '../src/pages/ForgotPasswordPage.vue';

/**
 * UI-44: one component test per slice screen — renders, shows loading, shows
 * error. Business assertions stay in the domain and integration suites.
 */
const sendOtp = vi.fn();
const reset = vi.fn();
const push = vi.fn();

vi.mock('../src/api/auth', () => ({
  requestPasswordResetOtp: (identifier: string) => sendOtp(identifier),
  resetPassword: (identifier: string, otpCode: string, password: string) =>
    reset(identifier, otpCode, password),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: '<a><slot /></a>' },
}));

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('../src/api/client');
  return { ...actual, loadConfig: () => Promise.resolve({ apiBaseUrl: '' }) };
});

beforeEach(() => {
  localStorage.clear();
  sendOtp.mockReset();
  reset.mockReset();
  push.mockReset();
});

/** Walks the card to the reset step, which most of these tests start from. */
async function reachResetStep(devCode = '123456') {
  sendOtp.mockResolvedValue({ channel: 'PHONE', devCode });
  const wrapper = mount(ForgotPasswordPage);
  await wrapper.find('#identifier').setValue('01712345678');
  await wrapper.find('form').trigger('submit');
  await flushPromises();
  return wrapper;
}

/** Fills the six OTP boxes, which are one field made of six inputs. */
async function typeCode(wrapper: ReturnType<typeof mount>, code: string): Promise<void> {
  const boxes = wrapper.findAll('.otp input');
  for (const [index, box] of boxes.entries()) {
    await box.setValue(code[index] ?? '');
  }
}

describe('ForgotPasswordPage', () => {
  it('opens on the identifier step', () => {
    const wrapper = mount(ForgotPasswordPage);

    expect(wrapper.text()).toContain('Set or reset your password');
    expect(wrapper.find('button[type="submit"]').text()).toContain('Send code');
  });

  it('disables the submit button while the request is in flight (UI-35)', async () => {
    sendOtp.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(ForgotPasswordPage);
    await wrapper.find('#identifier').setValue('01712345678');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const submit = wrapper.find('button[type="submit"]');
    expect(submit.attributes('disabled')).toBeDefined();
    expect(submit.text()).toContain('Sending code…');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    sendOtp.mockRejectedValue(
      new ApiError('VALIDATION_FAILED', 'Enter a valid mobile number or email address', 400),
    );

    const wrapper = mount(ForgotPasswordPage);
    await wrapper.find('#identifier').setValue('nonsense');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toContain('VALIDATION_FAILED');
    expect(wrapper.text()).toContain('Enter a valid mobile number or email address');
  });

  it('moves to the code step and shows the development code', async () => {
    const wrapper = await reachResetStep('482913');

    expect(wrapper.text()).toContain('Enter the code and a new password');
    expect(wrapper.text()).toContain('482913');
    expect(wrapper.find('#password').exists()).toBe(true);
  });

  it('keeps the submit disabled until both the code and a password are entered', async () => {
    const wrapper = await reachResetStep();

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();

    await typeCode(wrapper, '123456');
    await wrapper.find('#password').setValue('Newpass99');

    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  it('sends identifier, code and password, then confirms without signing in', async () => {
    reset.mockResolvedValue(undefined);
    localStorage.setItem('sher.refreshToken', 'stale-token');

    const wrapper = await reachResetStep();
    await typeCode(wrapper, '123456');
    await wrapper.find('#password').setValue('Newpass99');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(reset).toHaveBeenCalledWith('01712345678', '123456', 'Newpass99');
    expect(wrapper.text()).toContain('Password changed');
    // Every session was revoked server-side; the dead token is dropped here too.
    expect(localStorage.getItem('sher.refreshToken')).toBeNull();
    // No automatic sign-in: the person logs in with the password they just chose.
    expect(push).not.toHaveBeenCalled();
  });

  it('sends a dead code back to the identifier step', async () => {
    reset.mockRejectedValue(new ApiError('OTP_EXPIRED', 'Request a new verification code', 400));

    const wrapper = await reachResetStep();
    await typeCode(wrapper, '123456');
    await wrapper.find('#password').setValue('Newpass99');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Set or reset your password');
    expect(wrapper.text()).toContain('OTP_EXPIRED');
  });
});
