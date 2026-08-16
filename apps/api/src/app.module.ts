import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { PersistenceModule } from './infrastructure/persistence.module';
import { NotesModule } from './notes/notes.module';
import { RegistrationModule } from './registration/registration.module';

@Module({
  imports: [PersistenceModule, NotesModule, RegistrationModule],
  controllers: [HealthController],
})
export class AppModule {}
