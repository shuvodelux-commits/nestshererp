import { AppError, ErrorCode, Permission, RESET_CONFIRMATION_PHRASE } from '@sher/core-contracts';
import type { ResetResultResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';

import type { UserRepository } from '../auth/registration-repository';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { DatabaseDumpTool } from './backup-ports';
import type { BackupRepository } from './backup-repository';
import { assertStepUp } from './step-up';

/**
 * Emptying this installation so a backup can be restored into it (Phase 10,
 * owner decisions 2026-08-30).
 *
 * **The most destructive thing in SherERP, and deliberately the least
 * reachable.** It is not a menu entry: it lives at the foot of the Backup page,
 * where the person about to press it has just been shown the date of the last
 * good backup. It demands the permission, a fresh password, and the phrase
 * typed out in full.
 *
 * **Nothing is cleared until a PostgreSQL recovery dump has been created *and
 * verified*.** A dump that cannot be read back is not a safety net, and a reset
 * that proceeded on the strength of a zero exit code would be a reset with no
 * way back. If the dump cannot be verified, the reset does not happen — the
 * shop keeps its data and is told why.
 *
 * **What survives:** the business identity, its users, roles and permissions.
 * Reset empties the *books*, not the shop's account — somebody has to be able
 * to sign back in and perform the restore. A restore afterwards replaces the
 * identity too, which is that operation's business and not this one's.
 */

export interface ResetBusinessCommand {
  readonly ctx: TenantContext;
  readonly confirmPassword: string;
  readonly confirmPhrase: string;
}

export class ResetBusinessService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessControl,
    private readonly backups: BackupRepository,
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly dumps: DatabaseDumpTool,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async reset(command: ResetBusinessCommand): Promise<ResetResultResponse> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.access.require(tx, ctx, Permission.BUSINESS_RESET);
      await assertStepUp(tx, ctx, this.users, this.hasher, command.confirmPassword);

      // Checked before the dump, not after: taking a several-hundred-megabyte
      // dump of a database nobody meant to clear is a slow way of doing nothing.
      if (command.confirmPhrase.trim() !== RESET_CONFIRMATION_PHRASE) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Type ${RESET_CONFIRMATION_PHRASE} exactly, in capitals, to confirm.`,
        );
      }
    });

    /*
     * Outside the transaction on purpose. `pg_dump` opens its own connection
     * and would not see uncommitted work anyway, and holding a write
     * transaction open for the length of a full dump would block the shop for
     * as long as it takes.
     */
    const dump = await this.dumps.dumpAndVerify(`before-reset-${this.clock.now().toISOString()}`);

    const rowsCleared = await this.uow.run(ctx, async (tx) => {
      const cleared = await this.backups.clearBusinessKeepingIdentity(tx, ctx);
      await this.backups.reseedBaseline(tx, ctx);

      await this.audit.append(tx, ctx, {
        entityType: 'BUSINESS',
        entityId: ctx.tenantId,
        action: 'BUSINESS_RESET',
        before: { rows: cleared },
        after: null,
        reason: 'Reset business data',
        source: 'API',
      });

      return cleared;
    });

    return {
      recoveryDumpPath: dump.path,
      recoveryDumpBytes: dump.byteSize,
      rowsCleared,
    };
  }
}
