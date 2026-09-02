import { z } from 'zod';

/** The two shapes every module restates locally rather than sharing a barrel. */
const ULID = z.string().length(26);
const BUSINESS_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

import { partyResponseSchema } from './parties';

import { productResponseSchema } from './products';

/**
 * Offline devices — the shop's one offline writer, and the gate it must pass
 * (§5.23, D-01, D-24, owner decisions 2026-08-31).
 *
 * Two words that must never be confused, here or anywhere downstream:
 *
 * - **`OFFLINE_SETUP_READY`** — this machine has passed every check and holds
 *   the shop's offline authority. It still cannot trade without internet,
 *   because the local database and the sync engine are not built yet.
 * - **`OFFLINE_READY`** — reserved. It means the shop can genuinely work
 *   through a power cut, and nothing may report it until SQLite, the snapshot
 *   and the outbox all actually work.
 */
export const deviceStatusSchema = z.enum([
  'REGISTERED',
  'PENDING',
  'ACTIVE',
  'DRAINING',
  'REVOKED',
  'FORCE_REVOKED',
]);

export type DeviceStatusValue = z.infer<typeof deviceStatusSchema>;

export const offlineGateStepSchema = z.enum([
  'PWA_INSTALLED',
  'STORAGE_PERSISTED',
  'STORAGE_SPACE',
  'DEVICE_AUTHORIZED',
]);

export type OfflineGateStepValue = z.infer<typeof offlineGateStepSchema>;

/**
 * A registered browser profile, as the device list shows it.
 *
 * The public key is **not** returned. It identifies the profile and is checked
 * on every call, but a list screen that prints it invites somebody to copy it
 * into a support chat, and authority bound to a key that has been shared around
 * is not authority (D-01).
 */
export const deviceSchema = z
  .object({
    id: z.string(),
    /** What the shop calls this machine — "Counter PC — Chrome". */
    name: z.string(),
    status: deviceStatusSchema,
    /** True for the browser making this request, so the list can say "this one". */
    isThisDevice: z.boolean(),
    /** What the browser told us about itself at registration, for recognising it. */
    platform: z.string(),
    registeredByName: z.string(),
    registeredAt: z.string(),
    requestedAt: z.string().nullable(),
    approvedAt: z.string().nullable(),
    approvedByName: z.string().nullable(),
    revokedAt: z.string().nullable(),
    revokedByName: z.string().nullable(),
    /** Why it was cut off, when it was force revoked. Never empty in that case. */
    revokeReason: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
    /** Whether anything this device sends from now on must be held for review. */
    quarantinesPushes: z.boolean(),
    /**
     * The permanent short code this machine's sales carry (Phase 12.4, §8).
     *
     * `S-2026-A-000123` — the `A` is this. Assigned once at registration and
     * never changed or reused, because an invoice number is on filed paper.
     * Null only for a machine registered before Phase 12.4 and not yet
     * backfilled.
     */
    deviceCode: z.string().nullable().default(null),

    /**
     * What this machine's local copy actually cost it (Phase 12.3, O-6).
     *
     * Null until it has stored one. Printed on the Offline & Devices card so
     * the shop's own hardware is what eventually settles the open item, and so
     * an Owner can see the copy is really there and how big it grew.
     */
    storedSnapshotBytes: z.number().int().nullable(),
    snapshotUsageBytes: z.number().int().nullable(),
    snapshotQuotaBytes: z.number().int().nullable(),
    snapshotElapsedMs: z.number().int().nullable(),
    snapshotReportedAt: z.string().nullable(),
  })
  .strict();

export type DeviceResponse = z.infer<typeof deviceSchema>;

export const deviceListResponseSchema = z
  .object({
    devices: z.array(deviceSchema),
    /** The one machine holding the shop's offline authority, if any. */
    activeDeviceId: z.string().nullable(),
  })
  .strict();

export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;

/**
 * What this browser needs to draw its own state: the gate's four answers, the
 * room the snapshot will need, and what it may do about any of it.
 */
export const offlineStatusResponseSchema = z
  .object({
    /** Null until this browser has registered itself. */
    device: deviceSchema.nullable(),
    /**
     * The shop this session belongs to (Phase 12.3).
     *
     * The browser needs it to answer one question before reading anything it
     * stored: is this copy this shop's? A machine signed into a second business
     * must never be shown the first one's customers, and the stored rows
     * themselves carry no tenant — the server had already scoped them.
     */
    tenantId: z.string(),
    /** Bytes this tenant's snapshot needs, headroom included (§5.23). */
    requiredBytes: z.number().int(),
    /** The same number before headroom, so the screen can explain the sum. */
    snapshotBytes: z.number().int(),
    /** Whether the server holds an offline writer already, and which one. */
    activeDeviceName: z.string().nullable(),
    activeIsThisDevice: z.boolean(),
    /** What the caller may do, so the screen draws only real buttons (UI-09). */
    canRegister: z.boolean(),
    canApprove: z.boolean(),
    canRename: z.boolean(),
    canRevoke: z.boolean(),
    canForceRevoke: z.boolean(),
  })
  .strict();

export type OfflineStatusResponse = z.infer<typeof offlineStatusResponseSchema>;

/** A name a person can recognise across the counter. */
const deviceNameSchema = z.string().trim().min(2).max(60);

/**
 * Registering a browser profile.
 *
 * The public key is generated in the browser and never leaves it in private
 * form (D-01). Registering grants nothing: it creates identity, and identity is
 * what lets the machine ask.
 */
export const registerDeviceRequestSchema = z
  .object({
    /** Base64url SPKI of the profile's public key. Unique within the tenant. */
    publicKey: z.string().trim().min(32).max(2048),
    name: deviceNameSchema,
    /** Browser and OS as the browser reports them — for recognising the row. */
    platform: z.string().trim().max(200),
  })
  .strict();

export type RegisterDeviceRequest = z.infer<typeof registerDeviceRequestSchema>;

export const requestOfflineRwRequestSchema = z.object({}).strict();

export const approveDeviceRequestSchema = z
  .object({
    deviceId: z.string(),
    /** The approver may correct the name at the moment they approve it. */
    name: deviceNameSchema,
  })
  .strict();

export type ApproveDeviceRequest = z.infer<typeof approveDeviceRequestSchema>;

export const renameDeviceRequestSchema = z
  .object({ deviceId: z.string(), name: deviceNameSchema })
  .strict();

export type RenameDeviceRequest = z.infer<typeof renameDeviceRequestSchema>;

/** A normal revoke. The machine drains first, so nothing needs a reason. */
export const revokeDeviceRequestSchema = z
  .object({ deviceId: z.string() })
  .strict();

export type RevokeDeviceRequest = z.infer<typeof revokeDeviceRequestSchema>;

/**
 * Cutting a machine off without letting it drain.
 *
 * Password and reason are both required by the owner's decision of 2026-08-31,
 * and the service refuses without either. The password is re-entered rather
 * than the PIN: the PIN is typed at the counter all day in front of people, and
 * this is the act that can strand a day's takings.
 */
export const forceRevokeDeviceRequestSchema = z
  .object({
    deviceId: z.string(),
    password: z.string().min(1),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export type ForceRevokeDeviceRequest = z.infer<typeof forceRevokeDeviceRequestSchema>;

/**
 * Replace Writer — one atomic hand-over from the old machine to the new one.
 *
 * It exists because the alternative is two steps a shopkeeper has to understand
 * the order of: the slot is single-occupancy, so approving a new machine while
 * an old one still holds it must either fail or quietly evict. Clearing site
 * data on the counter PC makes it a *new* device with a new keypair, so this is
 * the ordinary path, not the exotic one.
 *
 * `password` and `reason` are required only when the old machine cannot drain —
 * that is the force route, and the force route is the Owner's alone.
 */
export const replaceWriterRequestSchema = z
  .object({
    /** The machine that should hold the shop's offline authority from now on. */
    deviceId: z.string(),
    name: deviceNameSchema,
    /**
     * True when the old machine is gone, dead or stolen and cannot send up what
     * it holds. It turns the hand-over into a force revoke of the old device.
     */
    forceOldDevice: z.boolean().default(false),
    password: z.string().min(1).optional(),
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .strict();

export type ReplaceWriterRequest = z.infer<typeof replaceWriterRequestSchema>;

/**
 * What the browser measured for the D-24 gate, reported so the owner's device
 * list shows the same truth the machine itself is showing.
 *
 * Reporting a failure **never** revokes server-side authority (owner decision
 * 2026-08-31): a machine whose storage permission was cleared this morning is
 * still the shop's approved offline computer, and re-granting it is a browser
 * fix, not a re-approval. It only stops writing until the gate passes again.
 */
export const reportGateRequestSchema = z
  .object({
    installed: z.boolean(),
    persisted: z.boolean(),
    availableBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type ReportGateRequest = z.infer<typeof reportGateRequestSchema>;

/* ------------------------------------------------------------------ snapshot
 * Phase 12.3 — the shop's data on the shop's machine (§5.23, owner decisions
 * 2026-08-31).
 */

/**
 * Which parts of the shop the snapshot carries.
 *
 * The snapshot is built **with the permissions of whoever refreshed it**, and
 * these flags say what that person could see. A cashier's refresh brings the
 * catalogue and the customers and leaves the suppliers out, because that is
 * what a cashier may read — and a copy that quietly held what its downloader
 * could not read would put data on the shop's disk that no screen would ever
 * be allowed to show.
 *
 * The Offline & Devices card prints these, so an Owner who finds no suppliers
 * offline is told why and can press Refresh Now themselves.
 */
export const snapshotIncludesSchema = z
  .object({
    products: z.boolean(),
    customers: z.boolean(),
    suppliers: z.boolean(),
    vendors: z.boolean(),
    /** Whether cost prices are in it — `inventory.cost.view` at refresh time. */
    cost: z.boolean(),
    /** Phase 12.4 — whether anybody can sign in on this machine offline. */
    users: z.boolean().default(false),
    /** Phase 12.4 — whether the sales history came down (`sale.view`). */
    sales: z.boolean().default(false),
  })
  .strict();

export type SnapshotIncludes = z.infer<typeof snapshotIncludesSchema>;

/**
 * One download of the shop's readable data.
 *
 * Rows are **the same response objects the online screens already render**, not
 * a second shape invented for offline. A separate offline DTO would be a second
 * definition of a product to keep in step with the first, and the first day
 * they drifted the offline screen would start lying quietly.
 *
 * There is deliberately nothing here that a document could be rebuilt from:
 * this slice reads, and `OFFLINE_READY` stays reserved.
 */
/**
 * One person the offline machine may let in (Phase 12.4, §9).
 *
 * The PIN hash travels; the password hash never does. A password opens far more
 * than a till — the web app, another shop's machine, anywhere the person has
 * reused it — and there is no reason for a copy of one to sit on a counter PC
 * that may be stolen. A user without a PIN simply cannot work offline, and the
 * sign-in screen says so instead of falling back to something weaker.
 *
 * Permissions travel with them because the offline screens have to hide what
 * the person may not do (UI-09). They are what the shop's roles said at the
 * moment the snapshot was taken: a permission granted or taken away during the
 * outage reaches the machine at the next sync and not before, which is stated
 * plainly rather than pretended away.
 */
/**
 * Naming who may open the counter on a machine while it is disconnected
 * (Phase 12.4, §9).
 *
 * The whole set at once, because it is one decision: ticking two people and
 * clearing a third is a single thought about that machine, and applying it in
 * three steps would leave a moment where it trusted nobody.
 */
export const setDeviceUsersRequestSchema = z
  .object({ userIds: z.array(ULID).max(200) })
  .strict();

export type SetDeviceUsersRequest = z.infer<typeof setDeviceUsersRequestSchema>;

export const deviceUsersResponseSchema = z
  .object({
    users: z.array(z.object({ userId: ULID, displayName: z.string() }).strict()),
    /** Everyone in the shop who could be ticked, and whether they have a PIN. */
    candidates: z.array(
      z
        .object({ userId: ULID, displayName: z.string(), hasPin: z.boolean() })
        .strict(),
    ),
  })
  .strict();

export type DeviceUsersResponse = z.infer<typeof deviceUsersResponseSchema>;

export const offlineUserSchema = z
  .object({
    id: ULID,
    displayName: z.string(),
    username: z.string().nullable(),
    /** Argon2, verified locally by the same hasher the server uses. */
    pinHash: z.string(),
    permissions: z.array(z.string()),
  })
  .strict();

export type OfflineUser = z.infer<typeof offlineUserSchema>;

/**
 * A sale the machine can find and read while the line is down (§13).
 *
 * Summaries, not full documents: enough to answer "what did this customer buy",
 * "is this invoice paid" and "find the slip with this number" at the counter.
 * The sale the offline machine made itself is held whole, locally, by the
 * machine that made it.
 */
export const offlineSaleSchema = z
  .object({
    id: ULID,
    number: z.string(),
    businessDate: BUSINESS_DATE,
    partyId: ULID,
    customerName: z.string(),
    customerPhone: z.string().nullable(),
    grandTotalMinor: z.number().int(),
    paidMinor: z.number().int(),
    dueMinor: z.number().int(),
    status: z.string(),
  })
  .strict();

export type OfflineSale = z.infer<typeof offlineSaleSchema>;

export const offlineSnapshotResponseSchema = z
  .object({
    /** When the server built it — what the offline bar shows as Last synced. */
    takenAt: z.string(),
    /** Who pressed Refresh, so the card can explain a partial copy. */
    takenByName: z.string(),
    /**
     * The local schema this payload is shaped for. A device holding a snapshot
     * from an older build discards it and downloads again rather than reading
     * rows into columns that have moved.
     */
    schemaVersion: z.number().int(),
    includes: snapshotIncludesSchema,
    products: z.array(productResponseSchema),
    customers: z.array(partyResponseSchema),
    suppliers: z.array(partyResponseSchema),
    vendors: z.array(partyResponseSchema),
    /**
     * Phase 12.4 — who may sign in, and what they may do, while the line is
     * down. Empty until somebody names the people allowed on this machine.
     */
    users: z.array(offlineUserSchema).default([]),
    /**
     * Twelve months of closed sales plus every unpaid one, however old (§13).
     * Balances never depend on this: they ride on the party rows above, which
     * carry what the ledger says.
     */
    sales: z.array(offlineSaleSchema).default([]),
    /** How far back the sales above reach, so the screen can say so. */
    salesSince: BUSINESS_DATE.nullable().default(null),
  })
  .strict();

export type OfflineSnapshotResponse = z.infer<typeof offlineSnapshotResponseSchema>;

/**
 * What the device measured after storing a snapshot, reported back so open item
 * O-6 can be closed from real shops instead of a lab (owner direction
 * 2026-08-31: record the real numbers, and set no arbitrary ceiling).
 *
 * Like the gate report, it is a report and never a gate: nothing here can
 * refuse a device or take authority away.
 */
export const reportSnapshotRequestSchema = z
  .object({
    /** Bytes the local database actually occupies once written. */
    storedBytes: z.number().int().nonnegative(),
    /** `navigator.storage.estimate()` after the write — usage and quota. */
    usageBytes: z.number().int().nonnegative().nullable(),
    quotaBytes: z.number().int().nonnegative().nullable(),
    /** How long the whole download-and-store took, in milliseconds. */
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

export type ReportSnapshotRequest = z.infer<typeof reportSnapshotRequestSchema>;
