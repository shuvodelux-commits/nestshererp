import { Module } from '@nestjs/common';
import type {
  AccessControl,
  ArchiveCodec,
  AuditWriter,
  BackupFileStore,
  BackupRepository,
  BackupSecretStore,
  BuildInfo,
  DatabaseDumpTool,
  EntitlementProvider,
  LicenseKeyStore,
  LicenseVerifier,
  PasswordHasher,
  UnitOfWork,
  UserRepository,
} from '@sher/core-application';
import {
  BackupService,
  LicenseInstallService,
  LicenseStatusService,
  ResetBusinessService,
  RestoreService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  ARCHIVE_CODEC,
  AUDIT_WRITER,
  BACKUP_FILE_STORE,
  BACKUP_REPOSITORY,
  BACKUP_SECRET_STORE,
  BACKUP_SERVICE,
  BUILD_INFO,
  CLOCK,
  DATABASE_DUMP_TOOL,
  ENTITLEMENT_PROVIDER,
  LICENSE_INSTALL_SERVICE,
  LICENSE_KEY_STORE,
  LICENSE_STATUS_SERVICE,
  LICENSE_VERIFIER,
  PASSWORD_HASHER,
  RESET_BUSINESS_SERVICE,
  RESTORE_SERVICE,
  UNIT_OF_WORK,
  USER_REPOSITORY,
} from '../infrastructure/tokens';
import { BackupController } from './backup.controller';
import { BackupScheduler } from './backup.scheduler';
import { LicenseController } from './license.controller';

/**
 * Phase 10 — backup, restore, reset and the licence (§5.25, §5.4, D-15, D-36).
 *
 * One module for both halves because they are one release requirement: a
 * licence that can lapse and a shop that can recover are the two things a
 * single-business installation lives or dies by, and they share the same
 * repository, the same build information and the same page in Settings.
 */
@Module({
  controllers: [BackupController, LicenseController],
  providers: [
    BackupScheduler,
    {
      provide: BACKUP_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        backups: BackupRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        codec: ArchiveCodec,
        files: BackupFileStore,
        secrets: BackupSecretStore,
        audit: AuditWriter,
        clock: Clock,
        build: BuildInfo,
      ): BackupService =>
        new BackupService(
          uow,
          access,
          backups,
          users,
          hasher,
          codec,
          files,
          secrets,
          audit,
          clock,
          build,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        BACKUP_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        ARCHIVE_CODEC,
        BACKUP_FILE_STORE,
        BACKUP_SECRET_STORE,
        AUDIT_WRITER,
        CLOCK,
        BUILD_INFO,
      ],
    },
    {
      provide: RESTORE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        backups: BackupRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        codec: ArchiveCodec,
        secrets: BackupSecretStore,
        audit: AuditWriter,
        clock: Clock,
      ): RestoreService =>
        new RestoreService(uow, access, backups, users, hasher, codec, secrets, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        BACKUP_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        ARCHIVE_CODEC,
        BACKUP_SECRET_STORE,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: RESET_BUSINESS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        backups: BackupRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        dumps: DatabaseDumpTool,
        audit: AuditWriter,
        clock: Clock,
      ): ResetBusinessService =>
        new ResetBusinessService(uow, access, backups, users, hasher, dumps, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        BACKUP_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        DATABASE_DUMP_TOOL,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: LICENSE_STATUS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        entitlements: EntitlementProvider,
        backups: BackupRepository,
        clock: Clock,
      ): LicenseStatusService =>
        new LicenseStatusService(uow, access, entitlements, backups, clock),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, ENTITLEMENT_PROVIDER, BACKUP_REPOSITORY, CLOCK],
    },
    {
      provide: LICENSE_INSTALL_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        access: AccessControl,
        verifier: LicenseVerifier,
        keys: LicenseKeyStore,
        entitlements: EntitlementProvider,
        audit: AuditWriter,
        clock: Clock,
      ): LicenseInstallService =>
        new LicenseInstallService(uow, access, verifier, keys, entitlements, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        LICENSE_VERIFIER,
        LICENSE_KEY_STORE,
        ENTITLEMENT_PROVIDER,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
  ],
  /*
   * Phase 17: the management agent installs a vendor-delivered licence and takes
   * a pre-update backup, and it does both through **these** services — the same
   * ones the paste box and the nightly job use. Exporting them is what lets
   * `ManagementModule` reuse the existing code path instead of growing a second
   * one, which is the whole of §4's "do not replace signed licence verification"
   * and §28's "reuse existing services rather than creating parallel logic".
   */
  exports: [LICENSE_INSTALL_SERVICE, LICENSE_STATUS_SERVICE, BACKUP_SERVICE],
})
export class BackupModule {}
