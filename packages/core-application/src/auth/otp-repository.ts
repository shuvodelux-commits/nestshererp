import type { IdentifierChannel, OtpPurpose } from '@sher/core-domain';

import type { Tx } from '../ports/unit-of-work';

/**
 * OTP codes are stored hashed, never logged, never returned in a response body
 * (§5.3). The table carries no `tenant_id` — verification happens before a
 * tenant exists — so it is not RLS-scoped and must never be read by an API.
 *
 * Every method is scoped by `purpose`. A signup code and a password-reset code
 * for the same phone number are different codes with different powers, and
 * neither flow may ever spend the other's (D-07).
 */
export interface StoredOtp {
  readonly id: string;
  readonly codeHash: string;
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly consumedAt: Date | null;
}

export interface NewOtp {
  readonly id: string;
  readonly identifier: string;
  readonly channel: IdentifierChannel;
  readonly purpose: OtpPurpose;
  readonly codeHash: string;
}

export interface OtpRepository {
  /** Kills every live code for this identifier and purpose — a new request invalidates the old one. */
  invalidateAll(tx: Tx, identifier: string, purpose: OtpPurpose): Promise<void>;
  insert(tx: Tx, otp: NewOtp): Promise<void>;
  /** The most recent code for this identifier and purpose, or null. */
  findLatest(tx: Tx, identifier: string, purpose: OtpPurpose): Promise<StoredOtp | null>;
  recordFailedAttempt(tx: Tx, id: string): Promise<void>;
  consume(tx: Tx, id: string): Promise<void>;
}
