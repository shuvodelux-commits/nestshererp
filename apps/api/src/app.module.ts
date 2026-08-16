import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { PersistenceModule } from './infrastructure/persistence.module';
import { NotesModule } from './notes/notes.module';

@Module({
  imports: [PersistenceModule, NotesModule],
  controllers: [HealthController],
})
export class AppModule {}
