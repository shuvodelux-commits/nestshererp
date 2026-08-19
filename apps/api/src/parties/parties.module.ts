import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  Outbox,
  PartyRepository,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import { ManagePartiesService, ManagePartyGroupsService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  IDEMPOTENCY_STORE,
  OUTBOX,
  PARTY_REPOSITORY,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { PartiesController } from './parties.controller';
import { PartyGroupsController } from './party-groups.controller';
import { MANAGE_PARTIES_SERVICE, MANAGE_PARTY_GROUPS_SERVICE } from './tokens';

@Module({
  controllers: [PartyGroupsController, PartiesController],
  providers: [
    {
      provide: MANAGE_PARTIES_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        parties: PartyRepository,
        settings: SettingsRepository,
        idempotency: IdempotencyStore,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): ManagePartiesService =>
        new ManagePartiesService(
          uow,
          accessControl,
          parties,
          settings,
          idempotency,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PARTY_REPOSITORY,
        SETTINGS_REPOSITORY,
        IDEMPOTENCY_STORE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: MANAGE_PARTY_GROUPS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        parties: PartyRepository,
        settings: SettingsRepository,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): ManagePartyGroupsService =>
        new ManagePartyGroupsService(uow, accessControl, parties, settings, audit, outbox, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        PARTY_REPOSITORY,
        SETTINGS_REPOSITORY,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
  ],
})
export class PartiesModule {}
