import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { NoteResponse } from '@sher/core-contracts';

import type { AccessControl } from '../ports/access-control';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { NoteRepository } from './note-repository';

/**
 * Read side of the reference use case.
 *
 * A note belonging to another tenant is NOT_FOUND (404), never PERMISSION_DENIED
 * (403) — the repository is tenant-scoped, so it simply cannot see the row, and
 * the caller learns nothing about whether it exists (§5.26).
 */
export class GetNoteService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly notes: NoteRepository,
  ) {}

  async execute(ctx: TenantContext, id: string): Promise<NoteResponse> {
    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.NOTE_VIEW);

      const note = await this.notes.findById(tx, ctx, id);
      if (note === null) throw new AppError(ErrorCode.NOT_FOUND, 'Note not found');

      return {
        id: note.id,
        noteNumber: note.noteNumber,
        title: note.title,
        amountMinor: note.amountMinor,
        businessDate: note.businessDate,
        entryMode: note.entryMode,
        status: note.status,
      };
    });
  }
}
