import { AppError, ErrorCode } from '@sher/core-contracts';

import type { UserRepository } from '../auth/registration-repository';
import type { PasswordHasher } from '../ports/password-hasher';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * §5.3 step-up, shared by the three operations in this module that demand it:
 * exporting a backup, restoring one, and resetting the business.
 *
 * The same rule `ManageSettingsService` applies — the caller's **own** password,
 * checked now, and a PIN never satisfies it. Written once here rather than
 * three times, because a rule copied is a rule that drifts, and the copy that
 * drifts on a screen that can empty the database is the wrong copy to lose.
 */
export async function assertStepUp(
  tx: Tx,
  ctx: TenantContext,
  users: UserRepository,
  hasher: PasswordHasher,
  confirmPassword: string,
): Promise<void> {
  if (confirmPassword === '') throw stepUpFailed();

  const self = await users.findCredentials(tx, ctx, ctx.userId);
  if (self === null) throw stepUpFailed();
  if (self.passwordHash === null) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'Set a password in Settings → Security before doing this',
    );
  }
  if (!(await hasher.verify(confirmPassword, self.passwordHash))) throw stepUpFailed();
}

function stepUpFailed(): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'That password is not right. Try again.');
}
