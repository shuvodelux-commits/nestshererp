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
 */
export const SherPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#f2f7fb',
      100: '#deeaf5',
      200: '#bed6ea',
      300: '#8fb8d9',
      400: '#5993c3',
      500: '#1b5e9e',
      600: '#175488',
      700: '#144a7d',
      800: '#113d66',
      900: '#0e3252',
      950: '#081f33',
    },
    colorScheme: {
      light: {
        surface: {
          0: '#ffffff',
          50: '#f8f9fa',
          100: '#f1f3f5',
          200: '#e7eaee',
          300: '#cfd4da',
          400: '#adb5bd',
          500: '#868e96',
          600: '#616b75',
          700: '#495057',
          800: '#343a40',
          900: '#1f2429',
          950: '#121619',
        },
      },
    },
  },
});
