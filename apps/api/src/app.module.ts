import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { PersistenceModule } from './infrastructure/persistence.module';
import { NotesModule } from './notes/notes.module';
import { RegistrationModule } from './registration/registration.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [PersistenceModule, NotesModule, RegistrationModule, UsersModule],
  controllers: [HealthController],
})
export class AppModule {}
