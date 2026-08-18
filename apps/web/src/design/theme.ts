import { readonly, ref } from 'vue';

/**
 * Light or dark, chosen by the person using the machine.
 *
 * Deliberately **not** `prefers-color-scheme`. A shop PC left on the vendor's
 * default, or a phone that flips to dark at sunset, would otherwise change the
 * whole ERP under a cashier mid-sale. The choice is explicit, it is remembered
 * per device, and light is what an unconfigured machine gets.
 *
 * The class and the attribute are both set on purpose: `data-theme` drives
 * `tokens.css`, and `.sher-dark` is the selector the PrimeVue preset is
 * configured with (`main.ts`), so library components follow the same switch.
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sher.theme';

const current = ref<Theme>('light');

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.dataset['theme'] = theme;
  root.classList.toggle('sher-dark', theme === 'dark');
}

/** Called once from `main.ts`, before the app mounts, so there is no flash. */
export function initTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY);
  current.value = stored === 'dark' ? 'dark' : 'light';
  apply(current.value);
}

export function setTheme(theme: Theme): void {
  current.value = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  apply(theme);
}

export function useTheme(): {
  theme: Readonly<typeof current>;
  toggle: () => void;
} {
  return {
    theme: readonly(current) as Readonly<typeof current>,
    toggle: () => setTheme(current.value === 'dark' ? 'light' : 'dark'),
  };
}
