import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import HelpTip from '../src/components/HelpTip.vue';

/**
 * UI-49's help tip. Tested once here, so no page repeats it (R-E11).
 *
 * The case that matters most is the first: these shops run on Android phones,
 * where hover does not exist. A tip that only opened on hover would be invisible
 * to every intended user while looking perfectly fine on the developer's laptop.
 */
const mountedWrappers: { unmount: () => void }[] = [];

function tip(props: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(HelpTip, {
    attachTo: host,
    props: {
      label: 'Reorder at',
      text: 'A warning line, not an order.',
      textBn: 'এটি শুধু সতর্ক করে',
      ...props,
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

function visibleTip(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="tooltip"]');
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

describe('a help tip', () => {
  it('opens on tap, because the audience has no mouse', async () => {
    const wrapper = tip();
    expect(visibleTip()).toBeNull();

    await wrapper.find('button').trigger('click');
    expect(wrapper.find('.help [role="tooltip"]').exists()).toBe(false);
    expect(visibleTip()?.textContent).toContain('A warning line');
  });

  it('closes on a second tap', async () => {
    const wrapper = tip();

    await wrapper.find('button').trigger('click');
    await wrapper.find('button').trigger('click');

    expect(visibleTip()).toBeNull();
  });

  it('opens on hover only for a real mouse', async () => {
    const wrapper = tip();

    // Touch browsers synthesise hover on tap; without the pointerType guard that
    // synthetic event would fight the tap toggle.
    await wrapper.find('.help').trigger('pointerenter', { pointerType: 'touch' });
    expect(visibleTip()).toBeNull();

    await wrapper.find('.help').trigger('pointerenter', { pointerType: 'mouse' });
    expect(visibleTip()).not.toBeNull();
  });

  it('opens on keyboard focus, so it is reachable without a pointer at all', async () => {
    const wrapper = tip();

    await wrapper.find('button').trigger('focus');
    expect(visibleTip()).not.toBeNull();
  });

  it('carries the Bangla explanation, which is the half most will read', async () => {
    const wrapper = tip();

    await wrapper.find('button').trigger('click');
    expect(visibleTip()?.querySelector('.help-bn')?.textContent).toBe('এটি শুধু সতর্ক করে');
  });

  it('is a named button, not a title attribute', async () => {
    // `title` never appears on touch, cannot be styled, and is announced
    // inconsistently — three reasons it is the wrong tool here.
    const button = tip().find('button');

    expect(button.attributes('aria-label')).toBe('More about Reorder at');
    expect(button.attributes('title')).toBeUndefined();
    expect(button.attributes('aria-expanded')).toBe('false');
  });
});
