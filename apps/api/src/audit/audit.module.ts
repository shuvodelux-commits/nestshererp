import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditQueryRepository,
  AuditWriter,
  UnitOfWork,
} from '@sher/core-application';
import { ListAuditEventsService, RecordPermissionDenialService } from '@sher/core-application';

import {
  ACCESS_CONTROL,
  AUDIT_QUERY_REPOSITORY,
  AUDIT_WRITER,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { AuditController } from './audit.controller';
import { LIST_AUDIT_EVENTS_SERVICE, RECORD_PERMISSION_DENIAL_SERVICE } from './tokens';

/**
 * `RecordPermissionDenialService` is exported because the global denial
 * interceptor needs it, and that interceptor is not scoped to this module — a
 * refusal can come from any controller.
 */
@Module({
  controllers: [AuditController],
  providers: [
    {
      provide: LIST_AUDIT_EVENTS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        events: AuditQueryRepository,
      ): ListAuditEventsService => new ListAuditEventsService(uow, accessControl, events),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, AUDIT_QUERY_REPOSITORY],
    },
    {
      provide: RECORD_PERMISSION_DENIAL_SERVICE,
      useFactory: (uow: UnitOfWork, audit: AuditWriter): RecordPermissionDenialService =>
        new RecordPermissionDenialService(uow, audit),
      inject: [UNIT_OF_WORK, AUDIT_WRITER],
    },
  ],
  exports: [RECORD_PERMISSION_DENIAL_SERVICE],
})
export class AuditModule {}
