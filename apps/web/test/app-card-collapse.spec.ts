import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AppCard from '../src/components/AppCard.vue';

/**
 * Folding optional sections away (§2.7's audience rule).
 *
 * Tested once here rather than on each form (R-E11). The case that matters is
 * the error one: a field inside a folded section can still fail validation, and
 * a refusal naming a field nobody can see is worse than no refusal at all.
 */
function card(props: Record<string, unknown> = {}) {
  return mount(AppCard, {
    props: { title: 'Codes', ...props },
    slots: { default: '<input id="product-sku" />' },
  });
}

/**
 * What `v-show` actually sets on the body wrapper.
 *
 * Asserted directly rather than through `isVisible()`, which also weighs whether
 * the node is attached to the document and so answers a different question than
 * the one being asked here — is this section folded.
 */
function bodyDisplay(wrapper: ReturnType<typeof card>): string {
  const body = wrapper.find('#product-sku').element.parentElement as HTMLElement;
  return body.style.display;
}

describe('an optional section', () => {
  it('is open when the card is not collapsible', () => {
    expect(bodyDisplay(card())).toBe('');
  });

  it('starts folded when collapsible, and opens on a tap', async () => {
    const wrapper = card({ collapsible: true });
    expect(bodyDisplay(wrapper)).toBe('none');

    await wrapper.find('.fold').trigger('click');
    expect(bodyDisplay(wrapper)).toBe('');
  });

  it('says what the control will do, rather than showing a bare arrow', () => {
    // An arrow alone assumes the reader already knows this pattern, which is
    // the assumption this app cannot make.
    expect(card({ collapsible: true }).find('.fold').text()).toContain('More');
  });

  it('keeps the field in the DOM while folded, so nothing typed is lost', () => {
    // `v-show`, not `v-if`: a folded section is still part of the form, and a
    // field that unmounted would silently drop whatever had been typed into it.
    expect(card({ collapsible: true }).find('#product-sku').exists()).toBe(true);
  });

  it('opens itself when the save failed, so the refusal names a visible field', () => {
    const wrapper = card({ collapsible: true, forceOpen: true });

    expect(bodyDisplay(wrapper)).toBe('');
    expect(wrapper.find('.fold').text()).toContain('Hide');
  });

  it('tells a screen reader whether the section is open', () => {
    expect(card({ collapsible: true }).find('.fold').attributes('aria-expanded')).toBe('false');
    expect(
      card({ collapsible: true, defaultOpen: true }).find('.fold').attributes('aria-expanded'),
    ).toBe('true');
  });
});
