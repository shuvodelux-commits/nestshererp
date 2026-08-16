import type { NewSession, SessionRepository, StoredSession, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull, ne } from 'drizzle-orm';

import { refreshTokens } from './schema';
import { txOf } from './unit-of-work';

/**
 * Not tenant-scoped: a refresh request arrives with no tenant context, and the
 * token is what reveals which tenant it belongs to. Only the hash is ever
 * stored or looked up — the raw token never reaches this layer.
 */
export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly clock: Clock) {}

  async create(tx: Tx, session: NewSession): Promise<void> {
    await txOf(tx).insert(refreshTokens).values({
      id: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      createdAt: this.clock.now(),
      createdBy: session.userId,
    });
  }

  async findByTokenHash(tx: Tx, tokenHash: string): Promise<StoredSession | null> {
    const rows = await txOf(tx)
      .select({
        id: refreshTokens.id,
        tenantId: refreshTokens.tenantId,
        userId: refreshTokens.userId,
        expiresAt: refreshTokens.expiresAt,
        revokedAt: refreshTokens.revokedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      ...row,
      id: row.id.trim(),
      tenantId: row.tenantId.trim(),
      userId: row.userId.trim(),
    };
  }

  /** Rotation is recorded, not erased — a replayed token stays detectable. */
  async revoke(tx: Tx, id: string, rotatedTo: string | null): Promise<void> {
    await txOf(tx)
      .update(refreshTokens)
      .set({ revokedAt: this.clock.now(), rotatedTo })
      .where(eq(refreshTokens.id, id));
  }

  async revokeAllForUser(
    tx: Tx,
    tenantId: string,
    userId: string,
    exceptSessionId: string | null,
  ): Promise<void> {
    await txOf(tx)
      .update(refreshTokens)
      .set({ revokedAt: this.clock.now() })
      .where(
        and(
          eq(refreshTokens.tenantId, tenantId),
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          // The device doing the changing keeps its session (§5.3: "all *other*
          // sessions"). A recovery reset passes null and spares nothing.
          ...(exceptSessionId === null ? [] : [ne(refreshTokens.id, exceptSessionId)]),
        ),
      );
  }
}
