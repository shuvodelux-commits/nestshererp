import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  IdempotencyStore,
  NoteRepository,
  NumberingService,
  Outbox,
  PeriodGuard,
  UnitOfWork,
} from '@sher/core-application';
import { CreateNoteService, GetNoteService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  IDEMPOTENCY_STORE,
  NOTE_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PERIOD_GUARD,
  UNIT_OF_WORK,
} from '../infrastructure/tokens';
import { NotesController } from './notes.controller';
import { CREATE_NOTE_SERVICE, GET_NOTE_SERVICE } from './tokens';

@Module({
  controllers: [NotesController],
  providers: [
    {
      provide: CREATE_NOTE_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        idempotency: IdempotencyStore,
        periodGuard: PeriodGuard,
        notes: NoteRepository,
        numbering: NumberingService,
        audit: AuditWriter,
        outbox: Outbox,
        clock: Clock,
      ): CreateNoteService =>
        new CreateNoteService(
          uow,
          accessControl,
          idempotency,
          periodGuard,
          notes,
          numbering,
          audit,
          outbox,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        IDEMPOTENCY_STORE,
        PERIOD_GUARD,
        NOTE_REPOSITORY,
        NUMBERING_SERVICE,
        AUDIT_WRITER,
        OUTBOX,
        CLOCK,
      ],
    },
    {
      provide: GET_NOTE_SERVICE,
      useFactory: (uow: UnitOfWork, accessControl: AccessControl, notes: NoteRepository): GetNoteService =>
        new GetNoteService(uow, accessControl, notes),
      inject: [UNIT_OF_WORK, ACCESS_CONTROL, NOTE_REPOSITORY],
    },
  ],
})
export class NotesModule {}
