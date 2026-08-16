import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * PrimeVue 4 in styled mode (D-37, UI-03), with the primary ramp bent to
 * SherERP's blue so components match the tokens in `tokens.css` instead of
 * shipping Aura's default teal.
 *
 * Only the palette is overridden. Component structure, spacing and behaviour
 * stay stock, which is the point of choosing a component library at all — this
 * project cannot afford to review a hand-written DataTable (D-37).
 */
export const SherPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#eff6ff',
      100: '#dbeafe',
      200: '#bfdbfe',
      300: '#93c5fd',
      400: '#60a5fa',
      500: '#2563eb',
      600: '#1d4ed8',
      700: '#1e40af',
      800: '#1e3a8a',
      900: '#172554',
      950: '#0f172a',
    },
    colorScheme: {
      light: {
        surface: {
          0: '#ffffff',
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
      },
    },
  },
});
