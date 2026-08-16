import type { NewOtp, OtpPurpose, OtpRepository, StoredOtp, Tx } from '@sher/core-application';
import { SYSTEM_ACTOR_ID } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { otpCodes } from './schema';
import { txOf } from './unit-of-work';

/**
 * Not tenant-scoped: an OTP is verified before a tenant exists. Nothing here
 * decides whether a code is valid — expiry and attempt limits are domain rules
 * (R-B6); this reads and writes the row they are decided from.
 *
 * Every statement is scoped by `purpose`, so a signup code and a password-reset
 * code for the same identifier can coexist and neither flow can see the other's.
 */
export class PostgresOtpRepository implements OtpRepository {
  constructor(private readonly clock: Clock) {}

  /** A new request kills the previous code — consuming it is what makes it dead. */
  async invalidateAll(tx: Tx, identifier: string, purpose: OtpPurpose): Promise<void> {
    await txOf(tx)
      .update(otpCodes)
      .set({ consumedAt: this.clock.now() })
      .where(
        and(
          eq(otpCodes.identifier, identifier),
          eq(otpCodes.purpose, purpose),
          isNull(otpCodes.consumedAt),
        ),
      );
  }

  async insert(tx: Tx, otp: NewOtp): Promise<void> {
    await txOf(tx).insert(otpCodes).values({
      id: otp.id,
      identifier: otp.identifier,
      channel: otp.channel,
      purpose: otp.purpose,
      codeHash: otp.codeHash,
      attemptCount: 0,
      createdAt: this.clock.now(),
      // Nobody is signed in when a signup or recovery code is issued.
      createdBy: SYSTEM_ACTOR_ID,
    });
  }

  async findLatest(tx: Tx, identifier: string, purpose: OtpPurpose): Promise<StoredOtp | null> {
    const rows = await txOf(tx)
      .select({
        id: otpCodes.id,
        codeHash: otpCodes.codeHash,
        attemptCount: otpCodes.attemptCount,
        createdAt: otpCodes.createdAt,
        consumedAt: otpCodes.consumedAt,
      })
      .from(otpCodes)
      .where(and(eq(otpCodes.identifier, identifier), eq(otpCodes.purpose, purpose)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : { ...row, id: row.id.trim() };
  }

  async recordFailedAttempt(tx: Tx, id: string): Promise<void> {
    await txOf(tx)
      .update(otpCodes)
      .set({ attemptCount: sql`${otpCodes.attemptCount} + 1` })
      .where(eq(otpCodes.id, id));
  }

  async consume(tx: Tx, id: string): Promise<void> {
    await txOf(tx)
      .update(otpCodes)
      .set({ consumedAt: this.clock.now() })
      .where(eq(otpCodes.id, id));
  }
}
