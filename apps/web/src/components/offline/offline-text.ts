import type { OfflineGateStep } from '@sher/core-domain';

/**
 * What the offline screens say, in one place (§2.7.C: English primary, Bangla
 * helper text that explains the business meaning).
 *
 * Written for somebody who has never heard the words "persistent storage". Each
 * blocked step gets three things: what is wrong, what it means for the shop,
 * and the one button that fixes it. Nothing here says the shop can trade
 * without internet, because in this module it cannot.
 */
export const OFFLINE_BN = {
  chipSetupReady: 'অফলাইন সেটআপ প্রস্তুত',
  chipReadOnly: 'অফলাইনে শুধু দেখা যাবে',
  chipOnlineOnly: 'ইন্টারনেট লাগবে',
  chipChecking: 'দেখা হচ্ছে…',
  page: 'অফলাইন ও কম্পিউটার',
  install: 'অ্যাপ ইনস্টল করুন',
  allowStorage: 'স্থায়ী জায়গার অনুমতি দিন',
  askPermission: 'মালিকের অনুমতি নিন',
  updateReady: 'নতুন সংস্করণ এসেছে',
} as const;

export interface GateStepCopy {
  readonly title: string;
  readonly titleBn: string;
  /** What it means for the shop, when this is the step that failed. */
  readonly whenBlocked: string;
  readonly whenBlockedBn: string;
  /** The button that fixes it, when there is one. */
  readonly action: 'INSTALL' | 'PERSIST' | 'SPACE' | 'REQUEST' | null;
}

export const GATE_STEPS: Readonly<Record<OfflineGateStep, GateStepCopy>> = {
  PWA_INSTALLED: {
    title: 'The app is installed on this computer',
    titleBn: 'অ্যাপটি এই কম্পিউটারে ইনস্টল করা আছে',
    whenBlocked: 'SherERP is open in a browser tab. Install it as an app first.',
    whenBlockedBn: 'এখন ব্রাউজারের ট্যাবে চলছে — আগে অ্যাপ হিসেবে ইনস্টল করুন।',
    action: 'INSTALL',
  },
  STORAGE_PERSISTED: {
    title: 'The browser will keep this shop’s data',
    titleBn: 'ব্রাউজার এই দোকানের তথ্য মুছবে না',
    whenBlocked:
      'The browser has not promised to keep data on this computer, so it could be cleared without warning.',
    whenBlockedBn: 'ব্রাউজার এখনো কথা দেয়নি — তাই তথ্য হঠাৎ মুছে যেতে পারে।',
    action: 'PERSIST',
  },
  STORAGE_SPACE: {
    title: 'There is enough room on this computer',
    titleBn: 'এই কম্পিউটারে যথেষ্ট জায়গা আছে',
    whenBlocked: 'This computer does not have enough free space for the shop’s data.',
    whenBlockedBn: 'দোকানের তথ্য রাখার মতো যথেষ্ট জায়গা নেই।',
    action: 'SPACE',
  },
  DEVICE_AUTHORIZED: {
    title: 'This is the shop’s approved offline computer',
    titleBn: 'এটাই দোকানের অনুমোদিত অফলাইন কম্পিউটার',
    whenBlocked: 'The owner has not chosen this computer as the shop’s offline computer.',
    whenBlockedBn: 'মালিক এখনো এই কম্পিউটারকে অফলাইন কম্পিউটার হিসেবে বেছে নেননি।',
    action: 'REQUEST',
  },
};

/** Bytes as a shopkeeper reads them — "180 MB", "4.2 GB". */
export function bytesText(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2).toString()} MB`;
  return `${Math.max(1, Math.round(bytes / 1024)).toString()} KB`;
}

/** What each stored device state is called on screen. */
export const DEVICE_STATUS_TEXT: Readonly<
  Record<string, { readonly label: string; readonly bn: string; readonly tone: string }>
> = {
  REGISTERED: { label: 'Registered', bn: 'নিবন্ধিত', tone: 'secondary' },
  PENDING: { label: 'Waiting for approval', bn: 'অনুমোদনের অপেক্ষায়', tone: 'warn' },
  ACTIVE: { label: 'Offline computer', bn: 'অফলাইন কম্পিউটার', tone: 'success' },
  DRAINING: { label: 'Handing over', bn: 'হস্তান্তর হচ্ছে', tone: 'warn' },
  REVOKED: { label: 'Permission taken back', bn: 'অনুমতি ফিরিয়ে নেওয়া', tone: 'secondary' },
  FORCE_REVOKED: { label: 'Cut off', bn: 'বিচ্ছিন্ন করা হয়েছে', tone: 'danger' },
};

/* ------------------------------------------------------------------ 12.3
 * The bar a screen wears when it is reading the local copy, and the line under
 * a button that cannot be pressed (owner decisions 2026-08-31).
 */

/**
 * The offline bar's wording, given exactly by the owner on 2026-08-31.
 *
 * Two facts, in the order a shopkeeper needs them: the internet is gone, and
 * this is how old what you are looking at is. The time stays in Western digits
 * (UI-47) even inside the Bangla helper.
 *
 * A note on the word *synced*: nothing in this slice syncs. The shop's copy is
 * downloaded and read, and the push, pull and conflict engine that earns the
 * word is a later build. The owner chose this wording knowing that, so the
 * screen says it — while the API routes, the stored columns and the guide all
 * keep saying *snapshot*, so the code never starts claiming an engine it does
 * not have.
 */
export function offlineBarText(when: string): string {
  return `Offline — showing local data · Last synced: ${when}`;
}

export function offlineBarTextBn(when: string): string {
  return `ইন্টারনেট নেই — এই কম্পিউটারে রাখা তথ্য দেখানো হচ্ছে · সর্বশেষ আপডেট: ${when}`;
}

/** The bar when this machine has no copy at all — there is nothing to date. */
export const OFFLINE_NO_COPY = 'Offline — this computer has no copy of the shop’s data';
export const OFFLINE_NO_COPY_BN = 'ইন্টারনেট নেই — এই কম্পিউটারে দোকানের তথ্য রাখা নেই';

/** Under every Save, Post and New while the line is down. */
export const NEEDS_INTERNET = 'Needs internet';
export const NEEDS_INTERNET_BN = 'ইন্টারনেট লাগবে';

/** Beside a stock figure, so nobody reads a stored count as a live one. */
export function asOfText(when: string): string {
  return `as of ${when}`;
}

export const SNAPSHOT_BN = {
  card: 'দোকানের তথ্যের কপি',
  refresh: 'এখনই নতুন করে আনুন',
  retry: 'আবার চেষ্টা করুন',
  none: 'এখনো কোনো কপি নেই',
  stored: 'এই কম্পিউটারে রাখা আছে',
  warning: 'কপিটি পুরোনো হয়ে গেছে',
} as const;
