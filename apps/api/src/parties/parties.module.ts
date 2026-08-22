import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  NumberingService,
  Outbox,
  PartyRepository,
  PeriodGuard,
  SettingsRepository,
  UnitOfWork,
} from '@sher/core-application';
import {
  ManagePartiesService,
  ManagePartyGroupsService,
  PartyLedgerService,
} from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  IDEMPOTENCY_STORE,
  NUMBERING_SERVICE,
  OUTBOX,
  PARTY_REPOSITORY,
  PERIOD_GUARD,
  SETTINGS_REPOSITORY,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { PartiesController } from './parties.controller';
import { PartyGroupsController } from './party-groups.controller';
import {
  MANAGE_PARTIES_SERVICE,
  MANAGE_PARTY_GROUPS_SERVICE,
  PARTY_LEDGER_SERVICE,
} from './tokens';

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
        numbering: NumberingService,
        periods: PeriodGuard,
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
          numbering,
          periods,
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
        NUMBERING_SERVICE,
        PERIOD_GUARD,
      ],
    },
    {
      provide: PARTY_LEDGER_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        parties: PartyRepository,
      ): PartyLedgerService => new PartyLedgerService(uow, accessControl, parties),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, PARTY_REPOSITORY],
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
  exports: [MANAGE_PARTIES_SERVICE],
})
export class PartiesModule {}
