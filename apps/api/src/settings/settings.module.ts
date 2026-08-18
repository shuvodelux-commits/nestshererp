import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  BusinessProfileRepository,
  PasswordHasher,
  SettingsRepository,
  UnitOfWork,
  UserRepository,
} from '@sher/core-application';
import { ManageSettingsService } from '@sher/core-application';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  BUSINESS_PROFILE_REPOSITORY,
  PASSWORD_HASHER,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
  USER_REPOSITORY,
} from '../infrastructure/tokens';
import { SettingsController } from './settings.controller';
import { MANAGE_SETTINGS_SERVICE } from './tokens';

@Module({
  controllers: [SettingsController],
  providers: [
    {
      provide: MANAGE_SETTINGS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        settings: SettingsRepository,
        profiles: BusinessProfileRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        audit: AuditWriter,
      ): ManageSettingsService =>
        new ManageSettingsService(uow, accessControl, settings, profiles, users, hasher, audit),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        SETTINGS_REPOSITORY,
        BUSINESS_PROFILE_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        AUDIT_WRITER,
      ],
    },
  ],
})
export class SettingsModule {}
