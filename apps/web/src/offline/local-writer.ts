import {
  outboxCounts,
  peekSaleNumber,
  queueOperation,
  readLocalState,
} from '@sher/adapter-sqlite-wasm';
import { saleTotals } from '@sher/core-domain';
import { SystemClock } from '@sher/shared-utils';
import type { CreateSaleRequest } from '@sher/core-contracts';

import { ApiError } from '../api/client';
import { useSession } from '../auth/session';

/**
 * Writing at the counter when the counter cannot reach the shop's books
 * (§5.23, Phase 12.4).
 *
 * **The fallback lives in the API layer, exactly where 12.3 put the read
 * fallback**, and for the same reason written down there: the POS, the purchase
 * form, the returns dialog and the cash day are long screens, and teaching each
 * of them to hold two write paths would double the branches in the part of the
 * app a shopkeeper uses most — with the offline branch being the one nobody
 * exercises until the day it matters. Down here there is one rule in one place:
 * send it to the server, and if the server is not there, queue the very same
 * command and answer in the very same shape.
 *
 * Three rules this depends on:
 *
 * - **Only `NETWORK_UNREACHABLE` queues.** A 403, a 409 or a period-closed
 *   refusal is the server answering, and answering *no*. Queueing a refusal
 *   would turn "you may not" into "you may, later".
 * - **Only the machine holding `OFFLINE_RW` queues** (D-01). Any other
 *   disconnected profile is read-only and gets the network error it deserves,
 *   so two machines can never both believe they are writing.
 * - **The queue is committed before this returns.** A slip printed for a sale
 *   the database never heard of is the one failure an offline till cannot have
 *   (§2, §19), so a failed local commit is reported as a failed sale.
 */

/** What the counter needs to know before it may write anything locally. */
async function mayWriteOffline(): Promise<{ readonly deviceCode: string; readonly deviceId: string } | null> {
  try {
    const state = await readLocalState();
    if (state === null || state.deviceCode === null || state.deviceId === null) return null;
    return { deviceCode: state.deviceCode, deviceId: state.deviceId };
  } catch {
    return null;
  }
}

/**
 * The seam every offline-capable write goes through.
 *
 * `queue` is only reached when the server could not be, this machine is the
 * shop's offline writer, and the local commit succeeded.
 */
export async function offlineWrite<T>(
  fromServer: () => Promise<T>,
  queue: (device: { readonly deviceCode: string; readonly deviceId: string }) => Promise<T>,
): Promise<T> {
  try {
    return await fromServer();
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.code !== 'NETWORK_UNREACHABLE') throw cause;

    const device = await mayWriteOffline();
    if (device === null) throw cause;

    return queue(device);
  }
}

/** Time comes from the Clock port, here as everywhere else (B-clock). */
const clock = new SystemClock();

/**
 * The business date the machine is working on.
 *
 * The machine's own timezone, deliberately: the counter PC stands in the shop,
 * and asking the server which timezone the tenant keeps is the one question it
 * cannot answer while the line is down — which is precisely when this is
 * needed. The same choice 12.3's snapshot refresh already makes.
 */
export function localBusinessDate(): string {
  return clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * Who is at the counter, read from the access token they are already carrying.
 *
 * The session store keeps a username and not an id, and the id is what the
 * shop's audit trail records — so it comes from the `sub` claim of the token
 * the browser is holding. Reading a claim is not trusting one: the server
 * verifies the signature on every call and would refuse an operation whose
 * actor does not exist, whatever this said.
 *
 * A machine opened cold during an outage has no token at all, and the person
 * standing at it proved who they were against the PIN hash in the snapshot
 * instead. That id is the actor, and it is the same id the server knows — it
 * came *from* the server, in the snapshot. Without this the whole outage would
 * replay with an empty actor, and the shop's audit would say nobody sold
 * anything all day.
 */
export function currentUserId(): string {
  const session = useSession();
  const token = session.accessToken.value;
  if (token === null) return session.offlineUser.value?.id ?? '';
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) return '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return String((JSON.parse(json) as { sub?: string }).sub ?? '');
  } catch {
    return '';
  }
}

function context(businessDate?: string): {
  readonly userId: string;
  readonly businessDate: string;
  readonly deviceCreatedAt: string;
} {
  return {
    // The actor is who is at the counter now, and stays the actor through
    // replay: the shop's audit must say who sold the goods, not who happened to
    // be signed in when the line came back.
    userId: currentUserId(),
    businessDate: businessDate ?? localBusinessDate(),
    deviceCreatedAt: clock.now().toISOString(),
  };
}

/**
 * A sale, queued and numbered on this machine.
 *
 * The money is computed here with `saleTotals` — the **same domain function the
 * posting service uses** — so the figure printed on the customer's slip is the
 * figure the server will arrive at, to the poisha. That is not a coincidence to
 * be relied on loosely: `core-domain` is browser-safe by design precisely so
 * the counter and the books can share their arithmetic rather than each having
 * their own (§4, §5).
 *
 * Cost, COGS, lots and the journal are deliberately absent. The device does not
 * implement the accounting engine, and a profit figure it guessed would be
 * worse than the "Profit available after sync" the screen says instead.
 */
export async function queueSale(
  payload: CreateSaleRequest,
  operationId: string,
  device: { readonly deviceCode: string; readonly deviceId: string },
): Promise<{ readonly number: string; readonly localSeq: number; readonly totals: ReturnType<typeof saleTotals> }> {
  const totals = saleTotals({
    lines: payload.lines.map((line) => ({
      productId: line.productId,
      qty: line.qty,
      unitPriceMinor: line.unitPriceMinor,
      lineDiscountMinor: line.lineDiscountMinor,
    })),
    discountMinor: payload.discountMinor,
    paidMinor: payload.payments.reduce((sum, payment) => sum + payment.amountMinor, 0),
  });

  const businessDate = payload.businessDate ?? localBusinessDate();
  const year = Number(businessDate.slice(0, 4));
  const number = (await peekSaleNumber(year)) ?? `S-${String(year)}-${device.deviceCode}-000001`;

  const stockDelta: Record<string, number> = {};
  for (const line of payload.lines) {
    stockDelta[line.productId] = (stockDelta[line.productId] ?? 0) - line.qty;
  }

  const queued = await queueOperation({
    operationId,
    type: 'SALE_CREATE',
    payload,
    context: context(businessDate),
    digest: {
      itemsTotalMinor: totals.itemsTotalMinor,
      discountMinor: totals.discountMinor,
      grandTotalMinor: totals.grandTotalMinor,
      paidMinor: totals.paidMinor,
      dueMinor: totals.dueMinor,
    },
    documentNumber: number,
    document: {
      partyId: payload.partyId,
      partyName: payload.customerName,
      totalMinor: totals.grandTotalMinor,
      paidMinor: totals.paidMinor,
      dueMinor: totals.dueMinor,
      view: payload,
    },
    stockDelta,
    ...(payload.partyId === null || totals.dueMinor === 0
      ? {}
      : { balanceDelta: { partyId: payload.partyId, amountMinor: totals.dueMinor } }),
  });

  return { number, localSeq: queued.localSeq, totals };
}

/**
 * Anything else the counter may do offline, queued in one shape.
 *
 * Deliberately generic: a purchase, a return, an expense, a stock adjustment
 * and a cash day are all "the command the online endpoint takes, plus the
 * operation id", and the only thing that differs between them is which figures
 * the counter shows back. Writing thirteen near-identical functions would have
 * been thirteen places to forget the commit-before-confirm rule.
 */
export async function queueCommand(command: {
  readonly type: string;
  readonly payload: unknown;
  readonly operationId: string;
  readonly businessDate?: string;
  readonly dependsOn?: readonly number[];
  readonly document?: {
    readonly partyId: string | null;
    readonly partyName: string | null;
    readonly totalMinor: number;
    readonly paidMinor: number;
    readonly dueMinor: number;
  };
  readonly stockDelta?: Readonly<Record<string, number>>;
  readonly balanceDelta?: { readonly partyId: string; readonly amountMinor: number };
}): Promise<{ readonly operationId: string; readonly localSeq: number }> {
  const queued = await queueOperation({
    operationId: command.operationId,
    type: command.type,
    payload: command.payload,
    context: context(command.businessDate),
    dependsOn: command.dependsOn ?? [],
    ...(command.document === undefined
      ? {}
      : { document: { ...command.document, view: command.payload } }),
    ...(command.stockDelta === undefined ? {} : { stockDelta: command.stockDelta }),
    ...(command.balanceDelta === undefined ? {} : { balanceDelta: command.balanceDelta }),
  });
  return { operationId: command.operationId, localSeq: queued.localSeq };
}

/** How much this machine is still holding — what the bar and the badge show. */
export async function pendingSummary(): Promise<{
  readonly pending: number;
  readonly refused: number;
  readonly oldestPendingAt: string | null;
}> {
  try {
    return await outboxCounts();
  } catch {
    return { pending: 0, refused: 0, oldestPendingAt: null };
  }
}
