import { Module } from '@nestjs/common';
import type { ManagementProfileRepository } from '@sher/core-application';
import { PostgresManagementProfileRepository } from '@sher/adapter-postgres';

import { BackupModule } from '../backup/backup.module';
import { ManagementController } from './management.controller';
import { ManagementStatusController } from './management-status.controller';
import { MANAGEMENT_PROFILE_REPOSITORY } from './tokens';

/**
 * Phase 17 — the ERP's side of the vendor management channel.
 *
 * It imports `BackupModule` for the two services the agent is allowed to call
 * and adds one repository of its own. **That is the entire surface**: a shop's
 * installation gains six endpoints that require a shared token, one that tells
 * its own users whether the vendor is currently inside, and nothing else. No
 * new permission, no new business table, no new write path into the books.
 *
 * The module is always registered but is inert without `MANAGEMENT_TOKEN` —
 * an install sold without remote management answers 404 on every route here,
 * which is simply true of that deployment (D-34's reasoning, reused).
 */
@Module({
  imports: [BackupModule],
  controllers: [ManagementController, ManagementStatusController],
  providers: [
    {
      provide: MANAGEMENT_PROFILE_REPOSITORY,
      useFactory: (): ManagementProfileRepository => new PostgresManagementProfileRepository(),
    },
  ],
})
export class ManagementModule {}
