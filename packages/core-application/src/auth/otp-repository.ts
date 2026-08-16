import type { IdentifierChannel } from '@sher/core-domain';

import type { Tx } from '../ports/unit-of-work';

/**
 * OTP codes are stored hashed, never logged, never returned in a response body
 * (§5.3). The table carries no `tenant_id` — verification happens before a
 * tenant exists — so it is not RLS-scoped and must never be read by an API.
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
  readonly codeHash: string;
}

export interface OtpRepository {
  /** Kills every live code for this identifier — a new request invalidates the old one. */
  invalidateAll(tx: Tx, identifier: string): Promise<void>;
  insert(tx: Tx, otp: NewOtp): Promise<void>;
  /** The most recent unconsumed code for this identifier, or null. */
  findLatest(tx: Tx, identifier: string): Promise<StoredOtp | null>;
  recordFailedAttempt(tx: Tx, id: string): Promise<void>;
  consume(tx: Tx, id: string): Promise<void>;
}
