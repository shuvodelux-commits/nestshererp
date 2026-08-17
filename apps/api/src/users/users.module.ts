import { Module } from '@nestjs/common';
import type {
  AccessControl,
  AuditWriter,
  PasswordHasher,
  RoleRepository,
  SessionRepository,
  UnitOfWork,
  UserIdentifierRepository,
  UserRepository,
} from '@sher/core-application';
import { ManageRolesService, ManageUsersService } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';

import {
  ACCESS_CONTROL,
  AUDIT_WRITER,
  CLOCK,
  PASSWORD_HASHER,
  ROLE_REPOSITORY,
  SESSION_REPOSITORY,
  UNIT_OF_WORK,
  USER_IDENTIFIER_REPOSITORY,
  USER_REPOSITORY,
} from '../infrastructure/tokens';
import { RolesController } from './roles.controller';
import { MANAGE_ROLES_SERVICE, MANAGE_USERS_SERVICE } from './tokens';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController, RolesController],
  providers: [
    {
      provide: MANAGE_USERS_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        users: UserRepository,
        roles: RoleRepository,
        identifiers: UserIdentifierRepository,
        sessions: SessionRepository,
        hasher: PasswordHasher,
        audit: AuditWriter,
        clock: Clock,
      ): ManageUsersService =>
        new ManageUsersService(
          uow,
          accessControl,
          users,
          roles,
          identifiers,
          sessions,
          hasher,
          audit,
          clock,
        ),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        USER_REPOSITORY,
        ROLE_REPOSITORY,
        USER_IDENTIFIER_REPOSITORY,
        SESSION_REPOSITORY,
        PASSWORD_HASHER,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
    {
      provide: MANAGE_ROLES_SERVICE,
      useFactory: (
        uow: UnitOfWork,
        accessControl: AccessControl,
        roles: RoleRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        audit: AuditWriter,
        clock: Clock,
      ): ManageRolesService =>
        new ManageRolesService(uow, accessControl, roles, users, hasher, audit, clock),
      inject: [
        UNIT_OF_WORK,
        ACCESS_CONTROL,
        ROLE_REPOSITORY,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        AUDIT_WRITER,
        CLOCK,
      ],
    },
  ],
})
export class UsersModule {}
