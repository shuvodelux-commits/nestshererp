import { addDays, SystemClock } from '@sher/shared-utils';

import { call, login, operationKey } from './api';

/**
 * The baseline every spec starts from (Phase 18.5, owner decision 2026-09-03).
 *
 * Seeded **once per suite**, and every record here is created by calling the
 * ERP's own endpoints. Opening stock goes through the real opening workflow, so
 * the lots, the movements and the journal entries behind Product A's twenty
 * units genuinely exist and a sale can consume them; opening cash goes in as a
 * money account's opening balance, so the drawer has a posted history rather
 * than a number somebody wrote into a column.
 *
 * Every name carries the `E2E ` prefix. A spec that finds "E2E Customer" has
 * found the row this file created and nothing else — never whatever happened to
 * be in a database somebody had been using.
 */

/** Time through the port, like every other file in this repository. */
const clock = new SystemClock();
const BUSINESS_TIMEZONE = 'Asia/Dhaka';

/** Fixed, so a failed run leaves rows a person can recognise and delete. */
export const OWNER = {
  identifier: 'e2e-owner@shererp.test',
  username: 'e2eowner',
  password: 'E2eOwner!2026',
  pin: '4417',
  businessName: 'E2E Shop',
} as const;

export const MANAGER = {
  displayName: 'E2E Manager',
  identifier: 'e2e-manager@shererp.test',
  username: 'e2emanager',
  password: 'E2eManager!2026',
} as const;

export const CASHIER = {
  displayName: 'E2E Cashier',
  identifier: 'e2e-cashier@shererp.test',
  username: 'e2ecashier',
  password: 'E2eCashier!2026',
} as const;

export const PRODUCT_A = { name: 'E2E Product A', qty: 20, costMinor: 10_000, priceMinor: 15_000 } as const;
export const PRODUCT_B = { name: 'E2E Product B', qty: 10, costMinor: 20_000, priceMinor: 30_000 } as const;

/** The one expense category the suite records against. See `seedBaseline`. */
export const EXPENSE_CATEGORY = 'E2E Rent';

/** ৳1,000 in the drawer on day one. */
export const OPENING_CASH_MINOR = 100_000;

export interface Baseline {
  readonly ownerToken: string;
  readonly productAId: string;
  readonly productBId: string;
  readonly customerId: string;
  readonly supplierId: string;
  readonly cashAccountId: string;
  readonly bankAccountId: string;
  /** The day everything opened on — yesterday, so today is free to trade. */
  readonly openingDate: string;
}

/** Signup is OTP-gated; the development transport hands the code straight back. */
async function registerTenant(): Promise<string> {
  const otp = await call<{ devCode?: string }>('/api/v1/auth/registration/otp', {
    method: 'POST',
    body: { identifier: OWNER.identifier },
  });
  if (otp.devCode === undefined) {
    throw new Error(
      'The signup OTP came back without a devCode. The E2E API must run with the development ' +
        'transport (NODE_ENV=development) — there is no SMS gateway for a test to read.',
    );
  }

  const registered = await call<{ accessToken: string }>('/api/v1/auth/registration', {
    method: 'POST',
    body: {
      identifier: OWNER.identifier,
      otpCode: otp.devCode,
      businessName: OWNER.businessName,
      username: OWNER.username,
      password: OWNER.password,
      pin: OWNER.pin,
    },
  });
  return registered.accessToken;
}

/**
 * A staff account with a password on it.
 *
 * `POST /users` deliberately leaves `passwordHash` null — "a password set here
 * would be one the administrator had seen" — so the new person sets their own
 * through forgot-password. The suite does exactly that rather than reaching
 * into the users table, because the point of this file is that nothing is
 * created behind the application's back.
 */
async function createStaff(
  ownerToken: string,
  roleId: string,
  person: { displayName: string; identifier: string; username: string; password: string },
): Promise<void> {
  await call('/api/v1/users', {
    method: 'POST',
    token: ownerToken,
    body: {
      displayName: person.displayName,
      username: person.username,
      identifier: person.identifier,
      roleId,
      confirmPassword: OWNER.password,
    },
  });

  const reset = await call<{ devCode?: string }>('/api/v1/auth/password/otp', {
    method: 'POST',
    body: { identifier: person.identifier },
  });
  if (reset.devCode === undefined) throw new Error('Password reset OTP came back without a devCode.');

  await call('/api/v1/auth/password/reset', {
    method: 'POST',
    body: { identifier: person.identifier, otpCode: reset.devCode, password: person.password },
  });
}

async function createProduct(
  token: string,
  baseUnitId: string,
  product: { name: string; costMinor: number; priceMinor: number },
): Promise<string> {
  const created = await call<{ id: string }>('/api/v1/products', {
    method: 'POST',
    token,
    idempotent: true,
    body: {
      name: product.name,
      baseUnitId,
      purchasePriceMinor: product.costMinor,
      sellingPriceMinor: product.priceMinor,
      minStockQty: 0,
      brandId: null,
      categoryId: null,
      sku: null,
      barcode: null,
      description: null,
      defaultDiscountType: null,
      defaultDiscountValue: null,
      offerEnabled: false,
      offerPriceMinor: null,
      offerStartDate: null,
      offerEndDate: null,
      tracksExpiry: false,
      tracksSerial: false,
      conversionUnitId: null,
      conversionFactorQty: null,
    },
  });
  return created.id;
}

async function createParty(
  token: string,
  name: string,
  role: 'CUSTOMER' | 'SUPPLIER',
  phone: string,
): Promise<string> {
  const created = await call<{ id: string }>('/api/v1/parties', {
    method: 'POST',
    token,
    idempotent: true,
    body: {
      name,
      roles: [role],
      phone,
      address: null,
      guardianName: null,
      nid: null,
      email: null,
      notes: null,
      customerGroupId: null,
      creditLimitMinor: null,
    },
  });
  return created.id;
}

export async function seedBaseline(): Promise<Baseline> {
  const ownerToken = await registerTenant();
  // Yesterday, so today is free to trade. `addDays` because a business date is
  // a label on a calendar and this file may not touch `Date` (R-C8).
  const openingDate = addDays(clock.businessDate(BUSINESS_TIMEZONE), -1);

  // The seed roles the backfill guarantees. Read rather than assumed: a role's
  // id is a ULID minted per tenant, so it can only come from the API.
  const { roles } = await call<{ roles: readonly { id: string; code: string }[] }>(
    '/api/v1/roles',
    { token: ownerToken },
  );
  const roleId = (code: string): string => {
    const role = roles.find((entry) => entry.code === code);
    if (role === undefined) throw new Error(`Seed role ${code} is missing — did the backfill run?`);
    return role.id;
  };

  await createStaff(ownerToken, roleId('MANAGER'), MANAGER);
  await createStaff(ownerToken, roleId('CASHIER'), CASHIER);

  // A base unit is mandatory on a product (§5.5); the backfill seeds D-10's set.
  const catalog = await call<{ units: readonly { id: string; name: string }[] }>(
    '/api/v1/catalog',
    { token: ownerToken },
  );
  const baseUnitId = catalog.units[0]?.id;
  if (baseUnitId === undefined) throw new Error('No units were seeded — did the backfill run?');

  const productAId = await createProduct(ownerToken, baseUnitId, PRODUCT_A);
  const productBId = await createProduct(ownerToken, baseUnitId, PRODUCT_B);

  // The real opening workflow, so the lots exist and a sale can draw on them.
  for (const [productId, qty] of [
    [productAId, PRODUCT_A.qty],
    [productBId, PRODUCT_B.qty],
  ] as const) {
    await call('/api/v1/inventory/openings', {
      method: 'POST',
      token: ownerToken,
      idempotent: true,
      body: { productId, qty: qty * 1000, businessDate: openingDate, expiryDate: null },
    });
  }

  /*
   * An expense category, created through the ERP's own endpoint.
   *
   * **This should not be necessary and is a bug, not a fixture.**
   * `provisionTenant` seeds a new tenant's roles, units and walk-in party but
   * **not** the §5.12 expense categories, while `backfill-seed-roles.ts` does —
   * and FUNCTION_MAP states the rule that anything a tenant must own from day
   * one belongs in both. So a shop that registers today opens Record Expense to
   * a picker saying "No available options" and cannot record an expense at all
   * until somebody runs the backfill script on the server.
   *
   * Creating one here through `POST /expenses/categories` keeps the suite
   * honest about decision 8 (the ERP owns the business state) without hiding
   * the gap: fixing `provisionTenant` touches `packages/core-application`,
   * which Phase 18's boundary explicitly forbids, so it is reported rather than
   * quietly repaired here.
   */
  await call('/api/v1/expenses/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: EXPENSE_CATEGORY },
  });

  const customerId = await createParty(ownerToken, 'E2E Customer', 'CUSTOMER', '01700000001');
  const supplierId = await createParty(ownerToken, 'E2E Supplier', 'SUPPLIER', '01700000002');

  const cash = await call<{ id: string }>('/api/v1/money/accounts', {
    method: 'POST',
    token: ownerToken,
    body: {
      name: 'E2E Cash Drawer',
      type: 'CASH',
      isDrawer: true,
      openingAmountMinor: OPENING_CASH_MINOR,
      openingDate,
      operationId: operationKey(),
    },
  });

  const bank = await call<{ id: string }>('/api/v1/money/accounts', {
    method: 'POST',
    token: ownerToken,
    body: {
      name: 'E2E Bank',
      type: 'BANK',
      openingAmountMinor: 0,
      openingDate: null,
      operationId: operationKey(),
    },
  });

  /*
   * Vendors on (Phase 19, 2026-09-03).
   *
   * Consignment is off in a fresh shop, and with it off the vendor screens
   * refuse with `FEATURE_DISABLED` — correctly, but it means the whole-product
   * sweep cannot see three real screens, and a suite that skips a screen because
   * it is switched off is a suite that never tests it. Turning it on in the
   * baseline exercises them instead of excusing them. Nothing else in the
   * baseline depends on the flag, so the other specs are unaffected.
   */
  await call('/api/v1/settings/value', {
    method: 'POST',
    token: ownerToken,
    body: { key: 'vendor_management_enabled', value: 'on' },
  });

  return {
    ownerToken,
    productAId,
    productBId,
    customerId,
    supplierId,
    cashAccountId: cash.id,
    bankAccountId: bank.id,
    openingDate,
  };
}

/** A fresh token for one of the seeded people. */
export async function tokenFor(person: { identifier: string; password: string }): Promise<string> {
  return login(person.identifier, person.password);
}
