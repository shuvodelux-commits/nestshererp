import type { Tx } from '../ports/unit-of-work';

/**
 * Signed-in device sessions (§5.3): refresh tokens are rotating, revocable and
 * server-stored. Not tenant-scoped — a refresh arrives with no tenant context,
 * and the token itself is what reveals which tenant it belongs to.
 *
 * The repository only ever sees the **hash**. The raw token exists in the use
 * case that mints it and in the client that holds it, nowhere else.
 */
export interface StoredSession {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface NewSession {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface SessionRepository {
  create(tx: Tx, session: NewSession): Promise<void>;
  findByTokenHash(tx: Tx, tokenHash: string): Promise<StoredSession | null>;
  /** Rotation: revoke this row and record which row replaced it. */
  revoke(tx: Tx, id: string, rotatedTo: string | null): Promise<void>;
  /**
   * Every live session for one user — what a password change must invalidate
   * (§5.3). `exceptSessionId` spares the device doing the changing, because the
   * rule is "all **other** sessions"; a recovery reset passes null, since a
   * forgotten password means nobody can vouch for any device still holding one.
   */
  revokeAllForUser(
    tx: Tx,
    tenantId: string,
    userId: string,
    exceptSessionId: string | null,
  ): Promise<void>;
}
