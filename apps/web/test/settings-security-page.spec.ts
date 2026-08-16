import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import SettingsSecurityPage from '../src/pages/SettingsSecurityPage.vue';

/**
 * UI-44: one component test per slice screen — renders, shows loading, shows
 * error. Business assertions stay in the domain and integration suites; whether
 * a current credential is correct is decided by the server, never here.
 */
const password = vi.fn();
const pin = vi.fn();
const push = vi.fn();

vi.mock('../src/api/auth', () => ({
  changePassword: (token: string, refreshToken: string, current: string, next: string) =>
    password(token, refreshToken, current, next),
  changePin: (token: string, current: string, next: string) => pin(token, current, next),
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<div><slot /></div>' },
}));

beforeEach(() => {
  // Through the composable, not straight into localStorage: the session's refs
  // are read once at module load, so a later write to storage alone would leave
  // the page looking signed out.
  useSession().signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  password.mockReset();
  pin.mockReset();
  push.mockReset();
});

afterEach(() => {
  useSession().clear();
});

/** The password form is the first of the two on the page. */
function passwordForm(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('form')[0]!;
}

function pinForm(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('form')[1]!;
}

/** Fills a four-box PIN group, which is one field made of four inputs. */
async function typePin(group: ReturnType<typeof mount>, index: number, value: string) {
  const boxes = group.findAll('.otp')[index]!.findAll('input');
  for (const [position, box] of boxes.entries()) {
    await box.setValue(value[position] ?? '');
  }
}

describe('SettingsSecurityPage', () => {
  it('offers both credentials, and says which one signs other devices out', () => {
    const wrapper = mount(SettingsSecurityPage);

    expect(wrapper.text()).toContain('Password');
    expect(wrapper.text()).toContain('PIN');
    expect(wrapper.text()).toContain('signs out every other device');
  });

  it('keeps the password submit disabled until both fields are filled', async () => {
    const wrapper = mount(SettingsSecurityPage);

    expect(passwordForm(wrapper).find('button[type="submit"]').attributes('disabled')).toBeDefined();

    await wrapper.find('#current-password').setValue('Passw0rd23');
    await wrapper.find('#new-password').setValue('Newpass99');

    expect(
      passwordForm(wrapper).find('button[type="submit"]').attributes('disabled'),
    ).toBeUndefined();
  });

  it("sends this device's refresh token so the current session survives", async () => {
    password.mockResolvedValue(undefined);

    const wrapper = mount(SettingsSecurityPage);
    await wrapper.find('#current-password').setValue('Passw0rd23');
    await wrapper.find('#new-password').setValue('Newpass99');
    await passwordForm(wrapper).trigger('submit');
    await flushPromises();

    expect(password).toHaveBeenCalledWith(
      'test-access',
      'test-refresh',
      'Passw0rd23',
      'Newpass99',
    );
    expect(wrapper.text()).toContain('Password changed');
    // The fields are cleared, so a shoulder-surfer sees nothing after the fact.
    expect((wrapper.find('#current-password').element as HTMLInputElement).value).toBe('');
  });

  it('disables the password submit while the request is in flight (UI-35)', async () => {
    password.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(SettingsSecurityPage);
    await wrapper.find('#current-password').setValue('Passw0rd23');
    await wrapper.find('#new-password').setValue('Newpass99');
    await passwordForm(wrapper).trigger('submit');
    await flushPromises();

    const submit = passwordForm(wrapper).find('button[type="submit"]');
    expect(submit.attributes('disabled')).toBeDefined();
    expect(submit.text()).toContain('Saving…');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    password.mockRejectedValue(
      new ApiError('UNAUTHENTICATED', 'That current credential is not correct', 401),
    );

    const wrapper = mount(SettingsSecurityPage);
    await wrapper.find('#current-password').setValue('Wrongpass99');
    await wrapper.find('#new-password').setValue('Newpass99');
    await passwordForm(wrapper).trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('UNAUTHENTICATED');
    expect(wrapper.text()).toContain('That current credential is not correct');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('changes the PIN through its own form, leaving the password form alone', async () => {
    pin.mockResolvedValue(undefined);

    const wrapper = mount(SettingsSecurityPage);
    await typePin(wrapper, 0, '4821');
    await typePin(wrapper, 1, '7305');
    await pinForm(wrapper).trigger('submit');
    await flushPromises();

    expect(pin).toHaveBeenCalledWith('test-access', '4821', '7305');
    expect(password).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('PIN changed');
  });

  it('keeps the PIN submit disabled until both PINs are four digits', async () => {
    const wrapper = mount(SettingsSecurityPage);

    expect(pinForm(wrapper).find('button[type="submit"]').attributes('disabled')).toBeDefined();

    await typePin(wrapper, 0, '4821');
    await typePin(wrapper, 1, '730');

    expect(pinForm(wrapper).find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });
});
