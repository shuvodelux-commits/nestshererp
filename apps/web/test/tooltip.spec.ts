import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import Tooltip from '../src/components/Tooltip.vue';

/**
 * The label on an icon-only control (UI-49).
 *
 * Distinct from `HelpTip`, and the difference is the whole point: `HelpTip`
 * explains a field and opens on **tap**, because its content is what you came
 * for. This labels a control whose tap does something else — tapping the grid
 * button must open the panel, not explain itself — so it shows on hover and
 * focus only, and the label lives in the control's `aria-label` for everyone
 * who never hovers.
 */
function tip(props: Record<string, unknown> = {}) {
  return mount(Tooltip, {
    props: { text: 'Add and manage', textBn: 'নতুন যোগ করুন', ...props },
    slots: { default: '<button aria-label="Add or manage Unit">icon</button>' },
  });
}

describe('a control tooltip', () => {
  it('appears on hover from a real mouse', async () => {
    const wrapper = tip();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);

    await wrapper.trigger('pointerenter', { pointerType: 'mouse' });

    expect(wrapper.find('[role="tooltip"]').text()).toContain('Add and manage');
  });

  it('ignores the hover a touch browser synthesises on tap', async () => {
    // Otherwise the label flashes over the panel that same tap just opened.
    const wrapper = tip();

    await wrapper.trigger('pointerenter', { pointerType: 'touch' });

    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });

  it('appears on keyboard focus, and goes away again', async () => {
    const wrapper = tip();

    await wrapper.trigger('focusin');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);

    await wrapper.trigger('focusout');
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });

  it('carries the Bangla line', async () => {
    const wrapper = tip();

    await wrapper.trigger('pointerenter', { pointerType: 'mouse' });

    expect(wrapper.find('.tip-bn').text()).toBe('নতুন যোগ করুন');
  });

  it('never swallows the tap — the control underneath still gets it', async () => {
    // `pointer-events: none` on the bubble. A label that intercepted the click
    // would make the button it describes unusable at exactly the wrong moment.
    const wrapper = tip();
    await wrapper.trigger('pointerenter', { pointerType: 'mouse' });

    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.find('button').attributes('aria-label')).toBe('Add or manage Unit');
  });
});
