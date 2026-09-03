/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:import
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import ImportPage from '../src/pages/ImportPage.vue';

/**
 * The guided import workflow (§5.6), one smoke test over the whole of it:
 * preview, refuse, import, and the permission case.
 *
 * What is deliberately **not** tested here is whether a row is valid — that is
 * the server's decision, asserted in `apps/api/test/imports.spec.ts` against
 * real numbers. This page's job is to show what came back and to send the same
 * file it previewed (B8).
 */
const preview = vi.fn();
const commit = vi.fn();
const push = vi.fn();

vi.mock('../src/api/imports', () => ({
  previewImport: (token: string, type: string, csv: string) => preview(token, type, csv),
  commitImport: (token: string, type: string, csv: string, key: string) =>
    commit(token, type, csv, key),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useRoute: () => ({ query: { type: 'PRODUCTS' } }),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const COLUMNS = [
  { key: 'name', header: 'Product Name', required: true, help: 'The name' },
  { key: 'unit', header: 'Base Unit', required: true, help: 'Must already exist' },
];

const CLEAN = {
  type: 'PRODUCTS',
  columns: COLUMNS,
  rows: [
    { rowNumber: 2, values: { name: 'PVC Pipe', unit: 'Piece' }, errors: [] },
    { rowNumber: 3, values: { name: 'Cement', unit: 'Piece' }, errors: [] },
  ],
  totalRows: 2,
  validRows: 2,
  invalidRows: 0,
  missingColumns: [],
};

const WITH_A_BAD_ROW = {
  ...CLEAN,
  rows: [
    CLEAN.rows[0],
    {
      rowNumber: 3,
      values: { name: 'Cement', unit: 'Peice' },
      errors: [
        { column: 'Base Unit', message: 'There is no unit called "Peice" — add it in Units first' },
      ],
    },
  ],
  validRows: 1,
  invalidRows: 1,
};

/** Choosing a file through the real input, as a shopkeeper does. */
async function chooseFile(wrapper: ReturnType<typeof mount>, text = 'Product Name\r\nPVC Pipe') {
  const input = wrapper.find('#import-file');
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [{ name: 'products.csv', text: () => Promise.resolve(text) }],
  });
  await input.trigger('change');
  await flushPromises();
}

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions(['catalog.product.create', 'catalog.product.view']);
  preview.mockReset();
  commit.mockReset();
  push.mockReset();
  preview.mockResolvedValue(CLEAN);
});

afterEach(() => {
  useSession().clear();
});

describe('ImportPage', () => {
  it('offers only the files this role may create (UI-09)', () => {
    const wrapper = mount(ImportPage);

    // Products and opening stock need `catalog.product.create`, which this
    // session has; customers and suppliers need permissions it does not.
    const kinds = (wrapper.vm as unknown as { kinds: { type: string }[] }).kinds;
    expect(kinds.map((kind) => kind.type)).toEqual(['PRODUCTS', 'OPENING_STOCK']);
  });

  it('says so plainly when the role may create nothing at all', () => {
    useSession().setPermissions(['catalog.product.view']);

    const wrapper = mount(ImportPage);

    expect(wrapper.text()).toContain('Nothing to import');
  });

  it('previews the chosen file and shows every row before anything is written', async () => {
    const wrapper = mount(ImportPage);

    await chooseFile(wrapper);

    expect(preview).toHaveBeenCalledWith('test-access', 'PRODUCTS', 'Product Name\r\nPVC Pipe');
    expect(commit).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('PVC Pipe');
    expect(wrapper.text()).toContain('Cement');
  });

  /*
   * §5.6: the file posts whole or not at all, so a file with one bad row must
   * not offer an Import button that would import "the good ones".
   */
  it('will not import a file with a bad row, and shows the row and its reason', async () => {
    preview.mockResolvedValue(WITH_A_BAD_ROW);
    const wrapper = mount(ImportPage);

    await chooseFile(wrapper);

    expect(wrapper.text()).toContain('There is no unit called "Peice"');
    const importButton = wrapper.findAll('button').find((button) => button.text().includes('Import'));
    expect(importButton?.attributes('disabled')).toBeDefined();
  });

  it('imports the same text it previewed, with one operation id (UI-34)', async () => {
    commit.mockResolvedValue({ type: 'PRODUCTS', rows: 2, imported: 2 });
    const wrapper = mount(ImportPage);
    await chooseFile(wrapper);

    const importButton = wrapper.findAll('button').find((button) => button.text().includes('Import'));
    await importButton?.trigger('click');
    await flushPromises();

    const [token, type, csv, operationId] = commit.mock.calls[0] as string[];
    expect(token).toBe('test-access');
    expect(type).toBe('PRODUCTS');
    expect(csv).toBe(preview.mock.calls[0]?.[2]);
    expect(operationId).toHaveLength(26);
    expect(wrapper.text()).toContain('2 rows imported');
  });

  it("shows the server's own code and message when the import is refused (UI-28)", async () => {
    commit.mockRejectedValue(
      new ApiError('VALIDATION_FAILED', 'Nothing was imported: row 3 (invalid)', 400),
    );
    const wrapper = mount(ImportPage);
    await chooseFile(wrapper);

    const importButton = wrapper.findAll('button').find((button) => button.text().includes('Import'));
    await importButton?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('VALIDATION_FAILED');
    expect(wrapper.text()).toContain('Nothing was imported: row 3');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });
});
