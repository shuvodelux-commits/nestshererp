import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

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

/**
 * The bubble is teleported to `<body>` so it escapes the picker's
 * `overflow: hidden` — which had been slicing it off inside the field. That
 * puts it outside the wrapper, so it is found on the document instead.
 */
function bubble(): Element | null {
  return document.body.querySelector('[role="tooltip"]');
}

function tip(props: Record<string, unknown> = {}) {
  return mount(Tooltip, {
    props: { text: 'Add and manage', textBn: 'নতুন যোগ করুন', ...props },
    slots: { default: '<button aria-label="Add or manage Unit">icon</button>' },
    attachTo: document.body,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a control tooltip', () => {
  it('appears on hover from a real mouse', async () => {
    const wrapper = tip();
    expect(bubble()).toBeNull();

    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    expect(bubble()?.textContent).toContain('Add and manage');
  });

  it('ignores the hover a touch browser synthesises on tap', async () => {
    // Otherwise the label flashes over the panel that same tap just opened.
    const wrapper = tip();

    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'touch' });

    expect(bubble()).toBeNull();
  });

  it('appears on keyboard focus, and goes away again', async () => {
    const wrapper = tip();

    await wrapper.find('.tip-wrap').trigger('focusin');
    expect(bubble()).not.toBeNull();

    await wrapper.find('.tip-wrap').trigger('focusout');
    expect(bubble()).toBeNull();
  });

  it('carries the Bangla line', async () => {
    const wrapper = tip();

    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    expect(bubble()?.querySelector('.tip-bn')?.textContent).toBe('নতুন যোগ করুন');
  });

  it('escapes its container rather than being clipped by it', async () => {
    // The reason for the teleport: an absolutely positioned bubble is cut off by
    // any ancestor with `overflow: hidden`, and the picker has exactly that to
    // keep its rounded corners.
    const wrapper = tip();
    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    const el = bubble();
    expect(el).not.toBeNull();
    expect(el?.closest('.tip-wrap')).toBeNull();
    expect(el?.parentElement).toBe(document.body);
  });

  it('never swallows the tap meant for the control it describes', async () => {
    // `pointer-events: none` on the bubble; the button keeps its own label.
    const wrapper = tip();
    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    expect(wrapper.find('button').attributes('aria-label')).toBe('Add or manage Unit');
  });
});

/**
 * Reported from the running app: a tip on a control near an edge of the window
 * was drawn partly outside it, and one on a control near the top was drawn off
 * the screen entirely. The bubble is `position: fixed`, so nothing else clamps
 * it — the placement has to.
 */
describe('staying inside the window', () => {
  /** Puts the anchor wherever the test needs it, since jsdom lays nothing out. */
  function anchorAt(wrapper: ReturnType<typeof tip>, box: Partial<DOMRect>): void {
    const el = wrapper.find('.tip-wrap').element as HTMLElement;
    el.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 40,
        left: 0,
        right: 40,
        width: 40,
        height: 40,
        x: 0,
        y: 0,
        ...box,
      }) as DOMRect;
  }

  it('pulls a tip on a control at the right-hand edge back inside', async () => {
    const wrapper = tip();
    anchorAt(wrapper, { top: 300, bottom: 340, left: 1010, right: 1050, width: 40 });

    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    // Centred on the control would be 1030; the window is 1024 wide, so the
    // bubble's own half-width has to come off that or it hangs outside.
    const left = Number.parseFloat((bubble() as HTMLElement).style.left);
    expect(left).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(left).toBeLessThan(1030);
  });

  it('flips below a control that has no room above it', async () => {
    const wrapper = tip();
    anchorAt(wrapper, { top: 10, bottom: 50, left: 400, right: 440, width: 40 });

    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    const el = bubble() as HTMLElement;
    expect(el.classList.contains('is-below')).toBe(true);
    // Anchored to the bottom of the control, not its top.
    expect(el.style.top).toBe('50px');
  });

  it('stays above a control with room, which is where it belongs', async () => {
    const wrapper = tip();
    anchorAt(wrapper, { top: 400, bottom: 440, left: 400, right: 440, width: 40 });

    await wrapper.find('.tip-wrap').trigger('pointerenter', { pointerType: 'mouse' });

    const el = bubble() as HTMLElement;
    expect(el.classList.contains('is-below')).toBe(false);
    expect(el.style.top).toBe('400px');
  });
});
