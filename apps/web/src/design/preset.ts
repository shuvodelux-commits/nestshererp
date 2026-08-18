import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * PrimeVue 4 in styled mode (D-37, UI-03), bent to the same palette as
 * `tokens.css`.
 *
 * This file exists so the components that arrive in later slices — DataTable,
 * Dialog, Select, DatePicker — land already matching the shell rather than
 * shipping Aura's default teal. Keeping the two in step by hand is the cost of
 * having a component library at all, and it is far cheaper than the alternative
 * D-37 rejected: hand-writing every table and form.
 *
 * Both colour schemes are declared because §2.7.I includes dark mode; the
 * switch itself is `design/theme.ts` toggling `.sher-dark`.
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
          50: '#f7f9fc',
          100: '#f4f6fa',
          200: '#eef1f6',
          300: '#e5e9f0',
          400: '#cbd5e1',
          500: '#94a3b8',
          600: '#64748b',
          700: '#475569',
          800: '#334155',
          900: '#0f172a',
          950: '#020617',
        },
      },
      dark: {
        surface: {
          0: '#0f1623',
          50: '#141c2b',
          100: '#0f1623',
          200: '#0b111c',
          300: '#1e293b',
          400: '#2b3a50',
          500: '#64748b',
          600: '#94a3b8',
          700: '#cbd5e1',
          800: '#e2e8f0',
          900: '#e8edf6',
          950: '#f8fafc',
        },
      },
    },
  },
});
