import type { NewOtp, OtpRepository, StoredOtp, Tx } from '@sher/core-application';
import { SYSTEM_ACTOR_ID } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { otpCodes } from './schema';
import { txOf } from './unit-of-work';

const SIGNUP = 'SIGNUP';

/**
 * Not tenant-scoped: an OTP is verified before a tenant exists. Nothing here
 * decides whether a code is valid — expiry and attempt limits are domain rules
 * (R-B6); this reads and writes the row they are decided from.
 */
export class PostgresOtpRepository implements OtpRepository {
  constructor(private readonly clock: Clock) {}

  /** A new request kills the previous code — consuming it is what makes it dead. */
  async invalidateAll(tx: Tx, identifier: string): Promise<void> {
    await txOf(tx)
      .update(otpCodes)
      .set({ consumedAt: this.clock.now() })
      .where(
        and(
          eq(otpCodes.identifier, identifier),
          eq(otpCodes.purpose, SIGNUP),
          isNull(otpCodes.consumedAt),
        ),
      );
  }

  async insert(tx: Tx, otp: NewOtp): Promise<void> {
    await txOf(tx).insert(otpCodes).values({
      id: otp.id,
      identifier: otp.identifier,
      channel: otp.channel,
      purpose: SIGNUP,
      codeHash: otp.codeHash,
      attemptCount: 0,
      createdAt: this.clock.now(),
      // Nobody is signed in when a signup code is issued.
      createdBy: SYSTEM_ACTOR_ID,
    });
  }

  async findLatest(tx: Tx, identifier: string): Promise<StoredOtp | null> {
    const rows = await txOf(tx)
      .select({
        id: otpCodes.id,
        codeHash: otpCodes.codeHash,
        attemptCount: otpCodes.attemptCount,
        createdAt: otpCodes.createdAt,
        consumedAt: otpCodes.consumedAt,
      })
      .from(otpCodes)
      .where(and(eq(otpCodes.identifier, identifier), eq(otpCodes.purpose, SIGNUP)))
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
