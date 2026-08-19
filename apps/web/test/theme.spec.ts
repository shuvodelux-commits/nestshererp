import { beforeEach, describe, expect, it } from 'vitest';

import { SherPreset } from '../src/design/preset';
import { initTheme, setTheme, useTheme } from '../src/design/theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('sher-dark');
  delete document.documentElement.dataset['theme'];
  setTheme('light');
  localStorage.clear();
});

describe('the per-device SherERP theme', () => {
  it('defaults to light when this device has no saved choice', () => {
    initTheme();

    expect(useTheme().theme.value).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(document.documentElement.classList.contains('sher-dark')).toBe(false);
  });

  it('persists dark and applies the selector used by PrimeVue', () => {
    setTheme('dark');

    expect(localStorage.getItem('sher.theme')).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.classList.contains('sher-dark')).toBe(true);
  });

  it('restores the saved choice on the next initialization', () => {
    localStorage.setItem('sher.theme', 'dark');

    initTheme();

    expect(useTheme().theme.value).toBe('dark');
    expect(document.documentElement.classList.contains('sher-dark')).toBe(true);
  });

  it('keeps PrimeVue dark overlays dark and their text light', () => {
    expect(SherPreset).toMatchObject({
      semantic: {
        colorScheme: {
          dark: {
            surface: {
              0: '#f8fafc',
              900: '#0f1623',
              950: '#080c14',
            },
          },
        },
      },
    });
  });
});
