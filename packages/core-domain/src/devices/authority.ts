/**
 * Who may write offline, and how that permission moves between machines
 * (§5.23, D-01, owner decisions 2026-08-31).
 *
 * ```
 * REGISTERED → PENDING → ACTIVE → DRAINING → REVOKED
 *                          └──────────────→ FORCE_REVOKED
 * ```
 *
 * The states, in the shop's words:
 *
 * - `REGISTERED` — this browser has an identity here and may ask. Read-only.
 * - `PENDING`    — it has asked. Still read-only; asking grants nothing.
 * - `ACTIVE`     — it is the shop's one offline writer.
 * - `DRAINING`   — it is on its way out: it may send up what it already holds,
 *                  but takes no new offline work. Reaches `REVOKED` when empty.
 * - `REVOKED`    — read-only again, and everything it held arrived safely.
 * - `FORCE_REVOKED` — cut off where it could not drain. Read-only, and anything
 *                  it pushes afterwards is quarantined rather than posted.
 *
 * **`REVOKED` and `FORCE_REVOKED` are not the same fact and are never merged.**
 * One says "this machine finished and left"; the other says "we stopped
 * trusting this machine mid-sentence". Later phases read exactly that
 * difference to decide whether an arriving batch is posted or quarantined, so
 * collapsing them here would silently post work nobody vouched for.
 *
 * Pure: no clock, no database, no identity (R-C8). The service supplies who is
 * asking and what they hold; this file only says whether the move is legal.
 */
export type DeviceStatus =
  | 'REGISTERED'
  | 'PENDING'
  | 'ACTIVE'
  | 'DRAINING'
  | 'REVOKED'
  | 'FORCE_REVOKED';

export type DeviceTransition =
  | 'REQUEST'
  | 'APPROVE'
  | 'DECLINE'
  | 'REVOKE'
  | 'DRAINED'
  | 'FORCE_REVOKE'
  | 'REREQUEST';

/** Whether this state may accept offline writes at all. Only one can. */
export function holdsOfflineWrite(status: DeviceStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * Whether this state still occupies the shop's single writer slot.
 *
 * `DRAINING` does, and that is the point: a machine on its way out has not
 * finished sending up its work, so handing the slot to a second machine while
 * the first is still talking would put two writers on one shop's books — the
 * exact thing D-01 exists to prevent. This is why replacing a writer is one
 * atomic act and not "approve the new one, tidy the old one up later".
 */
export function occupiesWriterSlot(status: DeviceStatus): boolean {
  return status === 'ACTIVE' || status === 'DRAINING';
}

/** Whether work arriving from a device in this state must be quarantined. */
export function pushesAreQuarantined(status: DeviceStatus): boolean {
  return status === 'FORCE_REVOKED';
}

const ALLOWED: Readonly<Record<DeviceStatus, readonly DeviceTransition[]>> = {
  REGISTERED: ['REQUEST'],
  PENDING: ['APPROVE', 'DECLINE'],
  ACTIVE: ['REVOKE', 'FORCE_REVOKE'],
  // A draining machine can still be given up on — the shop should not have to
  // wait for a PC that has stopped answering before moving the counter.
  DRAINING: ['DRAINED', 'FORCE_REVOKE'],
  REVOKED: ['REREQUEST'],
  // A force-revoked machine may ask again, because the honest case exists: a
  // stolen laptop comes back, or the owner cut off the wrong one. It asks from
  // the bottom like anybody else, and the fact that it was cut off stays on its
  // record for whoever approves it next.
  FORCE_REVOKED: ['REREQUEST'],
};

const RESULT: Readonly<Record<DeviceTransition, DeviceStatus>> = {
  REQUEST: 'PENDING',
  APPROVE: 'ACTIVE',
  DECLINE: 'REGISTERED',
  REVOKE: 'DRAINING',
  DRAINED: 'REVOKED',
  FORCE_REVOKE: 'FORCE_REVOKED',
  REREQUEST: 'PENDING',
};

export function canTransition(from: DeviceStatus, transition: DeviceTransition): boolean {
  return ALLOWED[from].includes(transition);
}

/**
 * The state this move lands in, or `null` when the move is not legal from here.
 *
 * Null rather than a throw: the caller turns it into the refusal a person
 * reads ("that computer is already the offline computer"), and a domain file
 * has no business writing those words.
 */
export function nextStatus(
  from: DeviceStatus,
  transition: DeviceTransition,
): DeviceStatus | null {
  return canTransition(from, transition) ? RESULT[transition] : null;
}

/**
 * How a writer hand-over must be done, given the machine that holds the slot.
 *
 * `DRAIN` where the old machine can still speak for itself, `FORCE` where it
 * cannot. The owner's rule of 2026-08-31 hangs off this one answer: a drain
 * hand-over is Owner **or** Manager, a force hand-over is Owner only, with the
 * password re-entered and a reason recorded permanently.
 */
export type ReplacementRoute = 'FREE' | 'DRAIN' | 'FORCE';

export function replacementRoute(
  current: DeviceStatus | null,
  currentCanReachServer: boolean,
): ReplacementRoute {
  if (current === null || !occupiesWriterSlot(current)) return 'FREE';
  return currentCanReachServer ? 'DRAIN' : 'FORCE';
}
